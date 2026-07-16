# TASK 82 — the media pipeline's mobile half: capture, compression, drain triggers, pruning, and the remote cache

**Status:** todo
**Priority:** MEDIUM — blocks task 50's media wiring and any UI that captures evidence. Not urgent, but **it must be visible**: this is the half of task 18 that was deliberately not built.
**Depends on:** 18 (the engine — merged), 50 (app bootstrap, for the wiring points)
**Blocks:** 25 (notes module's media attach), 50's media queue wiring
**SEC ids owned by THIS task:** none — SEC-MEDIA-01..06 are server-side (task 19)

## Why this task exists (the split, 2026-07-16)

**Task 18 shipped the platform-free media engine and was merged as a complete slice.** It deliberately did **not** ship the mobile capture half. Its implementer said so plainly and asked not to be merged as though it had: *"please don't merge believing otherwise."* Splitting is the honest bookkeeping — hiding unbuilt work inside a `done` row is the orphan class the QA sweep exists to find.

**What task 18 DID ship** (all merged, reviewed, adversarially tested):
- `@bolusi/core/media`: the `uploadStatus` machine, the single-flight drain loop with **server-authoritative** chunk resume, backoff, pruning-eligibility, failure-surfacing, download-verify.
- `apps/mobile/src/media/transport.ts` (the fetch `MediaTransportPort`) and `files.ts` (the file adapter).
- The 3 lint rules 06 mandates, the i18n label keys, `zMediaRef` in `@bolusi/schemas` (task 72 records why not core).

## What is NOT built — impl-18's own enumeration, verbatim

- **`MediaCapture`** — expo-camera **live capture only** (`expo-image-picker` is lint-banned).
- **The signature pad.**
- **The pinned compress/downscale passes** — `06 §2.2` steps 1–4.
- **cache→document move WIRING** — `moveCaptureToDocumentDir` **exists and is uncalled** (`files.ts`).
- **Drain triggers** — `06 §5.2`.
- **`expo-background-task` registration** — `06 §5.4`. **Note: `registerTaskAsync` silently returns when status is `Restricted`** — a registration that succeeds at doing nothing (task 59's class; T-15).
- **The pruning pass adapter** — `06 §7`: `prunePlanFor` **decides, nothing acts**.
- **The remote render-time cache** — `06 §6`: `fetchAndVerifyMedia` **exists and is uncalled**.

## Read this first — the traps are already mapped

- **`files.ts` has NO tests and NO callers**, and its header says so. Do not read it as verified. Task 18's original residual-risk statement claimed assertions ran "against a mocked `expo-file-system`" — **there is no such mock, no `files.test.ts`, and zero callers**. review-18 caught it: *vacuously true over zero assertions while reading as "a mock-backed suite exists, here's its limit."* **That decoy framing is why a floating `move()` survived review.** The statement is now honest; keep it that way.
- **`no-floating-promises` now covers `apps/mobile/src/**`** (task 18 extended it after shipping `source.move(destination)` unawaited — an evidence-destroying bug: the row would point into the OS-purgeable cache dir before the move completed). It is falsified: drop an `await` → real `pnpm lint` goes RED. **The class is closed by construction; do not weaken the rule.**
- **T-19 (`??` on a failed read is a lie generator)** was written from this task's own bugs: `hashFile`'s dead `?? 0` returned the **empty-string SHA-256** — a real-looking hash that `HASH_MISMATCH` reads as *"your evidence rotted"*; `sizeOf` returned **0 bytes** for a missing file. Both fixed. **The capture path is full of the same shape** (a missing EXIF field, an absent dimension, a failed stat).
- **Verify every Expo API's PLATFORM COLUMN in current docs, not its existence** (T-14f/T-15, and **D17 now makes iOS first-class**). Live traps already found: `getFreeDiskStorageAsync` **throws at runtime** on SDK 54+ (use `Paths.availableDiskSpace`); `BackgroundTask.registerTaskAsync` **silently returns** on `Restricted`.
- **FR-1138 is asserted now** (`test/media/sync-independence.test.ts`, 6/6, both directions): ops referencing media stay **fully sync-independent**. A stalled media queue must never block an op push. **Do not couple them.**

## Docs to read

`06-media-pipeline.md` (primary — §2.2, §5.2, §5.4, §6, §7, §10), `api/03-media.md`, `03-state-machines.md` §4/§4.1, `design-system.md` (capture UI — and **D17**: the frontend bar is "beautiful", `frontend-design` + `impeccable` are mandatory), `ai-docs/tasks/18-*.md` §Outcome, `ai-docs/decisions/2026-07-16-ios-is-a-first-class-target.md` (**D17**).

## Acceptance

**Observable done-condition:** a photo captured on-device reaches the server through the real engine, and every uncalled function above has a caller.

- **`security-guide` §2.5 applies** — media capture/upload is a security surface; adversarial tests ship **before** review, not after.
- **Reproduce first** (T-11): each uncalled function is a *finding* — prove it's uncalled before wiring it (`moveCaptureToDocumentDir`, `fetchAndVerifyMedia`, `prunePlanFor`'s actor). Four premises have been refuted on this project; if one is already wired, **STOP and report**.
- **The evidence-preservation guards are the point** (task 18 falsified these; keep them red-able): pending/uploading/failed media is **NEVER** pruned at any storage level; a lying server cannot mark evidence uploaded (a false `uploaded` starts a 7-day timer that **deletes the file**); tampered/truncated downloads are rejected with a positive control (T-17).
- **`registerTaskAsync`'s `Restricted` silent-return must be handled and TESTED** — a registration that succeeds at doing nothing is exactly `setNotificationChannelAsync`'s shape (task 59). If it can't register, the user must not believe uploads are queued.
- **D17: both platforms.** Every capture/compression/filesystem claim states its Android leg AND its iOS leg, or states which is unverified. **No physical device for either** (D12/D13) — say so in the required words.
- **`pnpm task:status <id> <status>`** is the only sanctioned way to change Status (CLAUDE.md §5). Check `_index.md` for next-free **at the moment you file** anything.
- `pnpm test`, `pnpm lint`, `pnpm typecheck` green — **read the output, not the exit code** (§2.1). **T-18**: a "completed (exit code 0)" notification has repeatedly described a **reaped** run; `wc -c` a fast log and confirm the denominator.

## Note

Filed from a **scope refusal that was correct**. impl-18 built the reviewable, testable core — the engine, its adapters, the lint rules — and stopped, rather than half-building seven mobile surfaces to make a row say `done`. It then enumerated exactly what it hadn't built, unprompted.

Worth carrying: **the split was possible because the engine is platform-free.** `06`'s architecture (a `@bolusi/core` engine behind injected ports, adapters at the edges) is what let one task ship a complete slice while the device-dependent half waits — and it is why that half can be built later without redesigning the engine. The boundary earned its keep.
