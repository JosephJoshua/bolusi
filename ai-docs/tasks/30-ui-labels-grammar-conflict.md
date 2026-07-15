# TASK 30 — resolve 3 `ui-labels.md` keys that violate the 07-i18n §3.1 key grammar
**Status:** todo
**Depends on:** 22

## Goal

Task 22 built the namespace-grammar gate exactly to `07-i18n.md` §3.1 (keys are `<namespace>.<screen>.<label>`, ≥3 segments) and it immediately rejected three keys that `ui-labels.md` ships:

| key | segments | needed by |
| --- | --- | --- |
| `auth.switchStore` | 2 | annotated v1 (store switcher deferred — roadmap) |
| `sync.pullToRefresh` | 2 | v0 — tasks 23/24 |
| `conflict.banner` | 2 | v0 — tasks 18/23/24 |

Two docs disagree and both claim authority: 07 §3.1 owns the grammar, ui-labels owns the catalog. Task 22 correctly refused to silently rename spec content mid-implementation (CLAUDE.md §4: spec changes are their own task) and parked all three in `SEED_DEFERRED_KEYS` with `TODO(spec-conflict)`. That parking is a stopgap: `sync.pullToRefresh` and `conflict.banner` are real v0 copy, and the tasks that need them are downstream.

Decide and land it: either rename the keys to satisfy the grammar (e.g. `sync.banner.pullToRefresh`, `conflict.banner.title`), or amend §3.1 to permit 2-segment keys for namespace-level singletons. **Recommendation: rename.** The grammar's value is that a key's namespace and screen are mechanically derivable; a 2-segment exception costs that for three strings. `auth.switchStore` is v1-deferred anyway (roadmap) — annotate or drop it rather than inventing a screen for it.

Whichever way it goes, one doc changes and the other follows, then `SEED_DEFERRED_KEYS` empties.

## Docs to read

- `07-i18n.md` — §3.1 (the key grammar and its reserved namespaces; the owning doc for the rule).
- `ui-labels.md` — the three key rows plus their surrounding sections (the owning doc for the catalog).
- `roadmap.md` — the store-switcher deferral, which decides `auth.switchStore`'s fate.

## Skills

- `superpowers:verification-before-completion` — the gate passing with an empty `SEED_DEFERRED_KEYS` is the evidence.
- Worktree isolation per CLAUDE.md §2.3 — first step: `git branch --show-current`; STOP if on `main`.

## Files / modules touched

- `ai-docs/ui-labels.md` and/or `ai-docs/07-i18n.md` §3.1 — one of them changes; the other is cross-referenced.
- `packages/i18n/` — `SEED_DEFERRED_KEYS` emptied; catalogs reseeded from the doc (the seed is mechanical — do not hand-edit catalog JSON).

## Acceptance

**Observable done-condition:** `pnpm i18n:check` passes with **`SEED_DEFERRED_KEYS` empty** — no parked keys, no `TODO(spec-conflict)` left in the package.

- The seed-parity gate passes: catalogs still derive mechanically from `ui-labels.md`. If keys were renamed, they were renamed **in the doc** and reseeded — never renamed in the catalog alone, which would break parity and re-introduce the drift the gate exists to prevent.
- Every reserved namespace in 07 §3.1 and every key in ui-labels satisfy one grammar; the docs do not contradict each other after this task.
- `auth.switchStore` has an explicit disposition recorded (renamed / dropped / annotated v1 per roadmap) — not left ambiguous.
- `pnpm test` and `pnpm lint` green.
- If §3.1 is amended instead of the keys renamed, the amendment states the exception precisely (what qualifies as a namespace-level singleton) so the gate can encode it — an exception the gate cannot express is not a decision.
