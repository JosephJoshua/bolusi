---
name: review-wave
description: Use before merging any task. Runs multi-agent review — independent reviewers per dimension, then adversarial verification of each finding so only real issues survive — and feeds confirmed findings back into tasks/. Invoke after implement-task, before merge.
---

# Review Wave

Never merge without a separate review pass.

## Process (use the Workflow tool for fan-out)

1. **Dimensions** — spawn independent reviewers per lens: correctness, security, tests, spec-conformance, simplicity, **duplication**. Each is blind to the others. The duplication lens asks exactly two questions: does this change hand-roll something that already exists in the repo (Grep for the obvious keyword before answering "no"), and does it copy a ≥20-line block from a sibling file? An "aware copy" — one that cites its twin in a comment — is a finding, not an excuse: the 2026-07-26 audit found the citing comment is how copies drift (`severity()` diverged between two Verdict enums that linked to each other).
2. **Adversarially verify** each finding — a second agent tries to **refute** it, defaulting to "not a real bug" unless it can produce a concrete failing input/state. Kill findings that can't be reproduced.
3. **Rank** survivors by severity; discard nits that don't change behavior.
4. **Feed back** — a confirmed finding **that reproduces** becomes a task file (CLAUDE.md §2.7), not a lost review comment. One that survived step 2 only as "real, but nothing currently fails" is **not filed**: record it as a comment at each site naming the source of truth, and say so in the report. A confirmed duplication finding that _does_ reproduce becomes an **extraction task** naming every copy by path; one that doesn't is a comment at each copy. Filing the un-failing ones is how the task list became a worry log — see §2.7 for the count.

## Rules

- Verify ground truth — reviewers read the actual diff/output, not a description of it.
- Reject on: missing tests, security-checklist gaps, invented statuses, asserting UI copy, scope creep.
- The merge gate = a clean review + tests passing + a separate agent's sign-off.

## Done when

Confirmed findings are fixed or filed and a separate agent signed off. Merge from a clean integration worktree (not the main checkout).
