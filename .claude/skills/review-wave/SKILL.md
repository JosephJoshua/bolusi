---
name: review-wave
description: Use before merging any task. Runs multi-agent review — independent reviewers per dimension, then adversarial verification of each finding so only real issues survive — and feeds confirmed findings back into tasks/. Invoke after implement-task, before merge.
---

# Review Wave

Never merge without a separate review pass.

## Process (use the Workflow tool for fan-out)

1. **Dimensions** — spawn independent reviewers per lens: correctness, security, tests, spec-conformance, simplicity. Each is blind to the others.
2. **Adversarially verify** each finding — a second agent tries to **refute** it, defaulting to "not a real bug" unless it can produce a concrete failing input/state. Kill findings that can't be reproduced.
3. **Rank** survivors by severity; discard nits that don't change behavior.
4. **Feed back** — confirmed non-trivial findings become task files (CLAUDE.md §2.7), not lost review comments.

## Rules

- Verify ground truth — reviewers read the actual diff/output, not a description of it.
- Reject on: missing tests, security-checklist gaps, invented statuses, asserting UI copy, scope creep.
- The merge gate = a clean review + tests passing + a separate agent's sign-off.

## Done when

Confirmed findings are fixed or filed and a separate agent signed off. Merge from a clean integration worktree (not the main checkout).
