# TASK 71 — the ledger's Status is written in two places and the merge procedure touches one; make the writeback single-action (task 66's gate is only the backstop)

**Status:** in-review
**Priority:** **HIGH — must land BEFORE tasks 17 or 18 merge** (review-66's hard sequencing constraint: a chronically-red ledger gate masks the next real collision inside an already-red suite — this repo's "a loud bug masks silent ones", T-14h, turned against the gate meant to fix it). MEDIUM by blast radius, — task 66 shipped the *detector* (a post-merge gate over `_index.md` vs the task files). This is the *writer*. Without it the gate goes red on every merge until someone hand-edits a file, which is precisely the check people learn to route around (CLAUDE.md §2.10's earned `--no-verify` instinct).
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

## Outcome (2026-07-16) — single-action writeback shipped; drift is closed by construction

**Shipped:** `pnpm task:status <id> <status>` (`scripts/task-status.mjs`) edits the `_index.md` row
cell **and** the file `**Status:**` line in one call, validated before any write so a partial
"index updated, file not" is unreachable. Wired into **CLAUDE.md §5** as *the* state-change step
(never hand-edit). Grammar (the five statuses + the row/file regexes) is a **pinned mirror** of the
gate's — `packages/test-support/src/task-status.test.ts` asserts it equals `ledger.ts`'s exports, so
the JS-CLI / TS-gate boundary (same shape as `error-code-registry.mjs`) cannot drift silently.

**Falsified, not asserted (§2.11):**
- *Drift reproduced then closed (T-11):* hand-edited row 71 → `in-review` (file left `in-progress`),
  ran `ledger.test.ts` → **RED** (`file says "in-progress", _index.md row(s) say 71=in-review`,
  EXIT=1); one `pnpm task:status 71 in-review` → both reconciled → **GREEN** 13/13, EXIT=0.
- *Validation:* `task:status 999 done` → EXIT=1 "no _index.md row"; `task:status 17 frobnicate` →
  EXIT=1 "unknown status"; both touched no task file (tree clean).
- *The pin is load-bearing:* added a 6th status to the mirror → the pin test went **RED**; reverted → green.
- *The 27a/27b split (T-12):* live `task:status 27a in-progress` moved the `27a` cell and the shared
  `27-device-gates.md` line, left `27b` byte-identical, gate green; restored to `todo` with zero diff.
  The unit test additionally feeds the writer's output through `auditLedger` and asserts it passes.

**Single-source-of-truth end-state (assessed, deliberately not built now):** the drift *class* only
disappears if Status lives in one place — generate the `_index.md` `status` column from the files'
`**Status:**` (or vice-versa). That is strictly better but **cross-cutting**: it changes the index
format, the `decompose-tasks` template, §2.6's "`_index.md` + per-task Status lines" wording, and
`sec-meta.ts`'s `staleAllowlist` consumer, and every agent reads the index constantly — it needs its
own wave and buy-in. It is already carried as "The end-state (bigger, deferred)" above and in task
66; not re-filed as a new number (avoiding the very collision churn 66/71 exist to kill). The
single-action writeback is the cheap floor that stops the bleeding today and is *not* made redundant
by the eventual generator: the gate remains the backstop for hand-edits either way. Not cheaper than
the helper, so not done now.
