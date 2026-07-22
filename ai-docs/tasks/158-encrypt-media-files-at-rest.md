# TASK 158 — captured media FILES sit unencrypted on disk at rest (column encryption covers the DB, not the photos it points to)

**Status:** todo
**Priority:** MEDIUM — the captured repair photos are core evidence, but they upload and are meant to be pruned, and the signed sha256 still detects tampering. Owner ruled (D22 addendum 2): file separately, do NOT block task 148's DB-column encryption.
**Depends on:** 148 (the app-layer AEAD mechanism + the SecureStore DB key it establishes), 06 (media pipeline), 82 (capture)
**Blocks:** —
**SEC ids owned by THIS task:** check `security-guide.md` for a media-at-rest SEC id; if none covers *files on disk* (as opposed to the DB), that is a gap to note.
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
