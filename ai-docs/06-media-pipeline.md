# 06 — Media Pipeline (client)

> **Owns:** the on-device media lifecycle — capture rules, compression parameters, metadata embedding, the local media queue, the upload drain loop, local storage management, pruning, and failure surfacing. The wire protocol (endpoints, chunking, server storage, integrity checks) lives in `api/03-media.md` and is never redefined here. Envelope facts live in `05-operation-log.md`; the `MediaItem.uploadStatus` machine is canonically owned by `03-state-machines.md`.
> **Change control:** change this doc first, then the code.

## 1. Scope & principles (v0)

| Principle | Source |
| --------- | ------ |
| Capture works fully offline; upload is background and never blocks the user | FR-1140, FR-1107 |
| Operations reference media by `id` and sync **independently** of the file — a note/ticket is usable before its media has uploaded | FR-1138 |
| Media is compressed **at capture** for 2GB-RAM devices and slow uplinks | FR-1141 |
| Metadata (capturedAt, location, userId, deviceId) is captured at the moment of capture and immutable thereafter | FR-816, FR-817, FR-1142 |
| A media reference, once attached to an operation, can never be replaced. Correction = new op + new media + reason | FR-819, FR-1143 |
| Upload is chunked and resumable; a dropped 3G connection never restarts a file | FR-1139 |
| Local media is prunable once safely uploaded; the device warns before storage fills | FR-1144, PRD-012 §6 |

**v0 media types:** `image` (JPEG photos) and `signature` (PNG). **`video` is deferred to v1** — the `type` enum, the wire protocol, and the `MediaItem` row reserve it, but v0 ships no video capture UI, no video compression path, and no video tests. Raising the size cap for video is a v1 change to `api/03-media.md`.

## 2. Capture rules

### 2.1 Live camera only

- Evidence media shall be capturable **only** through the in-app camera (`expo-camera` SDK 57 `CameraView` + `takePictureAsync`). Gallery selection shall not exist anywhere evidence is required (FR-818).
- Enforcement is structural, not per-screen: the shared `MediaCapture` component is the only capture surface, and **`expo-image-picker` is a banned import** (lint rule, same class as the no-`UPDATE`-on-`operations` rule in 05-operation-log §1). v0 has no non-evidence media surface, so the ban is repo-wide.
- Signatures are captured on an in-app signature pad component rendering to PNG — never imported, never photographed.

### 2.2 Photo pipeline (normative order)

| Step | Action | Pinned parameters |
| ---- | ------ | ----------------- |
| 1 | `takePictureAsync` | `{ quality: 0.7, exif: false, base64: false, skipProcessing: false }` — quality MUST be explicit (SDK 57 default is `1`, maximal JPEG); `skipProcessing: false` keeps the orientation fix |
| 2 | Read GPS fix | best available fix or `null`, never blocks capture (05-operation-log §2.1 `location` semantics; PRD-009 FR-802) |
| 3 | Downscale + recompress via `expo-image-manipulator` | pass 1: resize long edge to ≤ **1600 px** (downscale only, never upscale), JPEG `compress: 0.7` |
| 4 | Size check | if output > **300 KiB** (307,200 bytes): pass 2 — long edge ≤ **1280 px**, `compress: 0.5`; accept the pass-2 result unconditionally. Capture never fails on size. |
| 5 | Move file cache → document dir | `takePictureAsync`/manipulator output lands in the app **cache** directory, documented as temporary — move to `<documentDirectory>/media/<mediaId>.jpg` **immediately**, before anything else references the file |
| 6 | Hash | SHA-256 over the final file bytes via `react-native-quick-crypto` 1.1.6 sync `createHash('sha256')`, streamed with `expo-file-system` `FileHandle` `offset`/`readBytes` in 256 KiB reads. Never re-touch the bytes after hashing. |
| 7 | Insert `MediaItem` row (§4) | `uploadStatus = 'pending'`, `attachedToOperationId = null` |
| 8 | Return `mediaRef` (§3.2) to the calling command | the command embeds it in the op payload; the command runtime sets `attachedToOperationId` when the op is appended (04-module-contract §5.1 step 5) |

**Why 1600 px / ≤ 300 KiB:** repair evidence must keep cracked-glass detail and serial numbers legible — 1600 px long edge does; a 1600 px JPEG at q0.7 is typically 150–350 KiB, which a 2GB device decodes without memory pressure and a 3G uplink moves in seconds (2 chunks at the 256 KiB wire chunk size — `api/03-media.md §4`). Full-resolution camera output (8–12 MB) is wildly beyond every use case (FR-1141).

### 2.3 Signature pipeline

| Parameter | Pinned value |
| --------- | ------------ |
| Format | PNG (line art — JPEG ringing artifacts corrupt strokes) |
| Canvas | max 800 × 400 px, white background, black stroke |
| Expected size | < 64 KiB (single wire chunk) |
| Metadata, hashing, queueing | identical to §2.2 steps 2, 5–8 |

## 3. Metadata

### 3.1 Where metadata lives — DB rows + signed op payload, NOT EXIF

Immutable metadata (`capturedAt`, `location` with accuracy, `userId`, `deviceId`) is stored:

1. in the local `MediaItem` row (§4) at capture,
2. inside the **referencing operation's payload** as a `mediaRef` object (§3.2), and
3. server-side in the `media` row, written once at upload init (`api/03-media.md §3.1`), never updatable.

It is **never** written into the image file as EXIF. Rationale (this is a decision, not an omission):

- **EXIF provides zero integrity.** It is trivially editable by any tool; "embedded" EXIF is not evidence. The op payload is Ed25519-signed and hash-chained (05-operation-log §2–4) — the only tamper-evident place this system has.
- **The file bytes are bound to the signed metadata by `sha256`.** The `mediaRef` carries the file's SHA-256; the op signature covers it. Swapping the file breaks the hash; editing the metadata breaks the signature. This is strictly stronger than EXIF and satisfies FR-816/FR-817's intent ("embedded… immutable").
- **EXIF would not survive the pipeline.** `expo-image-manipulator` recompression does not reliably preserve EXIF, and PNG signatures have no EXIF at all. One mechanism for all types beats two half-mechanisms.

FR-816's word "embedded" is therefore satisfied by cryptographic binding, not byte-embedding. (Reported as interpretation, not deviation — see decisions log if contested.)

### 3.2 `mediaRef` — the shared payload fragment

Defined once in `@bolusi/core` as `mediaRefSchema` (Zod, `.strict()`); any module payload that attaches media embeds it. Never redefine per module (CLAUDE.md §2.8).

| Field | Type | Semantics |
| ----- | ---- | --------- |
| `mediaId` | UUIDv7 string | The `MediaItem.id`. Client-generated at capture. |
| `sha256` | hex string (64) | Hash of the final file bytes (§2.2 step 6). |
| `mime` | `"image/jpeg"` \| `"image/png"` | v1 adds `"video/mp4"`. |
| `type` | `"image"` \| `"signature"` (`"video"` reserved) | |
| `sizeBytes` | integer | Final file size. |
| `capturedAt` | integer | ms epoch, device clock at capture. |
| `location` | `{lat, lng, accuracyMeters}` \| null | Same shape/semantics as the op envelope field (05-operation-log §2.1). |
| `userId` | UUID string | Capturing user. |
| `deviceId` | UUID string | Capturing device. |

`userId`/`deviceId` duplicate the op envelope in v0 (capture and attach happen in one command), but the `mediaRef` must be self-describing: v1 flows may attach previously-captured media from a different session. All fields are integers/strings — no floats except `lat`/`lng`/`accuracyMeters` inside `location`, which follow the envelope's own definition.

## 4. Local queue — `MediaItem`

One row per captured media, in the client SQLite DB (op-sqlite 17.1.2, single shared connection, per stack pin). This table is the **canonical** MediaItem client contract: its field names — `uploadAttempts`, `nextAttemptAt`, `lastErrorCode`, `lastErrorMessage` — are the spellings that `01-domain-model.md §5.3` mirrors and that the `10-db-schema.md §9.4` column DDL realizes exactly:

| Field | Type | Semantics |
| ----- | ---- | --------- |
| `id` | UUIDv7 | Global media id; wire path key. |
| `tenantId`, `storeId` | UUIDv7, UUIDv7 \| null | Scope, frozen at capture from the device identity; `storeId` is null for store-less devices (api/03-media §2). |
| `type` / `mime` / `sizeBytes` / `sha256` | per §3.2 | Frozen at capture. |
| `localPath` | string \| null | Document-dir path; null after pruning (§7). |
| `capturedAt`, `location`, `userId`, `deviceId` | per §3.2 | Immutable — **no UPDATE path exists** for these columns (lint-enforced, same mechanism as 05-operation-log §1). |
| `attachedToOperationId` | UUIDv7 \| null | Set once when the referencing op is appended; never changed afterwards. |
| `uploadStatus` | `pending` → `uploading` → `uploaded` \| `failed` | Canonical machine in 03-state-machines: `failed` is retryable back to `uploading`; `uploaded` is terminal. |
| `chunkSize`, `chunksTotal` | integer \| null | Null until set from the init response (§5.1 step 1; api/03-media §3.1) — **server-dictated**; clients never assume a chunk size. |
| `uploadAttempts` | integer | Incremented per drain attempt that ends in error; reset on `uploaded`. |
| `nextAttemptAt` | ms epoch \| null | Backoff gate (§5.3). |
| `lastErrorCode`, `lastErrorMessage` | string \| null | From `api/03-media.md §8`; surfaced per §8. |
| `uploadedAt` | ms epoch \| null | Set on server `complete` success; pruning clock (§7). |

Invariants:

- **Ops sync independently of media** (FR-1138): the op sync loop (api/01-sync §6) never waits on, inspects, or is blocked by `MediaItem` state, and vice versa. The server accepts ops whose `mediaRef.mediaId` it has never seen.
- **Immutability at attach:** once `attachedToOperationId` is set, file bytes and metadata are frozen — there is no code path that rewrites them, and the signed op's `sha256` would expose any rewrite. Additional ops may reference the same `mediaId` read-only; `attachedToOperationId` records the first.
- **Orphans:** a `MediaItem` whose command was abandoned (`attachedToOperationId` still null) is deleted — row and file — **24 h** after `capturedAt`, by the pruning pass (§7).
- `pendingMediaCount` (a derived query, never stored — 01-domain-model §5.2; recomputed by the sync loop, api/01-sync §6) = count of rows with `attachedToOperationId != null` AND `uploadStatus IN ('pending','uploading','failed')`. Orphans do not count. This formula is canonical.

## 5. Upload drain loop

### 5.1 Foreground loop (primary driver)

```
drain:                                    // single-flight; triggers coalesce
  for item in MediaItems where attachedToOperationId != null
        and uploadStatus in ('pending','failed')
        and (nextAttemptAt is null or nextAttemptAt <= now)
        order by capturedAt asc:          // oldest evidence first
    set uploadStatus = 'uploading'
    1. POST init            (idempotent — api/03-media §3.1)
    2. GET  status          → receivedChunks (server is ground truth; local
                              progress is display-only)
    3. for each missing chunk index, ascending:
         FileHandle.offset = index * chunkSize   // chunkSize from the init
         readBytes; PUT chunk                    // response — server-dictated,
                                                 // api/03-media §4
    4. POST complete        → on success: uploadStatus='uploaded', uploadedAt=now
    on any error: uploadStatus='failed', uploadAttempts++, set nextAttemptAt (§5.3),
                  record lastErrorCode; continue with next item
```

- **Sequential: one media item at a time, one chunk at a time.** No parallel uploads — a 3G uplink is the bottleneck and parallelism only multiplies failure states on a 2GB device.
- Resume is at **chunk granularity**: an interruption loses at most one 256 KiB chunk in flight (FR-1139); step 2's `receivedChunks` makes resume server-authoritative, so a reinstalled or restored client resumes correctly.
- `HASH_MISMATCH` on complete: re-hash the local file. If it no longer matches `MediaItem.sha256`, the local copy is corrupt and **unrecoverable as evidence** (the signed op pinned the original hash) — mark `failed` with `lastErrorCode='LOCAL_CORRUPT'`, stop retrying it (exempt from §5.3 auto-retry), surface per §8; the correction path is a new capture + new op (FR-819). If it still matches, the server discarded its chunks (api/03-media §3.4) — retry from chunk 0 under normal backoff.

### 5.2 Triggers

Mirrors the sync-loop triggers (api/01-sync §5), evaluated independently: (a) connectivity regained, (b) debounced 3 s after any capture, (c) periodic every 60 s while online + foregrounded, (d) `expo-background-task` opportunistic (§5.4), (e) manual retry from the sync-status screen. Single-flight; a trigger during a run is coalesced into one immediate re-run.

### 5.3 Backoff

The per-item retry backoff schedule is owned by `03-state-machines.md §4.1` — the numbers live there and are never restated here. This doc owns only the application mechanics: the schedule is applied via `nextAttemptAt`, resets on that item's success and on connectivity-regained (per the owning schedule), and a network-level failure also backs off the whole drain loop on the same schedule.

### 5.4 Background task (opportunistic only)

`expo-background-task` (SDK 57; WorkManager-backed, **15-min floor, interval inexact, unreliable on aggressive OEM skins** — research-verified) registers a task that runs one bounded drain pass: **at most one media item or 60 s, whichever first**, then yields. It is a bonus, never a guarantee — no latency expectation may depend on it (same stance as api/01-sync §5(d)). A reliable-in-background upload (Android foreground service) is explicitly **not in v0**; revisit in v1 if field telemetry shows foreground draining insufficient (roadmap.md).

### 5.5 Chunk transfer rules (client side)

- Chunk body = raw bytes, `Content-Type: application/octet-stream`, **no `Content-Encoding: gzip`** — JPEG/PNG are already compressed; gzipping burns 2GB-device CPU for ~0% gain. (Contrast: sync POST bodies are gzipped per api/01-sync — that rule does not apply here.)
- Byte ranges are read with the SDK 57 `expo-file-system` `File.open()` → `FileHandle` (`offset` + `readBytes`) — the file is never loaded whole into memory. The legacy upload APIs (`uploadAsync`, `createUploadTask`) are **never used**: main-entry re-exports throw at runtime in SDK 57, and no Expo API offers resumable upload (research-verified).

## 6. Remote media cache (download side)

When rendering an op pulled from another device whose `mediaRef` has no local file, the client fetches `GET /v1/media/:id` (api/03-media §3.5) **on demand at render time** — never prefetched in the sync loop. Fetched files are stored in the **cache** directory (`<cacheDirectory>/media/`), verified against `mediaRef.sha256` before display (mismatch ⇒ discard + refetch once, then surface), and are always evictable — the OS or the pruning pass may drop them freely; they are re-fetchable. Only self-captured media lives in the document dir.

## 7. Storage management

Pruning pass runs on app start, after every successful drain pass, and at most once per hour.

| Rule | Pinned value |
| ---- | ------------ |
| Retention of uploaded media (resolves OQ-1105) | local file deleted **7 days** after `uploadedAt`; the `MediaItem` row is kept forever with `localPath = null` (the record is the index into server media; deleting rows would orphan `mediaRef`s) |
| Orphan capture cleanup | file + row deleted 24 h after `capturedAt` if never attached (§4) |
| Remote cache (§6) | evictable any time; evicted oldest-first when any threshold below trips |
| `pending`/`uploading`/`failed` media | **never pruned automatically**, regardless of storage pressure — it is un-uploaded evidence |

Sizing check: a busy store at ~100 photos/day × 300 KiB ≈ 30 MiB/day → ~210 MiB steady-state at 7-day retention. Fits a 32 GB device with wide margin (FR-1144).

**Low-storage thresholds** (free space via the `expo-file-system` disk-space API, checked at each pruning pass and before each capture):

| Free space | Behavior |
| ---------- | -------- |
| < 500 MB | Warning banner (label catalog, 07-i18n); immediate pruning pass |
| < 200 MB | Loud banner; uploaded-media retention window drops to 0 (prune all uploaded now); remote cache fully evicted |
| < 50 MB | Capture is **refused with an explicit error dialog** — never a silent camera failure (PRD-012 §6: silent camera death "will be discovered at the worst moment") |

## 8. Failure surfacing

- Silent failure is unacceptable (same doctrine as op rejection, 05-operation-log §8).
- Every `failed` item is visible in the sync-status screen with its `lastErrorCode` mapped to label-catalog copy.
- **Persistently failing** = `uploadAttempts ≥ 5`, or any attached item still not `uploaded` 24 h after `capturedAt` while the device has synced ops in that window. Persistently failing items escalate to a loud banner ("N photos have not reached the server") — a repair with no uploaded photos is a repair with no evidence (PRD-012 §6).
- `LOCAL_CORRUPT` (§5.1) and `DEVICE_REVOKED` (api/03-media §8) items stop auto-retrying and are flagged individually: the only remedies are re-capture + new op, or re-enrollment, respectively.
- All of this is offline-computable — surfacing never depends on the server.

## 9. Forward references (not v0)

| Item | Where it lands |
| ---- | -------------- |
| Video capture, compression, and its size-cap raise | v1 — roadmap.md |
| Android foreground-service upload for background reliability | v1 decision, telemetry-driven (§5.4) |
| Server-side media retention/archival policy (evidence follows transaction retention, PRD-009 §7) | v1 — roadmap.md; v0 server keeps everything |
| 6-angle intake photo defaults, attendance selfies, proof-of-delivery flows | owning business modules, v1+ (they consume this pipeline unchanged) |

## 10. Required tests (client; harness details in testing-guide)

- [ ] Capture fully offline → op append → op syncs while media still `pending` (FR-1138)
- [ ] Kill the app mid-chunk-3-of-N → relaunch → status shows chunks 1–2 → upload completes without resending them (FR-1139)
- [ ] Compression: 12 MP fixture lands ≤ 1600 px and ≤ 300 KiB after pass ≤ 2; hash computed after final bytes
- [ ] Cache→document move happens before `MediaItem` insert (crash between capture and move loses the photo cleanly, never a dangling row)
- [ ] Tampered local file (bit-flip after capture) → complete fails → `LOCAL_CORRUPT`, no retry loop, surfaced
- [ ] Pruning: uploaded+7d file removed, row kept; `pending` item survives < 200 MB pressure; capture refused < 50 MB with dialog
- [ ] Orphan capture removed after 24 h
- [ ] `mediaRef` Zod round-trip + RFC 8785 canonicalization of a payload containing `mediaRef` on Hermes (per stack pin, JCS vectors run in CI on Hermes)
