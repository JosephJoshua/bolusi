# TASK 149 — the knip partition invariant can pass while `classify()` is wrong: it pins two instances, not the class, and has no denominator floor

**Status:** in-progress
**Priority:** MEDIUM — no dead file is invisible in the tree today and all four directory rules are contained as shipped, so this is not a live hole. Both gaps need a deliberate edit to the guard itself. Filed because **Gap B is demonstrated, not hypothetical**, and the edit that triggers it is a plausible one.
**Depends on:** 137 (Half B, merged 2026-07-22)
**Blocks:** —
**SEC ids owned by THIS task:** none.
**Filed by:** the task-137B reviewer, 2026-07-22, on the approving pass.

## Background
Task 137 Half B added `assertPartitionInvariant()` to `scripts/check-unused-exports.mjs` — it tests `classify()` as a pure function **before knip is spawned**, so a broken partition cannot even write a baseline. That was the implementer's own addition, closing a risk neither the reviewer nor the orchestrator had raised: the `src/` invariant changes no count in a clean tree, so deleting or typo'ing it would otherwise stay green forever. It fires correctly on deletion, and the `SRC_PATH` self-check against the canary's own path is a good touch.

Two gaps survive.

## Gap A — no denominator floor (T-14)
Emptying `cases` to `[]` gives a **vacuous pass**:
```
... 29 unused production files (baseline 29) ...; file canary present; +0 new / -0 resolved.
neither half of the sweep is blind.
EXIT=0
```
This is the archetype CLAUDE.md §2.11 names by hand — *"a codegen sweep looped over a parse that would check zero properties and report green."*

**Mitigating:** `cases` is a literal array in the same function, so unlike the disk-reading sweeps that produced that lesson it cannot silently shrink as the tree changes; it can only be deliberately edited. **Fix is one line:** `if (cases.length < 5) throw`.

## Gap B — the assertion pins instances, not the class (T-11/T-12). Demonstrated.
The invariant covers `migrations-dir` and `scripts-dir` under `src/`, but **not `test-dir` or `config-file`**. So `SRC_EXCLUDABLE_RULES` — the very Set the invariant exists to protect — can be widened straight past it.

Reviewer's demonstration: add `'test-dir'` to `SRC_EXCLUDABLE_RULES`, then drop a dead production file at `apps/mobile/src/test/dead-probe.ts`:
```
... 29 unused production files (baseline 29) plus 86 excluded; file canary present; +0 new / -0 resolved.
neither half of the sweep is blind.
EXIT=0            <- invariant passed, dead production file silently excluded
```
Control, identical file against the pristine gate: `EXIT=1`, `NEW unused production FILES (1) + apps/mobile/src/test/dead-probe.ts`.

So `classify()` can be wrong in a way that matters while the assertion stays green — and the triggering edit is plausible: a future author adds `src/**/test/` helper dirs and reaches for the obvious one-token allowance.

## Deliverable — derive the check from the rule list so it cannot drift as rules are added
```js
for (const r of NON_PRODUCTION_RULES) {
  if (SRC_EXCLUDABLE_RULES.has(r.name)) continue;
  // synthesize an src/ path matching r.re and assert classify() === null
}
```
or, simpler and arguably better because it states the intent directly: assert `SRC_EXCLUDABLE_RULES` is **exactly** `{test-file, type-test-file}`. Add Gap A's floor in the same change.

## FALSIFY (§2.11 — REPORT it)
- Reproduce Gap B's demonstration first (widen `SRC_EXCLUDABLE_RULES` with `test-dir`, drop a dead file under `apps/mobile/src/test/`) and lead with the `EXIT=0`. After the fix the same edit must fail **at the invariant**, before knip runs.
- Gap A: empty `cases` → must throw on the floor, not pass.
- **Positive control:** a clean tree still gives `+0/-0`, `EXIT=0` — the fix must not red the gate in its healthy state, or it will be muted.
- Add a rule to `NON_PRODUCTION_RULES` that is deliberately not in `SRC_EXCLUDABLE_RULES` and confirm the derived loop covers it automatically. That is the property that makes this a class check rather than a third instance.
