# TASK 195 — optional: a min-rows / presence floor over the i18n module-catalog leg in `i18n:check`

**Depends on:** 191
**Blocks:** —
**SEC ids owned by THIS task:** none.

**Filed by:** the task-191 review-wave (a correctness finding that was *adversarially refuted* as a defect — no reproducible current-state failing input — but flagged as a legitimate §2.11 defense-in-depth observation).

## Context — why this is LOW and deferrable

Task 191 made the catalog JSON the single canonical i18n source and removed the seed round-trip gates, including the old `checkSeed*` `SEED_MIN_ROWS >= 120` denominator floor. The review confirmed the reserved **and** module catalogs are still grammar/blank/ICU-linted (`i18n:check` reports `grammar-linted 184 catalog key(s) from 18 catalog file(s)` = 16 reserved + 2 notes; falsification F4 watched `notes.badkey` go red under grammar), and the T-14 non-emptiness floor for the notes leg was re-homed into `apps/mobile/test/notes-catalog-keys.test.ts` (`NOTES_KEYS.length >= 10` + exact catalog↔NOTES_KEYS parity, which throws ENOENT if the catalog dir is deleted/moved).

So there is **no defect today**. The only residue: `i18n:check` itself has no floor asserting the module-catalog leg is non-empty. A *future* module that ships screen keys via `tn()` but forgets its catalog — or co-locates it outside `packages/modules/<id>/i18n` where `loadModuleCatalogs()` scans — would be silently unlinted by `i18n:check` unless that module also lands its own `notes-catalog-keys`-style test. Every current module does; the gap is only that the discipline is per-module convention, not enforced centrally.

**This runs against the 2026-08-30 audit's reduce-gates thrust** — re-adding a central floor is exactly the kind of guard that audit trimmed. Decline it unless a second module lands without the per-module parity test. Recorded here so the observation is not lost, not because it must be built.

## Goal (if taken)

Add a small, self-falsifying floor to `i18n:check` (via `packages/i18n/scripts/check.mjs` / `gates.mjs`) asserting `loadModuleCatalogs()` returns a non-empty leg AND that every discovered module directory under `packages/modules/*/i18n` actually contributed keys — so a module whose catalog is missing/misplaced reds `i18n:check` centrally, not only via that module's own mobile test.

## Docs to read

- `ai-docs/07-i18n.md` §3.1, §7.3 (catalog gates); `ai-docs/testing-guide.md` T-14 (denominator floor), T-16 (mention ≠ producer).

## Files / modules touched (if taken)

- `packages/i18n/scripts/check.mjs` / `packages/i18n/scripts/gates.mjs` — add the module-leg presence floor.
- `packages/i18n/test/gates.test.ts` — cover it.

## Acceptance (if taken)

- With the notes catalog dir removed/renamed, `i18n:check` reds naming the empty/missing module leg (not just the mobile test).
- The floor cannot pass vacuously (T-14): assert the discovered-module count > 0 before dividing by it.

### Falsification (§2.11)

1. Move `packages/modules/notes/i18n` aside → `i18n:check` reds naming the missing leg. Restore → green.
2. Prove the floor is non-vacuous: force the discovered-module set to `[]` in a unit test → the gate reds rather than passing over an empty set.
