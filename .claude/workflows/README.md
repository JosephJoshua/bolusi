# .claude/workflows — saved multi-agent orchestrations

Saved Workflow scripts for the fan-out phases (implement / review / QA). Invoke by name via the Workflow tool.

Each phase skill (`implement-task`, `review-wave`, `qa-sweep`) describes the shape; when a pattern stabilizes, save it here as a named script so the orchestration is one command.

Suggested (author as the pipeline matures):

- `review-changes` — dimensions → find → adversarially verify → file findings.
- `qa-sweep` — multi-modal search → verify → feed back into tasks.
- `implement-wave` — pipeline tasks through implement → self-verify → review.
