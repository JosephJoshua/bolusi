# TASK 71 — the ledger's Status is written in two places and the merge procedure touches one; make the writeback single-action (task 66's gate is only the backstop)

**Status:** todo
**Priority:** **MEDIUM** — task 66 shipped the *detector* (a post-merge gate over `_index.md` vs the task files). This is the *writer*. Without it the gate goes red on every merge until someone hand-edits a file, which is precisely the check people learn to route around (CLAUDE.md §2.10's earned `--no-verify` instinct).
**Depends on:** 66
**Blocks:** —
**SEC ids owned by THIS task:** none

## The finding

A task's Status lives in **two** places: the `status` column of its `_index.md` row and the file's
`**Status:**` line. The orchestrator's merge / state-change procedure updates the **index row** and
never the file — so *every* merged task drifts (measured: the whole 28-task backlog had drifted
`file: in-review` / `index: done` this session; the orchestrator bulk-corrected it, and it
re-accumulated to task 49 by the next wave). The drift is 100% of merges, not an occasional slip,
because a human step that must touch two places will eventually touch one.

Task 66's gate (`packages/test-support/src/ledger.ts`) now **catches** this post-merge. But a gate
that fails on every merge until hand-fixed is a gate with a short life. The durable fix is to make
the two locations unable to disagree.

## The fix (recommended: single-action writeback)

Add a helper — `pnpm task:status <id> <status>` (a small `scripts/*.mjs`) — that edits **both** the
`_index.md` row cell **and** the file's `**Status:**` line in one invocation, validates the status
against the five legal values, and refuses an unknown id/status. Wire it as **the** documented
merge / state-change step. One action ⇒ the two locations cannot drift; task 66's gate stays as the
backstop for any hand-edit that bypasses it.

- Must handle the **27a/27b → 27-device-gates.md** split: two rows, one file. Updating `27a` writes
  the `27a` row cell and the single file line; the file then legitimately matches one of its rows
  (task 66's gate already permits exactly this).
- The documented merge step belongs in **CLAUDE.md §5** or the **merge / `review-wave` workflow
  doc** — a spec/workflow change, so it is proposed here and made by whoever owns that surface, not
  edited silently as a side effect (CLAUDE.md §4). This task owns landing that documentation
  alongside the helper.

## The end-state (bigger, deferred): a single source of truth

The drift class disappears entirely if Status lives in exactly one place — e.g. drop the row's
`status` column and derive "what's left" (and sec-meta.ts's `staleAllowlist` check, which reads the
file `**Status:**`) from the files; or generate the index from the files' front matter so it cannot
disagree with them. This is the correct end-state but a **cross-cutting** change: it touches the
index format, the `decompose-tasks` index template, CLAUDE.md §2.6's "`_index.md` + per-task Status
lines" wording, and `sec-meta.ts`'s consumer — and every agent reads the index constantly. It needs
buy-in and its own wave; the single-action writeback above is the cheap floor that stops the bleeding
now.

## Acceptance

- `pnpm task:status <id> <status>` updates both the `_index.md` row and the file `**Status:**`,
  validates against `todo · in-progress · in-review · done · blocked`, and errors on an unknown id
  or status. Falsify: run it, confirm both locations changed; run task 66's gate, confirm green.
- The documented merge step (CLAUDE.md §5 / merge workflow) names the helper as the writeback.
- Task 66's ledger gate remains green (this task must not introduce drift).
