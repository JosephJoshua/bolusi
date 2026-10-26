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
3. Configure the cloud environment for Node 22, Corepack/pnpm and frozen-lockfile
   installation (the repo's SessionStart hook installs gitleaks for the commit
   hook). Tests need Docker for real PostgreSQL. If unavailable, use GitHub CI or an appropriate local thread and report the limitation explicitly.
4. Have Claude read `docs/product-direction.md` and `docs/product-scope.md`, then
   discuss the next useful repair slice with you before implementation. It should
   bring the relevant earlier ideas from `docs/product-reference/` into that
   conversation and challenge choices that are unclear or unnecessarily complex.
   Use additional threads when useful; coordinate migrations and shared edits.
5. Use memory for priorities and preferences. Keep the whole product direction,
   current scope agreements and useful earlier proposals in the repository so
   they travel with code and remain inspectable outside this account. Memory does
   not automatically contain removed documents or local, unpushed changes.

The [official introduction](https://claude.com/resources/articles/projects-redesigned)
explains coordination, shared memory, and per-thread branches. Consult the
[Projects guide](https://code.claude.com/docs/en/claude-projects) for current beta
cloud/local execution behavior; account capabilities can differ.

## Paste into project instructions

```text
Build Bolusi into a useful offline-first ERP for our stores in West Papua, with
the longer-term ambition of serving other businesses as multi-tenant SaaS.
Work in JosephJoshua/bolusi, starting from main. Read README.md and CLAUDE.md.
Read docs/product-direction.md for the whole vision, milestones and later ideas.
The first release is the complete repair journey in docs/product-scope.md;
the platform and Notes demo are not that finished product.

When I ask to implement a new scope, first grill me on the consequential product
choices. Read relevant earlier ideas in docs/product-reference/ and current scope
decisions; use them as a starting point, not a frozen specification. Ask focused
questions in small rounds, test assumptions with real shop scenarios, challenge
unnecessary complexity and recommend simpler options. Discuss the useful boundary,
exceptions, permissions, offline behavior and acceptance. My ideas can change.
Record the resulting agreement briefly, then implement once material choices are
settled and the work is authorized. Do not repeat settled questions or turn routine
fixes into a discovery process. An old PRD's Must label is not a new approval.

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

The old `ai-docs/` workflow, task database, phase skills, review-wave playbooks,
daily CI schedules, SEC bookkeeping, and duplicate suite execution were removed.
The full product direction and earlier PRD discussions remain in `docs/`, with
generated task breakdowns removed and older designs marked as proposals to
revalidate. Git at `06b063b` retains the other old references. Behavioral tests,
security controls, native tooling, and migrations remain.

October's repair scope and roadmap direction were carried forward from the
uncommitted local owner notes, which were newer than `06b063b`.
Former open items appear in `docs/architecture.md`; retiring task numbers does not
resolve those issues. Private transcript archives stay local, outside Project uploads.

After changing CI job names, check GitHub branch protection for retired required
jobs. Require the new automatic checks; manually dispatched native jobs should
not leave every PR waiting indefinitely.

The required checks for this workflow are `checks` and `secrets` (GitHub Actions).
Keep the `main protection` ruleset's pull-request, deletion and non-fast-forward
protections. Update required check names alongside future workflow changes.
