# TASK 131 — spec drift after the v3 payload and the frontend phase: docs and code comments describe a system that no longer exists

**Status:** todo
**Priority:** MEDIUM — a stale spec is a decoy, and this repo's §2.11 record shows decoys get trusted. Two of these are the "comment was the guard" shape on the very files whose correctness they describe.
**Depends on:** 120, 119, 96, 118
**Blocks:** —
**SEC ids owned by THIS task:** none.
**Filed by:** QA spec-verify sweep, 2026-07-22 (items D2/D3/D5/D8/D9 + nits).

>**PARTIAL — items 1, 2 and 4 are DONE** (orchestrator, 2026-07-22): `01-domain-model.md` now documents v3 `{title, body, mediaRef}` with the `mediaSha256`/`mediaMime` projection columns and the "every foldable version needs a retained payload schema" rule that task 127 turns into code; `10-db-schema.md` §8 (PG) and §9.6 (SQLite) now carry both columns with their migration ids (`0010` server / `002` client). Item 4 (applier header) is also done — `packages/modules/src/notes/applier.ts`'s header no longer says v3 REJECTS LOUDLY; it now documents that the applier folds all three versions and that per-version payload VALIDATION is task 127's separate `payloadByVersion` layer. Items 3, 5, 6, 7 remain open — several touch contended files (App.tsx per task 133-in-review; media/client.ts per task 140) and should land after those settle.

## Drift (each with file:line; fix the DOC or the CODE, whichever is wrong — and say which)

1. **`01-domain-model.md:288,298,302`** documents `note_created` at **v1/v2 only** and says `mediaId` was "Introduced by payload `schemaVersion: 2`" and "The v1→v2 bump … is deliberate". Task 120 made **v3** `{title, body, mediaRef}` current and added `mediaSha256`/`mediaMime` to the Note projection. `applier.ts:1` cites this section as "the authoritative type list" — so the authority is now wrong.
2. **`10-db-schema.md:609-623` (PG §8) and `:902-916` (SQLite §9.6)** list `media_id` only, commented "schemaVersion 2 payloads". Migrations `0010`/`002` added `media_sha256` + `media_mime` (`generated/db.ts:170` has them). 10-db's own change-control rule is "change this doc first, then write the migration", and `0010`'s header cites §8 as its source — the section that never got the columns.
3. **`apps/mobile/src/screens/settings/model.ts:52-62,117-124`** still ships the SUPERSEDED push-muting model and cites api/04-push §5 for it ("muting is expressed as channel IMPORTANCE"; `setMuted` → `setChannelImportance`). D18 §1 / task 59 replaced that with the OS-settings deep-link, and §5 now says explicitly it is "not a switch the app sets". Dead in production (the shipping screen renders the correct row) — but `model.test.ts:94` **asserts the superseded rule**, so the decoy is green-guarded. Delete the dead model and its test, or state why it survives.
4. **`packages/modules/src/notes/applier.ts:11-20,146`** — header says "THE v1↔v2 SEAM … **A v3-or-unknown version REJECTS LOUDLY (throws)**" and `:146` says "Fold `notes.note_created` (v1 or v2)". The code at `:133-138` **folds v3**. The comment describes the opposite of the function beneath it.
5. **`apps/mobile/App.tsx:281-283`** — "Until the shell is session-wired (`props.notes` is `undefined` today)…". Task 119 wired it (`Root.tsx:428`).
6. Cosmetic: `04-module-contract.md:42` shows `schemaVersion: 1` in the §3 example a new module author copies; `testing-guide.md:137` says "v2 after" the cutover (reads as if v2 were head); `media/client.ts:24-30`'s "NOT REAL YET" block is stale for `loadThumbnail` (120 wired it) and is contradicted by an adjacent paragraph in `index.ts`.
7. **`api/04-push §2` has no row for a cross-tenant token collision.** Task 118 fails closed with `PERMISSION_DENIED`, which is defensible — but it makes registration distinguish "this Expo token exists in another tenant" (403) from "it doesn't" (200), and the spec records neither the behaviour nor the argument. Document it (and confirm the distinguishability is acceptable, since the colliding value is a secret token rather than an enumerable id).

## Deliverable
Reconcile each. Where the doc is authority (01-domain-model, 10-db-schema), update the doc; where a comment lies about its own code, fix the comment (or the code if the comment was right). For item 3, remove the dead model + its guarding test rather than leaving a green-guarded decoy.
