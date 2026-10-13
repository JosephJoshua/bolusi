---
name: review-wave
description: Independently review Bolusi task changes before merge and verify substantive findings adversarially.
---

# Review Wave

Read `.claude/skills/review-wave/SKILL.md` and `.claude/review-model.md` for
review dimensions, evidence, and sign-off. Substitute permitted Codex parallel
agents for Claude's `Workflow` tool; if independent agents are unavailable,
stop before the merge rather than mislabeling self-review as independent.
Treat a finding as a new task only when it has a reproducible failure per
`CLAUDE.md` §2.7. Inspect actual command output and falsify guards.
