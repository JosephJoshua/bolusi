---
name: implement-task
description: Implement a Bolusi task using its specs, worktree isolation, verification, and status lifecycle.
---

# Implement Task

Read `.claude/skills/implement-task/SKILL.md`, the specific task file, and the
relevant doc-router rows. The Claude `Workflow` tool in that skill is not a Codex
tool; use permitted parallel tools only when the active instructions authorize
them. Check `pwd`, branch, and worktree ownership first; never let a subagent
write to the main checkout. Finish with review-wave before merging.
