# TASK 202 — retire the `notesOnly` / `deviceSeed` / `dedupeById` copies hand-rolled in the `@bolusi/harness` Node chaos scenarios; import the shared `wire-helpers` via the test-support chaos barrel

**Depends on:** 200 (it landed the canonical `packages/test-support/src/chaos/wire-helpers.ts`; this task exports it from the barrel and points the harness scenarios at it)
**Blocks:** — (maintainability / drift-prevention; no behavior change)
**SEC ids owned by THIS task:** none.
**Priority:** LOW — no current failing input; §2.8 rule-of-three drift-prevention.
**Filed by:** review-wave of task 200 (2026-09-06). The duplication lens found these copies; adversarial verify **confirmed them factually real** but correctly refuted them as a *task-200 defect* on two grounds — (1) out of 200's scope (copy-set A named exactly the four `packages/test-support/src/chaos/` files, all correctly migrated; these are `@bolusi/harness/scenarios` siblings, named in 200 only under copy-set D for `CountingTransport`), and (2) no concrete failing input (these Node scenarios' local `deviceSeed` only seeds their own `mulberry32` PRNGs, no cross-file assertion). So they did **not** block 200's merge — but per the review-wave skill a confirmed duplication becomes an extraction task naming every copy by path, and per CLAUDE.md §2.8 there must be one implementation, not per-file copies. This is the sibling of how review-wave-198 filed task 200 itself.

## The finding (one copy-set, already past the rule-of-three trigger)

`packages/test-support/src/chaos/wire-helpers.ts` is the canonical, **exported** home (landed by task 200):
- `notesOnly` → `wire-helpers.ts:12`
- `deviceSeed` → `wire-helpers.ts:17`
- `dedupeById` → `wire-helpers.ts:22`

Re-declared byte-identically as file-local `function`s in the `@bolusi/harness` Node scenarios:
- **`notesOnly`** — three copies: `packages/harness/scenarios/chaos-03-days-offline.test.ts:69`, `packages/harness/scenarios/chaos-04-clock-skew.test.ts:69`, `packages/harness/scenarios/chaos-08-rebuild.test.ts:98`
- **`deviceSeed`** — one copy: `packages/harness/scenarios/chaos-03-days-offline.test.ts:74`
- **`dedupeById`** — one copy: `packages/harness/scenarios/chaos-03-days-offline.test.ts:226`

`notesOnly` alone is at three independent harness copies **plus** the canonical — the exact "value-identical today, silently diverges on the next one-sided edit" class the 2026-07-26 audit flagged (`severity()` drifted between two enums that cited each other).

## The prerequisite (why 200 could not just re-point these)

`packages/test-support/src/chaos/index.ts` does **not** currently export `wire-helpers` — task 200 imported it by relative path from inside the `test-support/chaos` package only. The harness scenarios consume `@bolusi/test-support` across the package boundary (they already import `mulberry32` / `randomInt` from it), so:
1. add `wire-helpers` to the chaos barrel (`packages/test-support/src/chaos/index.ts`), and
2. import `notesOnly` / `deviceSeed` / `dedupeById` from `@bolusi/test-support` in `chaos-03-days-offline.test.ts`, `chaos-04-clock-skew.test.ts`, `chaos-08-rebuild.test.ts`; delete the five local copies.

Both packages are `"private": true` test-only — no production importer, no new prod coupling; `apps/mobile` is untouched.

## FALSIFY (§2.11) — before collapsing, prove they are safe to collapse

- **Byte-identity check first.** Diff each of the five local copies against the `wire-helpers.ts` version. All are expected identical — but if any of the three `notesOnly` copies (chaos-03 vs chaos-04 vs chaos-08) has already drifted, do **NOT** silently collapse it to the shared version: that drift *is* a finding (a hidden behavior change), so report it and reconcile deliberately, not by fiat.
- **Duplication actually gone (the load-bearing check):** after extraction, `grep -rn 'function notesOnly\|function deviceSeed\|function dedupeById' packages apps --include=*.ts | grep -v node_modules | grep -v /dist/` returns exactly ONE source definition each (`wire-helpers.ts`) + N imports — not N definitions. Falsify by re-adding a second definition and confirming the grep-count / a lint or knip guard reds, then revert.

## Acceptance

- The five local copies are deleted; `wire-helpers` is barrel-exported; the three harness scenarios import the shared symbols.
- Behaviour-preserving: the harness scenario suite (`chaos-03-days-offline`, `chaos-04-clock-skew`, `chaos-08-rebuild`) stays green before and after (test-only helpers, no runtime surface).
- No new coupling into production; `apps/mobile` gains no `@bolusi/harness` / `@bolusi/server` dependency (standing constraint).
- `pnpm typecheck` / `lint` / `knip` (+0 new) green.

## Note

Uncontended, test-only — extract in place on its own branch off `origin/main` after 200 merges, one atomic commit, then `review-wave`.
