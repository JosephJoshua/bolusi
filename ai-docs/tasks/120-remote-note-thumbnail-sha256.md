# TASK 120 — a REMOTE note's photo thumbnail cannot be download-verified: the note_created payload carries only mediaId, not the signed sha256/mime that 06 §6 requires to verify a pulled note's media

**Status:** todo
**Priority:** MEDIUM — self-captured/local notes resolve their thumbnail via local_path (no sha256 needed), so this is not a live break today; but a note pulled from ANOTHER device carries only mediaId, and 06 §6's download-verify needs the sha256 from the SIGNED payload. So remote thumbnails cannot be integrity-verified as specified.
**Depends on:** 25 (notes op payloads), 82 (media pipeline), 18
**Blocks:** NoteDetail thumbnail download-verify for remote notes (task 96 handles local; remote falls back to unverified/unavailable)
**SEC ids owned by THIS task:** none.
**Filed by:** the orchestrator, 2026-07-21, from task 96's flagged gap #1.

## The finding (task 96)
`06 §6` requires the media's signed `sha256` (and mime) to download-verify a note's photo. Task 25's `note_created` v2 payload carries `mediaId` but not the signed `sha256`/`mime`. NoteDetail's `loadThumbnail` -> media client `loadForRender` can verify a LOCAL capture (local_path, sha recorded at capture), but a REMOTE (pulled) note has no signed sha256 to verify against.

## Deliverable
- Decide + implement where the signed `sha256`/`mime` travels for a note's attached media so a remote note's thumbnail can be download-verified per 06 §6 (most likely: carry them in the note op's signed v2 payload alongside `mediaId`, since the op is what's signed — confirm against 05 §2 / 06 §6 before changing the payload shape; a payload change is a data-layer decision).
- **Falsify (§2.11):** a test that a pulled remote note with an attached photo verifies the thumbnail against the signed sha256, and that a tampered/mismatched blob is rejected (the mismatch state renders). Break the verify -> a wrong blob renders as if valid -> RED -> restore.
- `pnpm typecheck`/`lint`/`test` green (+ the op-payload schema/version gate if the payload shape changes).

## Note
A data-layer/media-pipeline gap, not a screen bug -- task 96 correctly rendered the states it could (ready/unavailable/mismatch) and flagged that remote verification needs the signed hash on the wire.
