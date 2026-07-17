# API 03 — Media Upload & Download

> **Owns:** the media wire protocol — chunked resumable upload endpoints, chunk size, server-side chunk storage and assembly, integrity verification, immutability enforcement, download, and this surface's error codes. The client pipeline (capture, compression, queue, drain loop, pruning) lives in `06-media-pipeline.md`; transport conventions (error envelope, auth header) in `api/00-conventions.md`; DDL for `media` / `media_chunks` in `10-db-schema.md`.
> **Change control:** change this doc first, then the code. Wire changes are versioned via the `/v1/` path prefix.

## 1. Principles

- **Hand-rolled chunked resumable upload.** No Expo-native resumable upload exists (SDK 57, research-verified), so the protocol is ours: `init → PUT chunks → status → complete`. Simple, stateless-per-request, resumable at chunk granularity (FR-1139).
- **Media transfer is not sync** (api/01-sync §8). Ops referencing a `mediaId` are accepted whether or not that media has been uploaded; the server never cross-validates a push against `media` rows (FR-1138).
- **Media is immutable.** A completed media id can never be re-initialized, re-chunked, or replaced (FR-819, FR-1143). Corrections are a new media id on a new operation.
- This is a **security surface** (upload/download, access control): built against the security checklist with adversarial tests shipped **before** review (CLAUDE.md §2.5). Required tests in §9.

## 2. Auth & scope

- Every endpoint requires the **device token** as `Authorization: Bearer <token>` (`hono/bearer-auth` with `verifyToken`; issuance in `api/02-auth.md`). Same rule as sync (api/01-sync §2): the token authenticates the device; revoked device ⇒ `401` `DEVICE_REVOKED`.
- Tenant scoping is double-layered per the stack pin: every handler queries only through `forTenant(tenantId)`, and Postgres RLS (`USING (tenant_id = current_setting('app.tenant_id')::uuid)`) backs it, with transaction-local `set_config('app.tenant_id', $1, true)` at the top of every request transaction. Session-level `SET` is forbidden (pooled connections leak).
- Each media row carries `tenant_id` (from the device) and `store_id` (the device's store at init; **nullable** — null for store-less devices; the `10-db-schema.md` DDL mirrors this nullability). **Download scope = the sync pull rule** (api/01-sync §4.1): a device may fetch media where `tenant_id = device.tenantId` AND (`store_id = device.storeId` OR `store_id IS NULL`). Out-of-scope and nonexistent are indistinguishable: both are `404` — existence must not leak across tenants or stores. This is the **documented exception** to FR-1036's 403-over-empty-result rule: id-keyed resource probes must not become an existence oracle; security-guide §2.2 records the exception and SEC-MEDIA-03 asserts the `404`.
- Upload scope: a device may `init`/`PUT`/`complete` only media whose row it created (`uploader_device_id = device.id`). Another device touching an in-flight upload ⇒ `404`.

## 3. Endpoints

All ids in paths are UUIDv7 strings, validated with `zValidator('param', …)`. JSON bodies are small and sent **plain** (no gzip); chunk bodies are raw bytes (§3.2).

### 3.1 `POST /v1/media/:id/init`

```
{ "sizeBytes": 231044, "sha256": "<64 hex>", "mime": "image/jpeg",
  "type": "image" | "signature" | "video",
  "metadata": { "capturedAt": <ms epoch>, "location": {lat,lng,accuracyMeters} | null,
                "userId": "<uuid>", "deviceId": "<uuid>" } }
→ 200 { "chunkSize": 262144, "totalChunks": <ceil(sizeBytes/262144)>,
        "receivedChunks": [<int>...], "status": "receiving" | "complete" }
```

- Creates the `media` row (status `receiving`) and pins size, hash, mime, type, and metadata. **Metadata is written once here and has no update path** (FR-817); the authoritative copy remains the signed op's `mediaRef` (06-media-pipeline §3.1) — the server stores init metadata as claimed and does not reconcile it against later-arriving ops in v0.
- **Idempotent by media id:** re-init with a byte-identical body returns `200` with current `receivedChunks` (this is also the crash-resume path). Re-init with any differing field for an existing `receiving` id ⇒ `409 INIT_MISMATCH`. Re-init of a `complete` id ⇒ `409 MEDIA_IMMUTABLE`, always.
- Validation: `mime` ∈ {`image/jpeg`, `image/png`} (v0; `video/mp4` reserved) else `422 MIME_UNSUPPORTED`; `sizeBytes` ≥ 1 and ≤ **10 MiB** (10,485,760 — v0 cap, headroom over the ≤ 300 KiB photos of 06-media-pipeline §2.2; raised here when v1 adds video) else `413 MEDIA_TOO_LARGE`; `metadata.userId` must be an enrolled user of the tenant, `metadata.deviceId` an enrolled device, else `422 VALIDATION_FAILED`.

### 3.2 `PUT /v1/media/:id/chunks/:index`

```
Content-Type: application/octet-stream        // raw bytes, NEVER gzip
body = file bytes [index*262144, min((index+1)*262144, sizeBytes))
→ 200 { "receivedChunks": [<int>...] }
```

- `index` is 0-based. Size check is exact: every chunk must be exactly `chunkSize` bytes except the last (`sizeBytes − (totalChunks−1)*chunkSize`); anything else ⇒ `422 CHUNK_SIZE_INVALID`. `index` outside `[0, totalChunks)` ⇒ `422 CHUNK_INDEX_INVALID`.
- **Idempotent:** re-PUT of an already-received index overwrites the stored bytes and returns `200` (final integrity rests on the whole-file hash, §5). Chunks may arrive in any order and (protocol-wise) in parallel; the v0 client sends sequentially (06-media-pipeline §5.1).
- Chunks against a `complete` media ⇒ `409 MEDIA_IMMUTABLE`. Unknown id (no init) ⇒ `404 MEDIA_NOT_FOUND`.
- Handler streams `c.req.raw.body` (a web `ReadableStream` on @hono/node-server 2.0.8) — no whole-body buffering beyond the chunk itself.

### 3.3 `GET /v1/media/:id/status`

```
→ 200 { "status": "receiving" | "complete", "sizeBytes": n, "chunkSize": 262144,
        "totalChunks": n, "receivedChunks": [<int>... ascending] }
```

Ground truth for resume (06-media-pipeline §5.1 step 2). The server's chunk inventory, not client bookkeeping, decides what is re-sent. (`receiving`/`complete` are wire states; the canonical client machine `pending → uploading → uploaded | failed` is owned by 03-state-machines and maps client-side.)

### 3.4 `POST /v1/media/:id/complete`

```
(empty body)
→ 200 { "status": "complete" }
```

Server steps, in one transaction plus a blob write:

1. All `totalChunks` present? Else `422 CHUNKS_MISSING` (body includes `missingChunks: [...]`).
2. Assemble chunks in index order, streaming SHA-256 over the assembled bytes.
3. Hash ≠ init `sha256` ⇒ `422 HASH_MISMATCH`, and the server **deletes all stored chunks** (a corrupt transfer's chunks are worthless; client restarts from chunk 0 — or detects local corruption, 06-media-pipeline §5.1).
4. **Magic-byte mime check:** the assembled file's leading bytes must match the declared `mime` — `image/jpeg` ⇒ `FF D8 FF`, `image/png` ⇒ `89 50 4E 47 0D 0A 1A 0A` (the full v0 allowlist, §3.1). Mismatch ⇒ `422 MIME_MISMATCH`, all stored chunks deleted, blob store untouched (SEC-MEDIA-05).
5. Hash and magic bytes both pass ⇒ write assembled file to the blob store (§6), mark row `complete`, delete `media_chunks` rows.
6. Crash-safety: the row is marked `complete` only after the blob write succeeds; a crash between blob write and commit leaves status `receiving` with chunks intact — the client's retried `complete` re-runs assembly idempotently (blob `put` overwrites the same key with identical bytes).

**Idempotent:** `complete` on an already-`complete` id ⇒ `200` (client retries after network loss must converge).

### 3.5 `GET /v1/media/:id` (download)

- Scope per §2. Only `complete` media is downloadable; a `receiving` id ⇒ `404 MEDIA_NOT_FOUND` (indistinguishable from absent — an unfinished upload is not yet evidence).
- Response: raw bytes, `Content-Type` = stored mime, `Content-Length`, `ETag: "<sha256>"`, `Cache-Control: private, max-age=31536000, immutable` (media never changes — §5). `If-None-Match` ⇒ `304`. Range requests are **not** supported in v0 (photos are ≤ 300 KiB); v1 video adds them.
- The `ETag: "<sha256>"` + `If-None-Match ⇒ 304` pair is **not only** a caching affordance: because the `ETag` **is** the server's stored `sha256`, it is also the hash-comparison path §8's `MEDIA_IMMUTABLE` recovery uses (task 18's `matchesServerHash`). A `304` proves the server holds our exact bytes with **no body crossing the wire**; a `200` proves it holds different bytes. This is the only place the server's hash reaches the client (see §8's open-owner note on the field-route alternative).
- The client verifies downloaded bytes against the signed `mediaRef.sha256` (06-media-pipeline §6) — trust, but verify, same doctrine as pull-side signature checks (api/01-sync §4).

## 4. Chunk size — 256 KiB, pinned

`chunkSize = 262144` bytes, server-dictated in the `init` response (clients must use the returned value, enabling future retuning without a client release).

Justification for the 3G target: at a typical 3G uplink of ~384 kbps (≈ 48 KB/s effective), one chunk transfers in ~5–6 s — so a dropped connection loses at most ~6 s of progress (FR-1139), while per-request overhead (TLS + headers + 300–800 ms RTT) stays under ~15% of transfer time. Halving to 64 KiB quadruples request-count overhead for nothing; 1 MiB chunks make a mid-chunk drop cost 20 s+ of re-upload. A typical 300 KiB photo is 2 chunks; a signature is 1.

## 5. Integrity & immutability (normative summary)

| Rule | Enforcement |
| ---- | ----------- |
| Per-chunk size exact-match | §3.2; `bodyLimit` backstop (§7) |
| Whole-file SHA-256 verified before `complete` | §3.4 — nothing enters the blob store unverified |
| Declared mime matches file magic bytes | §3.4 — checked at `complete`, before the blob write (jpeg/png only in v0) |
| Completed media can never be replaced | `complete` rows reject `init`/`PUT` with `409 MEDIA_IMMUTABLE`; there is no delete or overwrite endpoint; blob keys are written once |
| Metadata immutable after init | no update path exists (§3.1); lint rule bans `UPDATE` on metadata columns, same class as 05-operation-log §1 |
| File ↔ metadata binding | the signed op's `mediaRef.sha256` (06-media-pipeline §3) — server hash check guarantees the stored bytes match what was signed |
| Cross-tenant/store isolation | forTenant + RLS (§2); out-of-scope reads are `404` |

Per-chunk hashes are deliberately **not** part of the protocol: TLS covers transit integrity, the final whole-file hash covers end-to-end integrity, and the failure mode (restart file) is acceptable at ≤ 10 MiB.

## 6. Server storage

- **During upload:** chunks land in the `media_chunks` table — `media_id`, `chunk_index`, `byte_size`, `bytes bytea`, unique on `(media_id, chunk_index)`, and **no per-chunk hash column** (§5). This shape is the protocol truth; the `10-db-schema.md` DDL mirrors it exactly. Postgres-resident chunks keep partial uploads transactional, RLS-scoped, and trivially resumable; rows are deleted at `complete` (§3.4), so the table only ever holds in-flight uploads (bounded by 10 MiB × concurrent uploads).
- **After assembly:** the file is written through a `BlobStore` interface — `put(key, stream)`, `getStream(key)`, `exists(key)`, `delete(key)` — with S3-compatible key/semantics discipline (write-once keys, no partial writes visible). **v0 implementation: server-local disk** (`LocalDiskBlobStore`, root from env `MEDIA_STORAGE_DIR`), key = `t/{tenantId}/m/{mediaId}`. MinIO/S3 is a v1 drop-in behind the same interface (roadmap.md); nothing above the interface may assume local paths.
- v0 has **no server-side deletion or retention policy** — media is evidence and keeps forever; retention/archival policy is v1 (PRD-009 §7 tension: tracking retention vs transaction-record retention).

## 7. Middleware order (per route, normative)

| Route | Chain |
| ----- | ----- |
| `init` / `complete` / `status` | `bearerAuth(verifyToken)` → `bodyLimit(16 KiB)` → `zValidator('param')` [+ `zValidator('json')` on init] → handler in tenant transaction (`set_config` first) |
| `PUT chunk` | `bearerAuth(verifyToken)` → `bodyLimit(262144)` (streaming byte count — works without Content-Length) → `zValidator('param')` → streaming handler in tenant transaction |
| `GET media` | `bearerAuth(verifyToken)` → `zValidator('param')` → scoped read + blob stream |

The sync stack's gzip-decompression middleware (api/01-sync; stack pin) is **not mounted** on media routes: chunk bodies must never carry `Content-Encoding: gzip` (already-compressed JPEG/PNG; and a decompression stage on a byte-exact protocol is pure attack surface). A chunk PUT bearing `Content-Encoding` ⇒ `415 UNSUPPORTED_ENCODING` (api/00-conventions §5.3/§7) — encoded bodies are rejected outright, nothing stored.

## 8. Error table

Errors use the standard envelope and transport vocabulary (`api/00-conventions.md` §6–§7). Rate limiting follows api/00 §11's posture and single `RATE_LIMITED` 429 code; the media-surface numbers are owned here: chunk `PUT` **600 / min / device**; all other media endpoints inherit the api/00 §11 default. Machine codes:

| HTTP | Code | Meaning | Client behavior (06-media-pipeline §5) |
| ---- | ---- | ------- | -------------------------------------- |
| 401 | `AUTH_TOKEN_MISSING` | No/unparseable `Authorization` header (api/00 §7) | Bug — report; halt drain |
| 401 | `AUTH_TOKEN_INVALID` | Unknown or expired device token (api/00 §7) | Re-auth flow per api/02-auth; halt drain |
| 401 | `DEVICE_REVOKED` | Device revoked | Halt drain; item flagged; re-enroll (mirrors 05-operation-log §8) |
| 404 | `MEDIA_NOT_FOUND` | Unknown id, out-of-scope, other device's in-flight upload, or not-yet-complete on download | Upload: re-run `init`. Download: retry later (op may precede media) |
| 409 | `MEDIA_IMMUTABLE` | `init`/`PUT` against a `complete` id | Compare own `sha256` to the server's via a conditional `GET /v1/media/:id` with `If-None-Match: "<sha256>"` (§3.5): `304` ⇒ bytes match, mark the item `uploaded` (treat as success); `200` ⇒ server holds different bytes ⇒ `LOCAL_CORRUPT`-class surfacing, never overwrite; any other response ⇒ cannot confirm ⇒ `LOCAL_CORRUPT`-class (fail closed). **The `409` alone carries no hash — the server renders `MEDIA_IMMUTABLE` with no `details` — so a match must NEVER be inferred from the code.** Shipped as `MediaTransportPort.matchesServerHash` (task 18) |
| 409 | `INIT_MISMATCH` | Re-init body differs from stored init | Bug or tamper; mark `failed`, surface, no auto-retry |
| 413 | `MEDIA_TOO_LARGE` | `sizeBytes` over cap (10 MiB) | Bug (client compression contract violated); surface |
| 413 | `CHUNK_TOO_LARGE` | Body exceeded `bodyLimit` | Bug; surface |
| 415 | `UNSUPPORTED_ENCODING` | `Content-Encoding` on a chunk PUT (§7; chunks are raw bytes) | Bug; surface |
| 422 | `MIME_UNSUPPORTED` | mime outside v0 allowlist | Bug/version skew; surface |
| 422 | `VALIDATION_FAILED` | Body fails Zod / unknown user/device in metadata (api/00 §7) | Bug; surface |
| 422 | `CHUNK_INDEX_INVALID` | index ∉ [0, totalChunks) | Bug; surface |
| 422 | `CHUNK_SIZE_INVALID` | Wrong byte count for index | Bug; surface |
| 422 | `CHUNKS_MISSING` | `complete` before all chunks (`missingChunks` listed) | Upload listed chunks, retry `complete` — normal resume path |
| 422 | `HASH_MISMATCH` | Assembled hash ≠ init hash; server chunks discarded | Re-hash local file: match ⇒ retry from chunk 0; mismatch ⇒ `LOCAL_CORRUPT` (no retry) |
| 422 | `MIME_MISMATCH` | Assembled file's magic bytes ≠ declared mime (§3.4); server chunks discarded, blob untouched | Bug or tamper; mark `failed`, surface, no auto-retry |
| 429 | `RATE_LIMITED` | Per-device limits (numbers above; posture in api/00 §11) | Backoff per drain policy |
| 500 | `STORAGE_ERROR` | Blob store write/read failure | Retryable with backoff |

Every non-retryable failure must be user-visible (06-media-pipeline §8) — silent loss of evidence is the worst outcome this protocol can produce.

> **`MEDIA_IMMUTABLE` hash-comparison mechanism (open owner decision).** The row above describes what **ships today** (task 18): the conditional-`GET` `ETag`/`If-None-Match` path (§3.5), chosen because it needed **no wire change**. No endpoint returns the server's `sha256` directly — not `init` (§3.1), `status` (§3.3), nor the `409` body. An alternative remains an **owner call, not decided here**: have `init`/`status` return the stored `sha256` outright (it is not a secret — the client signed it), collapsing the rule to a plain field comparison and dropping a round-trip from the resume path. That is a versioned-wire change (see "Change control") touching the server (task 19) and `zMediaStatusResponse`, so it must be ratified before the ETag route is retired.

## 9. Required adversarial tests (before review — CLAUDE.md §2.5)

- [ ] Cross-tenant: device A (tenant 1) init/PUT/status/complete/GET against tenant-2 media ⇒ `404` everywhere; RLS alone blocks it even with the `forTenant` layer deliberately bypassed in test
- [ ] Cross-store download denied (`404`) under the §2 scope rule; `store_id IS NULL` media visible tenant-wide
- [ ] Re-init after `complete` ⇒ `409 MEDIA_IMMUTABLE`; chunk PUT after `complete` ⇒ `409`; no code path mutates a `complete` row or its blob
- [ ] `init` mismatch (changed sizeBytes / sha256 / metadata) ⇒ `409 INIT_MISMATCH`
- [ ] Chunk fuzzing: index −1, `totalChunks`, 2^31; sizes ±1 byte; empty body ⇒ all rejected, nothing stored; body with `Content-Encoding: gzip` ⇒ `415 UNSUPPORTED_ENCODING`, nothing stored
- [ ] `complete` with missing chunks ⇒ `422 CHUNKS_MISSING` + accurate `missingChunks`
- [ ] Bit-flipped chunk ⇒ `HASH_MISMATCH`, chunks purged, blob store untouched
- [ ] Declared-mime/magic-byte mismatch (e.g. PNG bytes declared `image/jpeg`) ⇒ `422 MIME_MISMATCH` at `complete`, chunks purged, blob store untouched (SEC-MEDIA-05)
- [ ] Replay: full upload replayed end-to-end ⇒ all `200`s, byte-identical single blob, no duplicate rows
- [ ] Revoked device mid-upload ⇒ `401 DEVICE_REVOKED` on next request; chunks retained (re-enrollment story per api/02-auth)
- [ ] Oversize init (> 10 MiB) ⇒ `413`; concurrent PUTs of the same index ⇒ single consistent row
- [ ] Download of `receiving` media ⇒ `404`; `ETag`/`304` behavior; downloaded bytes hash-match init `sha256`

## 10. What this protocol is NOT

- Not op sync — no cursors, no serverSeq, no envelope; ops flow only through api/01-sync.
- Not a CDN or public URL scheme — every fetch is device-token-authed; no signed public URLs in v0.
- Not a general file store — only capture-pipeline media (06-media-pipeline §2) with pinned mime allowlist enters it.
