# TASK 66 — three agents filed colliding task numbers in one session, and the collision auto-merges **clean**: nothing checks `_index.md` against the filesystem

**Status:** todo
**Priority:** **MEDIUM — but it is actively firing.** Three instances in a single session (impl-54, impl-58, impl-61). It will fire again on the next parallel wave, and CLAUDE.md §2.6 makes the thing it corrupts — `_index.md` — the single source of truth for "what's left".
**Depends on:** —
**Blocks:** —
**SEC ids owned by THIS task:** none

## The finding (orchestrator, 2026-07-15, from review-58's finding 1)

Agents file new task files by computing "the next free number" from `ls ai-docs/tasks/`. In a parallel wave, **every agent computes it from a tree that has already moved.** Measured this session:

| agent | filed | collided with |
| ----- | ----- | ------------- |
| impl-54 | `61-sec-dev-partial-leg-retire.md` | — (landed first) |
| impl-58 | `61-user-interface-style-is-inert.md` | impl-54's 61 |
| impl-61 | `62-sec-dev-offline-revocation-spec-conflict.md` | the orchestrator's `62-spec-mandates-the-noop-it-was-bitten-by.md` |

The orchestrator then mis-planned the *repair* twice: told review-58 the renumber target was **62** (already taken), and review-58 replied **63** (free when it checked, taken by the time it said so). Correct answers turned out to be 64 and 65. **Everyone in this loop — three agents, one reviewer, the orchestrator — computed the same quantity from a different snapshot and got a different answer.** That is not carelessness; it is a read-modify-write race with no lock.

## Why it is worse than a noisy conflict: it is **half-silent**

Found by review-58, reproduced by the orchestrator:

- `_index.md` **conflicts loudly** — both agents added a row at the same anchor. You see it, you resolve it.
- The task **files auto-merge clean**, because the filenames differ (`61-sec-dev-partial-leg-retire.md` vs `61-user-interface-style-is-inert.md`). **Two task 61s land on disk with no conflict and no warning.**

So the natural repair — resolve the loud index conflict, keep both rows — **leaves the silent duplicate on disk**, and now `_index.md` (§2.6's source of truth) has two rows numbered 61 pointing at two different files, or one row pointing at whichever file a reader opens first. Review-58 reproduced exactly that duplicate row.

**The loud failure masked the silent one** — T-14h's shape, arriving in the ledger instead of a test.

## What no gate checks

`_index.md` is **normative** (CLAUDE.md §2.6: *"the single source of truth for 'what's left'"*), and **nothing reads it**. There is no check that:

1. no two task files share a number;
2. every task file has exactly one `_index.md` row;
3. every `_index.md` row has exactly one task file;
4. a row's `Status` matches the task file's `**Status:**` line — **already drifted, and the orchestrator measured it worse than reported.** impl-61 named 07/13/15 and review-58 named 58; the actual count is **8**: `07, 13, 15, 16, 30, 32, 46, 48` all say `in-review` in the file while the index says `done`. **The cause is the orchestrator's merge procedure**, which updates `_index.md` and never touches the task file's Status line — so *every* merged task drifts, and the drift is 100% of merges, not an occasional slip. This one has teeth: `sec-meta.ts`'s `staleAllowlist` **reads the task file's Status**, so a stale allowlist row pointing at an index-`done` task **would not fire** — the gate's own liveness depends on the field nobody maintains.

Every one of these is mechanically checkable in a few lines, over files the repo already parses (`packages/test-support/src/sec-meta.ts` already globs `ai-docs/tasks/*.md` and enforces `OWNER_PATH_PATTERN = /^ai-docs\/tasks\/\d{2}-[\w-]+\.md$/`). **The parser exists; nobody pointed it at the ledger.**

## Acceptance

**Observable done-condition:** two task files sharing a number fails a test; an index row with no file fails; a file with no row fails; and a Status disagreement fails.

- **Reproduce first** (T-11): create `ai-docs/tasks/61-duplicate-probe.md` beside the real 61, run the suite, and **watch everything stay green**. That observation is the finding. Delete the probe.
- **Ride the existing rails** (§2.8): `sec-meta.ts` already globs the task dir and has a path grammar. Add the ledger checks there or beside it; **do not build a second task-file parser**.
- **The `27a`/`27b` case is legitimate — do not flag it.** The orchestrator ran the check by hand at filing time: **65 rows vs 64 files**, zero duplicates, zero orphans. The gap is real and correct: task 27 was split into rows **`27a`** and **`27b`** while the file stayed `27-device-gates.md`. So the invariant is *not* row-count == file-count, and it is *not* a bijection. It is: **every row resolves to exactly one existing file, and every file is referenced by at least one row.** A gate written to the naive equality goes red on day one against correct data, and the fix for *that* will be to loosen it until it stops complaining — which is how a gate ends up checking nothing. Note also `OWNER_PATH_PATTERN = /^ai-docs\/tasks\/\d{2}-[\w-]+\.md$/` in `sec-meta.ts` assumes exactly two digits; check what it does at task 100.
- **Assert the denominator** (T-14): the gate names how many task files and how many index rows it compared, and **fails loudly on zero**. A ledger gate that silently checks nothing is this repo's ninth instance. Note the failure mode to avoid specifically: globbing `ai-docs/tasks/*.md` and finding `_index.md` itself in the list, or a glob that matches nothing and reports "0 duplicates — green".
- **Falsify all four legs** (§2.11), each separately: duplicate number → RED; row without file → RED; file without row → RED; Status mismatch → RED. Restore → green. Report as "broke X, saw Y fail, reverted".
- **Fix the live drift**: all **8** (`07, 13, 15, 16, 30, 32, 46, 48`) — re-derive the list yourself (T-14), it has already been reported as 3 and as 4. **The index is right and the files are stale**: these tasks are merged; the merge simply never wrote back. So flattening files → `done` is correct *here* — but **do not hardcode that direction in the gate**, because the opposite drift (a file marked `done` whose row still says `in-progress`) means something entirely different and must not be auto-resolved.
- **The gate is necessary but not sufficient — fix the writer too, or it just goes red every merge.** A ledger check that fails on every merge until someone hand-edits a file is a check people will learn to route around (§2.10's `--no-verify` instinct, earned honestly). Either the merge step updates both, or the Status lives in exactly one place. Say which you chose.
- **Consider the cheaper structural fix and say why you did or didn't**: if the number is derivable from the filename and the row, the duplicate is only possible because the number is written twice. An `_index.md` generated from the task files' front matter cannot disagree with them. That is a bigger change; the gate is the floor.
- `pnpm test`, `pnpm lint`, `pnpm typecheck` green — **read the output, not the exit code** (§2.1).

## Note

This is a **coordination** defect, not a competence one, and the fix must be mechanical rather than procedural. Six independent readers — impl-54, impl-58, impl-61, review-58, and the orchestrator twice — each computed "the next free number" correctly against the tree they could see, and produced five different answers. Telling the next agent to "check for collisions first" does not help: the tree moves between the check and the write. **The only thing that closes it is a gate that runs after the merge, when the tree has stopped moving.**

Worth carrying: the collision is invisible to `git` **by design** — two files with different names are not a conflict, and git is right about that. The uniqueness constraint lives in the *number embedded in the filename*, which git has no reason to know about. **Any invariant encoded in a filename is invisible to version control**, and this repo has exactly one such invariant.
