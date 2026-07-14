# TASK 18 — media-client (capture, compress, metadata, queue, chunked upload drain)
**Status:** todo
**Depends on:** 03, 04, 22

## Goal
Deliver the entire client media pipeline of 06-media-pipeline: a platform-free media engine in `@bolusi/core` (`mediaRefSchema`, the `MediaItem.uploadStatus` machine per 03-state-machines §4, the sequential single-flight drain loop with server-authoritative chunk resume, backoff application per 03 §4.1, pruning-eligibility + failure-surfacing computation) plus the `apps/mobile` adapters: `MediaCapture` (expo-camera live capture only) and signature pad, the pinned compress/downscale passes, cache→document move, streamed SHA-256 hashing, `FileHandle`-based chunk reads, the fetch `MediaTransportPort` implementation of `init / PUT chunks / status / complete / download` per api/03-media, drain triggers, background-task registration, low-storage checks, and the remote media render-time cache with hash verification. Ships the `media_items` client migration (10-db §9.4) in `packages/db-client` and the lint rules 06 mandates (banned `expo-image-picker` / legacy upload imports; no-UPDATE on immutable media columns). Ops referencing media stay fully sync-independent (FR-1138): nothing here touches or blocks the op sync path. No server code (task 19), no sync-status screen UI (task 24), no full harness scenario (task 26) — this task ships the engine, adapters, and their client-level tests.

## Docs to read
- `06-media-pipeline.md` — ALL sections (this task implements the whole doc).
- `api/03-media.md` — §3 (endpoints + client behavior notes), §4 (chunk size, server-dictated), §5 (integrity/immutability summary), §8 (error table — the "Client behavior" column drives the drain loop's per-code handling).
- `03-state-machines.md` — §4 + §4.1 (canonical `uploadStatus` machine, backoff numbers, invalid transitions, crash recovery).
- `10-db-schema.md` — §9.4 (exact `media_items` DDL + index; "pruned" is derived, never stored).

## Skills
- `superpowers:test-driven-development` — always.
- `superpowers:verification-before-completion` — run the suites and lint before claiming done.
- `frontend-design:frontend-design` — for the `MediaCapture` / signature-pad components (all user-visible strings via the label catalog; no hardcoded strings).
- Worktree isolation per CLAUDE.md §2.3 — first step: `git branch --show-current`; STOP if on main.

## Files / modules touched
- `packages/core/src/media/` — **CONTENDED (`@bolusi/core`)**: `mediaRefSchema` (Zod `.strict()`, defined once — 06 §3.2), `MediaItem` state machine + `INVALID_TRANSITION` guards, drain loop (single-flight, ordered `capturedAt asc`, sequential chunks), `MediaTransportPort` interface, backoff application via `nextAttemptAt`, pruning eligibility + orphan rule, persistent-failure computation, `pendingMediaCount` derived query, download-verify logic. Serialize with any other in-flight core task per CLAUDE.md §4 / `_index.md` note.
- `packages/core/test/media/` — unit tests + protocol-faithful in-memory fake server (api/03 §3 semantics: idempotent init, `receivedChunks`, `CHUNKS_MISSING`, `HASH_MISMATCH` chunk purge, `MEDIA_IMMUTABLE`).
- `packages/core/test/jcs-vectors/` — add a `mediaRef`-bearing payload vector (06 §10 last checkbox).
- `packages/db-client/migrations/` — `media_items` table + partial index, byte-for-byte per 10-db §9.4. DB migrations serialize globally (CLAUDE.md §4).
- `apps/mobile/src/media/` — `MediaCapture` component (expo-camera `CameraView`), signature pad, photo pipeline steps 1–8 (06 §2.2, pinned params), signature pipeline (06 §2.3), streamed hashing (quick-crypto + `FileHandle` 256 KiB reads), fetch `MediaTransportPort` adapter, chunk reader (`File.open()` → `offset`/`readBytes`), drain trigger wiring (06 §5.2), `expo-background-task` bounded pass (06 §5.4), pruning pass + disk-space thresholds (06 §7), remote cache dir fetch/verify (06 §6).
- `tooling/` ESLint config (per 08-stack-and-repo lint table): ban `expo-image-picker` repo-wide (06 §2.1), ban legacy `expo-file-system` upload APIs (`uploadAsync`, `createUploadTask` — 06 §5.5), no-UPDATE rule on immutable `media_items` columns (`captured_at`, `location`, `captured_by_user_id`, `device_id`, `type`, `mime_type`, `byte_size`, `sha256` — 06 §4; same mechanism class as the operations no-UPDATE rule).
- `packages/i18n` catalog — label keys for storage banners, capture-refused dialog, and every api/03 §8 `lastErrorCode` surfaced per 06 §8 (keys only; screens land in task 24).

## Acceptance
Observable done-condition: `pnpm -F @bolusi/core test`, `pnpm -F @bolusi/db-client test` (migration applies), mobile unit tests, and `pnpm lint` all green in CI; the fake-server drain suite completes a multi-chunk upload end-to-end.

**State machine (03 §4) — exhaustive:**
- Valid walk: `pending → uploading → uploaded`; `uploading → failed → uploading → uploaded`; `uploading → uploading` self-loop on chunk success. `uploadAttempts` cleared on `uploaded`; `uploadedAt` set only on server `complete` success.
- Invalid transitions each throw `INVALID_TRANSITION`: `uploaded → *` (terminal, incl. re-enqueue attempts), `pending → uploaded`, `failed → uploaded`.
- Crash recovery: item persisted as `uploading` with no live upload task → startup reconciliation resets to `pending`; next drain re-fetches `receivedChunks` (resume, never restart — assert no chunk the fake server already holds is re-sent).
- Pruning an `uploaded` item does NOT change `uploadStatus`; only `localPath → null`.

**Resume from server truth (local progress lies, server wins):** fixture where local display-progress claims chunks 0–3 sent but fake-server `status` returns `receivedChunks: [0,1]` → drain sends exactly {2,3} then `complete`; inverse fixture (server has more than local believes) sends only the true missing set. Local progress is never persisted as resume input.

**Immutability client-side (attach-then-replace rejected):**
- After `attachedToOperationId` is set: no exported API mutates file bytes, metadata columns, or `sha256`; a forced repository-level attempt throws; `attachedToOperationId` itself is write-once (second set throws).
- Lint rule test fixture: an `UPDATE media_items SET captured_at…` (and each immutable column) fails lint.
- `409 MEDIA_IMMUTABLE` on init/PUT: own `sha256` equals server's → item marked `uploaded` (treat as success); differing → `LOCAL_CORRUPT`-class surfacing, no overwrite, no retry (api/03 §8 row).

**Drain loop error handling (api/03 §8 client-behavior column, per code):**
- Backoff exactly `5 s → 15 s → 60 s → 5 min` cap indexed by `uploadAttempts` (03 §4.1); connectivity-regained clears `nextAttemptAt` on all `failed` items but retains `uploadAttempts`; `uploadAttempts ≥ 5` sets the persistent-failure flag while retries continue at cap.
- `HASH_MISMATCH` → re-hash local file: match ⇒ retry from chunk 0 under normal backoff; mismatch ⇒ `lastErrorCode='LOCAL_CORRUPT'`, exempt from auto-retry, surfaced.
- `LOCAL_CORRUPT`, `DEVICE_REVOKED`, `INIT_MISMATCH`, `MIME_MISMATCH` → no auto-retry, individually flagged; `DEVICE_REVOKED`/auth 401s halt the whole drain; `CHUNKS_MISSING` → upload listed chunks, retry `complete`; `RATE_LIMITED`/`STORAGE_ERROR` → retryable under backoff.
- Single-flight: triggers during a run coalesce into exactly one re-run; items processed oldest-`capturedAt` first; only `attachedToOperationId != null` items are selected (orphans never upload).

**Capture pipeline:**
- 12 MP fixture → ≤ 1600 px long edge and ≤ 300 KiB within ≤ 2 passes (pass-2 params 1280 px / 0.5); never upscales; hash computed over final bytes and never re-touched.
- Cache→document move precedes `MediaItem` insert (simulated crash between capture and move leaves no row).
- Capture refused with explicit error dialog below 50 MB free; warning/loud thresholds at 500/200 MB trigger the pinned behaviors (06 §7).

**Pruning eligibility rule test:** uploaded + 7 d → file deleted, row kept with `localPath = null`; orphan (`attachedToOperationId` null) + 24 h → row AND file deleted; `pending`/`uploading`/`failed` items survive every storage-pressure level including < 200 MB; < 200 MB drops uploaded-retention to 0 and evicts the remote cache fully; remote cache evicted oldest-first.

**Download side (06 §6):** render-time fetch to cache dir, verified against `mediaRef.sha256` before display; mismatch ⇒ discard + refetch once, then surface; never prefetched by any sync-loop code path.

**Sync independence (FR-1138, client half):** drain-loop selection reads only `media_items`; `pendingMediaCount` matches the canonical formula (06 §4) including the orphan exclusion; no import path from the media engine into op-sync internals (assert via lint boundary or unit test). Full op-syncs-while-media-pending e2e lands with tasks 25/26.

**CHAOS-09 client half (testing-guide "media upload interruption at every chunk boundary"; the brief's "CHAOS-10" label maps to this scenario):** fixture of `4 × chunkSize + 3` bytes, PRNG-filled; interrupt at every chunk boundary and once mid-chunk (truncated body) against the fake server, resume via the real drain loop each time → final assembled hash equals capture hash, no already-received chunk re-sent, truncated chunk rejected and re-sent cleanly, `uploadStatus` walks only `pending → uploading → (failed → uploading)* → uploaded`. The full harness run (real server, fault points F1–F3) is task 26; the fixture and assertions built here must be reusable by it.

**SEC coverage note:** SEC-MEDIA-01…06 are server-endpoint adversarial tests — they ship with task 19, not here. This task ships the client-side security-checklist behaviors those tests assume: cache→document move (tested above), download hash verification (tested above), banned-import lint rules (tested above), and the `MEDIA_IMMUTABLE`-treat-as-success rule. No SEC-* id may be marked done by this task.

**Lint/CI gates:** the three new lint rules active and covered by fixture tests; `bolusi/no-hardcoded-strings` clean on new mobile components; no `Content-Encoding: gzip` on chunk PUTs (adapter test asserts raw `application/octet-stream`); `mediaRef` Zod round-trip + RFC 8785 vector added to `packages/core/test/jcs-vectors/` and green on the Node run (Hermes run lands with task 27's device gates); migration applies cleanly on a fresh DB in CI.
