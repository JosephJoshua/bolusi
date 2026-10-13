---
name: qa-sweep
description: Run Bolusi's continuous state, spec, adversarial, chaos, and coverage QA with reproducible findings.
---

# QA Sweep

Read `.claude/skills/qa-sweep/SKILL.md` for the search strategy, fixture
isolation, and attack-ledger. Replace Claude's `Workflow` tool with permitted
Codex agents where available; otherwise run the relevant checks locally.
Only reproducible failures produce tasks (`CLAUDE.md` §2.7); never fabricate
device or CI evidence.
