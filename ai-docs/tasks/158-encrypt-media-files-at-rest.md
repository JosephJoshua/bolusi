# TASK 158 — captured media FILES sit unencrypted on disk at rest (column encryption covers the DB, not the photos it points to)

**Status:** todo
**Priority:** MEDIUM — the captured repair photos are core evidence, but they upload and are meant to be pruned, and the signed sha256 still detects tampering. Owner ruled (D22 addendum 2): file separately, do NOT block task 148's DB-column encryption.

> **REVIEW FOUND REAL DEFECTS (review-wave 2026-08-04, 7 confirmed, all PoC-verified). REDESIGN DONE 2026-08-04 — findings 1, 2, 4, 6 FIXED; 3, 5, 7 addressed/documented (see per-item notes). Re-review before merge.** The tested cipher + `EncryptingMediaFile` + native wiring + SEC-MEDIA-09 declaration were committed, then reworked:
> - **#1 FIXED** — the cipher is now a STREAM construction (per-file random nonce base header + derived per-frame nonce = `base ‖ BE32(index + finalFlag)`); reorder/truncate/duplicate/cross-file-splice all fail LOUD, with adversarial tests + a §2.11 falsification (neuter the counter → the structural tests red).
> - **#2 FIXED** — `ImageCompressorPort.compress` now returns its own `sizeBytes` (measured natively); the `sizeOf` dep is gone from compression, so no plaintext file is sized through the encrypting geometry.
> - **#4 FIXED** — the pruning pass now calls `clearRenderTemps` every run (with a test), so render-decrypt plaintext temps do not accumulate.
> - **#6 FIXED** — `hashFile` now streams frame-by-frame into an incremental digest (peak one frame); `decryptToBuffer` (render only) still buffers, bounded by the ≤300 KiB cap and documented.
> - **#3 (device honesty)** — the SEC-MEDIA-09 row states "FED, NOT CLOSED" (Node lane) and now names the owed emulator media-at-rest leg; wiring that emulator leg (like SEC-AUTH-09's part-c) is the remaining follow-up.
> - **#5 (SEC-MEDIA-07 evict on encrypting binding)** — covered in pieces (core proves `hashFile` decrypts; remote-cache proves evict-on-mismatch); an end-to-end encrypting integration case is a nice-to-have residual.
> - **#7 (dist staleness)** — the gated lanes `tsc -b` before testing; only ad-hoc `vitest run` without a build sees stale dist. Noted.
>
> Original findings (kept for the record):
> 1. **[MAJOR crypto] No cross-frame binding** (`media-file-cipher.ts`). Each frame = random-nonce‖ct‖tag, no frame-index / file-id binding (the AEAD has no AAD param). On-disk frames can be **reordered / whole-frame-truncated / duplicated / spliced from another file** (all share one derived key) and `decryptToBuffer`/`hashFile`/`readChunk` return the rearranged plaintext with NO throw — contradicting the "any tamper fails LOUD" claim. Confidentiality is intact; FILE-level integrity is not. Live v3 render + upload re-hash against the signed `sha256` (so live exposure is the future-only legacy render path, R28), but the CLAIM is false. **Fix: a STREAM construction** — a per-file random nonce BASE in a file header + deterministic per-frame nonce = `base ‖ counter(frameIndex)` with a FINAL-frame flag (binds order, prevents truncation/splice/duplication); store only the base, derive per-frame nonces, drop the stored per-frame nonce. Add adversarial tests for reorder / truncate-at-boundary / cross-file splice / duplicate (the current tests only flip a byte WITHIN a frame).
> 2. **[MAJOR native] Compression sizeOf crash** (`compression.ts`/`capture.ts:146`). Compression sizes the PLAINTEXT compressor output through the now-encrypting `sizeOf`, which subtracts 28 B/frame; plaintext sizes in [262173,262200] throw `RangeError` → `capturePhoto` crashes; the size is off by 28·frames otherwise. **Fix: `ImageCompressorPort.compress` returns its own encoded `sizeBytes` (measured natively on the plaintext file); drop the `sizeOf` dep from `CompressionDeps`.** finalize's signed `sizeBytes` is unaffected (it re-measures the encrypted file).
> 3. **[MAJOR sec-honesty] SEC-MEDIA-09 device claim has no red-able gate.** SEC-META-01 credits it off a Node-only title while "file bytes are ciphertext on a device" never executes. Same posture as SEC-AUTH-09 but SEC-AUTH-09 has an emulator part-c leg; SEC-MEDIA-09 has none. **Fix: mirror SEC-AUTH-09 exactly** — state "FED, NOT CLOSED" in the row (done) AND file/wire the emulator at-rest leg for media files (a follow-up harness task), so the device claim has a home.
> 4. **[MINOR native] Render temps never pruned** — `toRenderUri` writes `<cacheDirectory>/media-render/` but the pruning pass only lists `mediaCacheDirectory()`, so decrypted plaintext temps accumulate. **Fix: prune `media-render` (evict alongside the render cache), or write the temp and delete it after the render consumes it.**
> 5. **[MINOR sec-honesty] SEC-MEDIA-07 evict-path untested on the encrypting binding** — the re-verify-and-evict recovery is only exercised against unencrypted fakes. **Fix: an integration case over the real encrypting binding.**
> 6. **[MINOR scope] `hashFile` buffers the whole plaintext** (`encrypting-file.ts` `#decryptWhole`), contradicting the module header's "peak memory one frame on every path". **Fix: stream the hash frame-by-frame (inject an incremental hasher), or correct the claim to note `hashFile` buffers, bounded by the ≤300 KiB v0 cap (v1 tripwire).**
> 7. **[NIT] core SEC-MEDIA-09 test resolves `@bolusi/core` to `dist/`** — a bare `vitest run` without a preceding `tsc -b` validates stale dist (the gated lanes build first, so this only bites ad-hoc runs). Note it.
**Depends on:** 148 (the app-layer AEAD mechanism + the SecureStore DB key it establishes), 06 (media pipeline), 82 (capture)
**Blocks:** —
**SEC ids owned by THIS task:** SEC-MEDIA-09
SEC-MEDIA-09 (captured media FILES encrypted at rest) is the gap this task closes — none of SEC-MEDIA-01..08 covered files on disk (as opposed to the DB columns). The marker line above is a bare id list on purpose (`parseOwnedIds`, sec-meta.ts, rejects trailing prose). Node-lane falsified; on-device leg emulator-deferred (D21).
**Filed by:** the orchestrator, 2026-07-22, from the D22 addendum-2 column-set sign-off.

## The finding
Task 148 encrypts the sensitive DB **columns** (app-layer AEAD). But captured photos are stored as **files** on the device filesystem; the DB only holds `media_items.local_path` (a pointer). So the actual repair photos sit as **plaintext files at rest** — a forensic reader of a non-running device reads them directly, bypassing the DB encryption entirely. This is a bigger exposure than any single DB column (a photo IS the evidence).

## The residual as accepted for v0 (until this lands)
Recorded in D22 addendum 2 / the threat model: photos-on-disk are plaintext at rest for v0. Mitigating: media uploads to the server and the local copy is pruned after successful upload (06 §5/§7); the signed `sha256` on the ref detects tampering on pull. So the window is "captured-but-not-yet-pruned photos on a lost/stolen non-running device."

## Deliverable
Encrypt captured media files at rest with **file-level** AEAD, reusing task 148's SecureStore DB key (or a sibling key — decide, but do NOT vendor a second crypto). This is a DIFFERENT mechanism than column encryption (whole-file, streamed — a photo can be MBs, so read `06-media-pipeline.md` for the size ceiling and the 2 GB-device memory budget; stream in chunks, do not load a whole video into memory). The render path (task 140 Leg A) and the drain/upload path both read these files — both must decrypt transparently. Verify current expo-file-system + quick-crypto streaming-AEAD APIs via Context7 (SDK 57), not memory.

## FALSIFY (§2.11 — REPORT it)
- A captured photo's file on disk is ciphertext (raw read ≠ the JPEG magic bytes); the render path still displays it (decrypts transparently) and still verifies against the signed `sha256` (task 140 Leg A); the drain still uploads the correct plaintext bytes. Break the decrypt → render/upload reds. Restore → green.
- Wrong key fails to decrypt (not silent garbage rendered).
- Perf: streaming AEAD of an MB-scale file on the render/UI path of a 2 GB device — measure or bound it; do not load the whole file to memory. State what's emulator-only.

## Note
Sequence after 148 (needs its key + AEAD helpers). Coordinate with 140 Leg A (render) and the media drain — both read the file.
