---
name: implement-task
description: Use to build a task from ai-docs/tasks/. Covers the parallel, worktree-isolated implementation workflow with teammate agents and the Workflow tool for fan-out. Enforces reading only the task's router rows, the smallest complete slice, tests, and worktree safety. Invoke review-wave before merging.
---

# Implement a Task

## Setup

1. Read the task file + **only** its listed router rows (not unrelated specs).
2. Load the skills the task lists.
3. State which files / modules you'll touch before editing.

## Build

4. Smallest complete vertical slice. No scope expansion.
5. Add tests per the task's Acceptance: permission checks, state transitions (valid + invalid), edge/entitlement behavior, idempotency, soft-delete. Test quality: public behavior only, unique value per case, never assert UI copy.
6. Update the owning doc if behavior changed (same commit).
7. Atomic commits (CLAUDE.md §2.4).

## Parallel / teammates (Workflow tool)

- Spawn implementation agents in **isolated worktrees**. Every spawned agent's FIRST step: `git branch --show-current` / `pwd` — if on `main` or not its own worktree, STOP and report. **Put this in the agent's prompt.**
- Different modules → parallel-safe. Contended shared packages → serialize (CLAUDE.md §4).
- Use the Workflow tool to pipeline: implement → self-verify → hand to review.

## Done when

Slice complete, tests pass, docs updated, committed on the task branch. Flip the task Status in `_index.md`, then invoke **`review-wave`**.
