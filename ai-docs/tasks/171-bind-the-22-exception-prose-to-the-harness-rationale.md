# TASK 171 — §2.2's justification and the harness's `rationale` are two uncoupled prose copies of one claim

**Status:** todo
**Priority:** MEDIUM — this is the *root* of task 141a's round-2 blocker, not a new risk. The current state is verified correct; what is missing is anything preventing it drifting again.
**Depends on:** 141a
**Blocks:** —
**SEC ids owned by THIS task:** none.
**Filed by:** the task-141a reviewer, 2026-07-23, on the approving pass.

## The finding
`ai-docs/security-guide.md` §2.2 states each documented exception's justification in prose. The
SEC-TENANT-04 harness independently states the same claim in `probe-registry.ts`'s `rationale` string.
**Nothing ties them together.** `parseDocumentedExistenceExceptions` extracts only `index` and
`endpoint` from §2.2; `rationale` is free text that is never compared to anything.

That is exactly how task 141a's round-2 defect happened: the spec's justification was corrected to
drop the refuted "~88 bits of CSPRNG entropy" figure, and the harness silently kept the refuted
premise — **in the `rationale` string that is printed as the assertion failure message**. So an
engineer triaging a live tenant-isolation failure was handed the premise the spec spends a paragraph
refuting, at the moment of maximum trust and minimum time to check.

It was caught by review, twice. It was not caught by anything mechanical, because nothing mechanical
looks at it.

## Why this one IS worth closing by construction
The reviewer's own caution is worth repeating: **do not build a gate that reads report prose** — that
would be another unfalsifiable, drift-prone guard of the kind CLAUDE.md §2.11 says this repo already
has too many of. That is not what this is.

This is the CLAUDE.md §2.8 shape — *one claim, two copies* — and unlike a prose-reading gate it is
genuinely closable: the exception row can cite the §2.2 paragraph it derives from, and the suite can
assert the citation **resolves**. A correction to one side then either updates the other or fails
loudly, rather than diverging in silence.

## Deliverable
Bind the two. One workable shape (the implementer may propose better):

- give each `KNOWN`/exception entry an explicit reference to the §2.2 exception it implements
  (its index, or a stable anchor);
- have the suite resolve that reference against the parsed §2.2 content and fail if it does not
  resolve — reusing task 141a's `parseDocumentedExistenceExceptions`, which already parses the section;
- keep the printed `rationale` derived from, or checked against, the resolved paragraph rather than
  hand-copied beside it.

**Do not** attempt to assert the two prose texts are semantically equal — that is unachievable and
would rot into a string-equality check somebody deletes. Assert the *link* resolves; that is what was
missing.

## FALSIFY (§2.11 — the point)
1. Reproduce the original drift: change §2.2's justification for exception 2 **without** touching the
   harness. Before this task, everything is green. After, it must fail loudly and name which exception
   drifted. Paste both.
2. **The blind-parse control (T-14b):** make the reference resolution match zero entries and confirm
   the suite goes RED rather than reporting "nothing to check". A binding whose failure mode is
   "resolved nothing, all clear" recreates the class one layer up — this repo has shipped ten of those.
3. Confirm §2.2 still parses to exactly **two** exceptions and the existing SEC-TENANT-04 legs still
   pass (`Tests 13 passed` at time of filing).

## Note
Task 141a's own artifacts are the model: `countDocumentedExceptionHeadings` grades the parse on the
loosest possible marker so the two graders fail in opposite directions, and `nonexistentControlOf`
refuses to run rather than run vacuously. Both are the right shape to copy.
