# TASK 19 — media-server (init/chunks/status/complete/download, assembly, magic bytes)

**Status:** done
**Depends on:** 05, 12

## Goal

Deliver the full media wire protocol of `api/03-media.md` as the `media` sub-router in `@bolusi/server` (`apps/server`): `POST /v1/media/:id/init` (idempotent by media id, mime allowlist, 10 MiB cap), `PUT /v1/media/:id/chunks/:index` (exact-size chunks, streaming `bodyLimit(262144)`, bytes into `media_chunks`), `GET /v1/media/:id/status`, `POST /v1/media/:id/complete` (whole-file SHA-256 verify, magic-byte MIME check, assemble into the blob store, purge chunks), and `GET /v1/media/:id` download (device-scoped; out-of-scope = nonexistent = `404`, the documented existence-oracle exception). Includes the `BlobStore` interface plus the v0 `LocalDiskBlobStore` (`MEDIA_STORAGE_DIR`, server-generated keys `t/{tenantId}/m/{mediaId}` — no client input in paths), the `409` immutability codes (`MEDIA_IMMUTABLE`, `INIT_MISMATCH`), uploader binding to the authenticated device, the per-route middleware chains of api/03 §7 (gzip middleware NOT mounted; `Content-Encoding` on chunk PUT ⇒ `415`), and the chunk-PUT rate-limit number (600/min/device). All handlers query only through `forTenant` inside a transaction-local `set_config` transaction (delivered by task 05); error envelope and rate-limit machinery come from task 12 — reuse, don't rebuild. This is a security surface: SEC-MEDIA-01..06 ship in this task, before review (CLAUDE.md §2.5). No client pipeline (task 18), no migrations (task 05 owns 10-db §8 DDL — verify present, do not add).

## Docs to read

- `ai-docs/api/03-media.md` — ALL sections (protocol, scope rules, endpoint semantics, chunk size, immutability table, storage, middleware order, error table, required adversarial tests).
- `ai-docs/10-db-schema.md` §8 — `media` + `media_chunks` DDL only (column names: uploader binding column is `device_id`; no per-chunk hash; `storage_key` NULL until complete).
- `ai-docs/security-guide.md` §7 — checklist §7.1 and the SEC-MEDIA-01..06 table §7.2 (normative test specs for this task).

## Skills

- `superpowers:test-driven-development` — always; SEC tests and the error-table matrix are written first.
- `superpowers:verification-before-completion` — run the suites and read their output before claiming done.
- Worktree isolation per CLAUDE.md §2.3 — first step: `git branch --show-current`; STOP if on main.

## Files / modules touched

- `apps/server/src/routes/media.ts` — the sub-router (new); chained into the composed app / `AppType`.
- `apps/server/src/media/blob-store.ts` — `BlobStore` interface (`put`/`getStream`/`exists`/`delete`) + `LocalDiskBlobStore` (new).
- `apps/server/src/media/assemble.ts` — index-ordered streaming assembly, SHA-256, jpeg/png magic-byte check (new).
- `apps/server/src/app.ts` (or router composition file from task 12) — mount `media` routes; keep gzip decompression middleware OFF them.
- `apps/server/.env.example` — add `MEDIA_STORAGE_DIR`.
- `apps/server/test/integration/media/*.test.ts` — integration + SEC suite (PGlite; re-run on real Postgres via `pnpm test:rls`).
- `packages/schemas/src/media.ts` — **CONTENDED (`@bolusi/schemas`)**: only if task 02 did not already ship the media DTOs (init body, init/status/chunk responses, media error codes). If touched, serialize per CLAUDE.md §4 — coordinate before starting.
- `packages/db-server` — NOT touched; `media`/`media_chunks` migrations are task 05's. If missing, stop and report, don't add them here.

## Acceptance

**Observable done-condition:** new media integration suite green in `pnpm test:server` (in-process Hono + PGlite) AND the identical suite green in `pnpm test:rls` (real Postgres — RLS semantics witnessed); `pnpm lint` and full CI pass.

**Endpoint tests (concrete):**

- `init`: byte-identical re-init ⇒ `200` with current `receivedChunks` (crash-resume path); re-init varying EACH field (sizeBytes, sha256, mime, type, metadata) against a `receiving` id ⇒ `409 INIT_MISMATCH`; re-init after `complete` ⇒ `409 MEDIA_IMMUTABLE`; mime outside {`image/jpeg`,`image/png`} ⇒ `422 MIME_UNSUPPORTED`; `sizeBytes` 0 and > 10,485,760 ⇒ `422`/`413 MEDIA_TOO_LARGE`; unknown `metadata.userId`/`deviceId` ⇒ `422 VALIDATION_FAILED`.
- `PUT chunk`: exact-size accepted for every index including uneven final chunk; ±1 byte ⇒ `422 CHUNK_SIZE_INVALID`, nothing stored; index −1 / `totalChunks` / 2^31 ⇒ `422 CHUNK_INDEX_INVALID`; empty body rejected; body over `bodyLimit(262144)` ⇒ `413 CHUNK_TOO_LARGE`; `Content-Encoding: gzip` ⇒ `415 UNSUPPORTED_ENCODING`, nothing stored; re-PUT same index ⇒ `200` overwrite (idempotent); concurrent PUTs of one index ⇒ single consistent row; PUT after `complete` ⇒ `409 MEDIA_IMMUTABLE`; un-init'd id ⇒ `404 MEDIA_NOT_FOUND`.
- `status`: returns server-authoritative ascending `receivedChunks`; drives a real resume in the integration flow below.
- `complete`: missing chunks ⇒ `422 CHUNKS_MISSING` with accurate `missingChunks`; assembled-hash mismatch ⇒ `422 HASH_MISMATCH`, ALL chunks purged, blob store untouched; magic-byte/declared-mime mismatch ⇒ `422 MIME_MISMATCH`, chunks purged, blob untouched; success ⇒ blob at `t/{tenantId}/m/{mediaId}`, row `complete` + `storage_key` set, `media_chunks` rows deleted; `complete` on already-`complete` ⇒ `200` (idempotent); crash-window simulation (blob written, row still `receiving`, chunks intact) ⇒ retried `complete` converges.
- `download`: `receiving` id ⇒ `404`; authz matrix — same tenant+store `200`; `store_id IS NULL` media visible tenant-wide `200`; same-tenant other-store ⇒ `404`; other tenant ⇒ `404`; nonexistent ⇒ `404`; all `404` legs byte-indistinguishable. Headers: `Content-Type`, `Content-Length`, `ETag:"<sha256>"`, immutable `Cache-Control`; `If-None-Match` ⇒ `304`; downloaded bytes hash-match init `sha256`.
- Uploader binding: a second device (valid token) hitting another device's in-flight id with `init`/`PUT`/`status`/`complete` ⇒ `404`; real upload's `receivedChunks` unpolluted.
- Integration flows: full upload → interrupt mid-file → `status` resume → `complete` → download round-trip; end-to-end replay of a finished upload ⇒ all `200`s, single byte-identical blob, no duplicate rows; revoked device mid-upload ⇒ `401 DEVICE_REVOKED`, chunks retained.
- Rate limit: chunk PUT beyond 600/min/device ⇒ `429 RATE_LIMITED`.

**Security tests (in THIS task, before review — CLAUDE.md §2.5):** SEC-MEDIA-01, SEC-MEDIA-02, SEC-MEDIA-03, SEC-MEDIA-04, SEC-MEDIA-05, SEC-MEDIA-06, each asserting exactly what security-guide §7.2 specifies — including the SEC-MEDIA-03 four-leg `404` probe, the SEC-MEDIA-04 fs assertion that blob files exist only under the server-generated storage root (path-traversal `:id`/`:index` never reach a filesystem path), and the api/03 §9 cross-tenant leg where RLS alone blocks access with the `forTenant` layer deliberately bypassed in test.

**CHAOS:** CHAOS-09 (upload interruption at every chunk boundary) targets this surface but runs in task 26's harness with the task-18 client; this task must leave its server-side preconditions test-proven here (server-authoritative resume, no duplicate chunk storage, truncated-chunk rejection). No CHAOS id ships in this task.

**Lint/CI gates:** eslint boundary rules clean (no `pg` import, tenant tables only via `forTenant`, no session-level `SET`); no-floating-promises in `apps/server`; suite wired into the existing `pnpm test:server` + `pnpm test:rls` CI stages (no new stage).
