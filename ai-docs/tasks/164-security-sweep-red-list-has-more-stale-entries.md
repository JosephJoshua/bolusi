# TASK 164 — the `security-sweep` expected-red register has further stale entries: reason 3 describes an omission that no longer exists, and the "three things" count no longer matches the run

**Status:** todo
**Priority:** MEDIUM — this register is the list a human reads to decide "expected red, move on." Every wrong entry in it is a place a real regression can hide behind a known failure.
**Depends on:** 154 (closing the machine-checked half of the same hole)
**Blocks:** —
**SEC ids owned by THIS task:** none.
**Filed by:** impl-162, 2026-07-23, while correcting reason 2 of the same comment block.

## Context

`.github/workflows/ci.yml`, the `security-sweep` header comment, lists "Three things keep it red". **Reason 2 was corrected by task 162** (it claimed a `500` for a cross-tenant media id; `d12face` had already made that a `404`, so the real shape is 404-for-a-foreign-id vs 200-for-a-free-one). Auditing the neighbours turned up more.

## Finding 1 — reason 3 is stale

The comment says:

```
#   3. security-guide §12's roll-up line omits SEC-DEV-08, which task 58 shipped.
```

`ai-docs/security-guide.md:346` (§12, "Test index") actually reads:

> Roll-up: OPLOG 01–09 · SYNC 01–10 · AUTH 01–11 · **DEV 01–08** · MEDIA 01–06 · TENANT 01–06 · RT 01–05 · SECRET 01–02 · META 01.

`DEV 01–08` **includes** SEC-DEV-08. The omission the comment describes is not present in the file it names.

## Finding 2 — the count no longer matches the observed run

CI run **29949061877**'s `security-sweep` job shows the only failing summary step is `SEC inventory`, with a single FAIL line naming exactly **SEC-AUTH-09** and **SEC-AUTH-10** — i.e. reason 1 alone. Neither reason 2 nor reason 3 appears in that output. "Three things keep it red" is therefore a claim about the job that the job's own log does not support.

*(Second-hand: this figure comes from the orchestrator's read of the run, not from a run this task's filer dispatched. **Re-read the job log before acting on it** — §2.1, know which process answered.)*

## Why this matters more than tidiness

A permanently-red merge gate is only safe if its red-list is exact. Reasons that are stale, over-counted, or wrong turn "expected red" into a blanket excuse — the register stops being a list of known risks and becomes a reason not to look. That is the §2.11 anti-pattern applied to prose instead of a test, and this comment has now produced **two** wrong entries in one block, which suggests the block is not re-read when the things it describes change.

## Deliverable

1. Dispatch `security-sweep` (or read a current run's log directly) and enumerate what **actually** fails today, per failing step and per id.
2. Rewrite the header comment so each listed reason is one the current run produces, with the count matching. Delete entries that no longer fire; keep any that do, with their real behaviour.
3. Consider whether this register should be generated from the sweep's own output rather than hand-maintained — a hand-written list of machine facts drifts by default. Task 154 tightens the machine-checked side (the OWED bucket); the human-readable side is this one, and the two should not be able to disagree.

## FALSIFY (§2.11 — REPORT it, do not assert it)

- Quote the **actual** failing-step and FAIL lines from a run you read yourself, with the run id. Do not restate the numbers above — they are second-hand and are exactly what this task exists to check.
- For each reason you keep, name the specific output line that produces it. For each you delete, show the evidence it no longer fires (a passing step, or the corrected spec line).
- **A mention is not a producer (T-16):** confirm each surviving reason traces to a real failing assertion, not merely to an id appearing somewhere in the sweep's text.
