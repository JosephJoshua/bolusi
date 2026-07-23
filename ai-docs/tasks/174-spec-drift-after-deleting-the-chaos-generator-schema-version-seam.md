# TASK 174 — spec drift after task 132 deleted the chaos generator's dead schemaVersion / cutover seam

**Status:** todo
**Priority:** LOW — doc-accuracy, not a product defect. But the live specs now describe a generator
seam that no longer exists, and a "the generator must exercise the migration seam" line a reader would
trust is now false, so the drift should be owned rather than rediscovered (CLAUDE.md §2.6/§7).
**Depends on:** 132
**Blocks:** —
**SEC ids owned by THIS task:** none.
**Filed by:** impl-132b, 2026-07-23, as the found-but-not-fixed consequence of task 132 item 1.

## Background — what task 132 item 1 changed and why
The chaos determinism kit's `generateScript` (`packages/test-support/src/determinism/script.ts`) and
the `generateSeed200k` builder (`.../seed/seed-200k.ts`) each emitted a `ScriptOp.schemaVersion: 1 | 2`
descriptor field, driven by a `cutoverIndex` option, and two tests SHAPE-ASSERTED it
(`script.test.ts` "honors the v1→v2 cutover seam", `seed-200k.test.ts` "v1→v2 schema cutover EXACTLY
at op 100,000"). **Nothing consumed the field.** A scripted op is mapped to a REAL `notes` command on
the authoring device, and the command runtime stamps `schemaVersion` from the operation registry
(`ctx.ts` — `resolveSchemaVersion`, "never defaulted, never caller-supplied"), so the descriptor's
version was dropped at the command boundary; the cap `1 | 2` could not even name the version
production sends (v3). The v1→v2→v3 fold behaviour the seam was meant to prove is genuinely exercised
— incremental apply AND full rebuild — in `packages/modules/test/migration.test.ts`. Task 132 chose
DELETE over wire (wiring would require hand-built signed ops, which is exactly what migration.test.ts
already does, for no applier coverage that test lacks). The field, the `cutoverIndex` option that fed
it, and the two shape-assertion tests were removed.

## The drift — live specs still describe the deleted seam
These are the places a reader would now be misled. **Correct them to say the schema-migration seam
coverage lives in `packages/modules/test/migration.test.ts`, and drop the generator/SEED cutover
language.** Do NOT re-add the field.

1. `ai-docs/testing-guide.md:137` — "The op script generator must exercise the `schemaVersion: 2`
   migration seam: v1 payloads before a seeded cutover index, v2 after." **Now false** — the generator
   carries no such seam. (Task **131** item 6 already flags this same line for a *different* reading —
   "reads as if v2 were head"; coordinate so one edit fixes both, or hand this line to 131.)
2. `ai-docs/testing-guide.md:147` — the generator signature is documented as
   `generateScript(prng, {opsPerDevice, deviceCount, cutoverIndex})`. `cutoverIndex` is gone.
3. `ai-docs/testing-guide.md:313` — SEED-200K described as "...v1→v2 schema cutover at op 100,000."
   The cutover is gone from `SEED_200K`.
4. `ai-docs/decisions/2026-07-21-device-benchmarks.md:16` — describes the SEED-200K history as
   "...v1→v2 cutover at op 100,000." Same drift, in a live decision doc.

## Historical references (already-done tasks — likely leave as built-record, reviewer's call)
These name the deleted seam too, but they are `done` task files recording what was built at the time,
not live guidance. Flag for awareness; editing done-task bodies retroactively may be more noise than
signal — decide during review:
- `ai-docs/tasks/25-notes-module.md:6,17,40` (the v1→v2 cutover seam as a task-26 prerequisite)
- `ai-docs/tasks/26-chaos-harness.md:8,41,79` (`generateScript ... v1→v2 cutover seam`)
- `ai-docs/tasks/27-device-gates.md:52` (SEED-200K "v1→v2 cutover exactly at op 100,000")

## Not in scope / do NOT touch
- `packages/core/test/projection/notes-fixture.ts` has its OWN independent `cutoverIndex` that builds
  REAL v1/v2 `note_created` ops (folded for real). That is unrelated to the test-support generator and
  is correct — leave it.
- The testing-guide §3.2.2 *obligation itself* (that the v1↔v2 migration seam is covered somewhere) is
  still met — by migration.test.ts. This task only fixes WHERE the docs say it lives; it does not
  weaken any coverage.

## Acceptance
Each live-spec site above either points at `migration.test.ts` or drops the stale generator/SEED
cutover language; no doc still claims the chaos generator carries a schemaVersion seam. Grep
`cutoverIndex\|cutover` under `ai-docs/` returns only the intentional survivors (migration.test.ts's
own "cutover" prose, notes-fixture.ts, and any built-record task bodies the reviewer chose to keep).
