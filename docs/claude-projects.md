# Claude Code Projects (Beta)

Researched on 2026-10-25. This targets Projects in the **Code tab** of Claude
Desktop, not the older Chat Projects workflow.

## Divide responsibilities

| Place                        | Purpose                                                     |
| ---------------------------- | ----------------------------------------------------------- |
| Project conversation/threads | Priorities, research, coordination, progress                |
| Project instructions         | Outcome, working preferences, authorization boundaries      |
| Project memory               | Context and decisions carried between threads               |
| Git repository               | Source, migrations, tests, setup, durable product decisions |
| Library                      | Selected external references and useful artifacts           |

Cloud threads load repository `CLAUDE.md`; they do not automatically load repository
skills or `.claude/settings.json` hooks/settings. Project memory is separate from
local Claude Code memory. Uploads are copies, so use the connected repository for
changing source and docs. See the [official Projects guide](https://code.claude.com/docs/en/claude-projects).

## Setup

1. Create a Code Project connected to `JosephJoshua/bolusi`. Start from `main`
   once this simplification lands there. Cloud clones cannot see unpushed local work.
2. Paste the brief below into Project settings → Memory → Project instructions.
3. Configure the cloud environment for Node 22, Corepack/pnpm, gitleaks for the
   commit hook, and frozen-lockfile installation. Tests need Docker for real PostgreSQL. If unavailable, use GitHub
   CI or an appropriate local thread and report the limitation explicitly.
4. Start with one useful repair slice. Let the coordinator organize additional
   threads when needed; coordinate overlapping migrations and shared edits.
5. Use memory for priorities and preferences. Keep accepted business rules in
   `docs/product-scope.md` so they travel with code and remain inspectable outside
   this account.

The [official introduction](https://claude.com/resources/articles/projects-redesigned)
explains coordination, shared memory, and per-thread branches. Consult the
[Projects guide](https://code.claude.com/docs/en/claude-projects) for current beta
cloud/local execution behavior; account capabilities can differ.

## Paste into project instructions

```text
Build Bolusi into useful offline-first repair software for our stores in West Papua.
Work in JosephJoshua/bolusi, starting from main. Read README.md and CLAUDE.md.
The first release is the complete repair journey in docs/product-scope.md;
the platform and Notes demo are not that finished product.

Prioritize usable business workflows. Keep changes small and reuse existing code.
Avoid speculative abstractions, extra process, and self-maintaining check systems.
Use threads for independently useful work and coordinate shared migrations.
Do not generate work merely because an old document suggests future drift.

Use project memory for working context and preferences. Record enduring scope
changes briefly in the repository. Verify implementation and test status from
the actual branch and output, rather than memory or another thread's summary.

Run relevant checks. Report what changed, what passed, and what is unverified.
Review substantial/sensitive changes proportionately. There is no mandatory
phase pipeline, task ledger, agent quota, SEC inventory, or daily QA sweep.

Make routine reversible decisions and continue authorized work. Ask about genuine
product ambiguity or missing access. Prepare reviewable changes before asking for
necessary final authorization. Do not deploy or destroy data without approval.
Open focused PRs; merge or publish when authorized in the project conversation.
```

## Retired machinery

The old `ai-docs/` tree, task database, phase skills, review-wave playbooks, daily
CI schedules, SEC bookkeeping, and duplicate suite execution were removed.
Git at `06b063b` retains old references. Behavioral tests, security controls,
native tooling, and migrations remain.

October's repair scope was carried forward from the uncommitted local decision.
Former open items appear in `docs/architecture.md`; retiring task numbers does not
resolve those issues. Private transcript archives stay local, outside Project uploads.

After changing CI job names, check GitHub branch protection for retired required
jobs. Require the new automatic checks; manually dispatched native jobs should
not leave every PR waiting indefinitely.

Checked on 2026-10-25: the active `main protection` ruleset (ID `23824630`)
requires 15 former CI job names. When publishing this change, replace only its
required-status-check list with `checks` and `secrets` (GitHub Actions), preserving
its pull-request, deletion and non-fast-forward protections. Coordinate the update
with the workflow publication; changing it beforehand would block the old workflow.
This local migration has not changed the remote ruleset.
