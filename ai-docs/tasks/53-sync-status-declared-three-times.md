# TASK 53 — `SyncStatus` is declared three times and the seams are `string`; the compiler finds zero of them
**Status:** done
**Priority:** LOW–MED — nothing is broken today (a 3-member set unlikely to change). Filed because it is the exact class the inverse sweep exists to find, and because **one copy is avoidable and one is not** — they need different fixes.
**Depends on:** 15

## The finding (inverse enum sweep, 2026-07-15)

`03-state-machines.md §3`'s closed set `local | synced | rejected` has **three independent declarations**:

| # | site | forced? |
| - | ---- | ------- |
| 1 | `packages/schemas/src/bookkeeping.ts:7` — `SYNC_STATUSES = [...] as const` → `zSyncStatus` → `type SyncStatus` | **canonical** |
| 2 | `packages/core/src/state-machines/op-sync-status.ts:8` — `export type OpSyncStatus = 'local' \| 'synced' \| 'rejected'` | **NO — avoidable.** `@bolusi/core` already depends on `@bolusi/schemas` (`"@bolusi/schemas": "workspace:*"`). It **can import `SyncStatus` today** and re-declares the literal instead. |
| 3 | `packages/ui/src/components/SyncStatusChip.tsx:14` — `export type OperationSyncStatus = …` + a runtime `VALID` Set | **YES — boundary-forced.** `@bolusi/ui`'s deps are `@bolusi/i18n` + expo/react only (08 §3.3); it *cannot* import core or schemas. And it is **honest**: its docblock cites *"03-state-machines §2 enum registry"*. |

**The compiler cannot catch a divergence, because the seam is untyped:**
- `packages/db-client/src/generated/db.ts:135` → `syncStatus: Generated<string>`
- `packages/core/src/oplog/bookkeeping.ts:100` → `syncStatus: string`

**Add a member to §3 and you must find three places; the compiler finds zero.** A status round-trips through the DB with no type anywhere on the path.

**Why the forward sweep is blind to this by construction:** it asks *"does each member have a producer?"* → **yes, three times over.** Every member is live. Only asking the inverse — *what does the code declare that the registry doesn't know about?* — sees a set declared three ways.

## The two copies need different fixes — do not treat them alike

- **(2) core: just import it.** No boundary forces the copy; `@bolusi/core` depends on `@bolusi/schemas` already. Delete the literal, import `SyncStatus`. §2.8, no ceremony.
- **(3) ui: forced — so register it and gate it.** This is the **task-16 mirror shape**: a copy the boundary rule *requires*. A forced mirror is legitimate; an **unguarded** forced mirror is not. Ship a check that the ui set and the canonical set agree, and **falsify it** (§2.11): add a member to one side, watch it go red. Note task 16's mirror lesson — its own header said *"the two must be kept in sync"*, and §2.11 is explicit that guards get closed **by construction, not by asking people to be careful**.

**Also in scope, same shape, low stakes:** `OP_SOURCES` (`packages/schemas/src/envelope.ts:10`) is re-declared as `SOURCES` in `packages/test-support/src/crypto/envelope-generator.ts:88`. Test-support, so cheap — but if a gate is being built for (3), it costs nothing to cover this too.

## Docs to read

- `03-state-machines.md` §2–§3 (the registry + the closed set), §13 (exclusions).
- `08-stack-and-repo.md` §3.3 — the boundary rule that **forces** (3). Read it before "fixing" the ui copy by importing; that import is illegal for a reason.
- `packages/schemas/src/bookkeeping.ts:7` (canonical), `packages/core/src/state-machines/op-sync-status.ts:8`, `packages/ui/src/components/SyncStatusChip.tsx:14`.
- `ai-docs/tasks/47-*.md` — the mirror-vs-production lesson (a hand-copied mirror that made a gate inert). Same class.
- `CLAUDE.md` §2.8; `testing-guide.md` T-11, T-14.

## Skills

- `superpowers:test-driven-development`, `superpowers:verification-before-completion`.
- Worktree isolation per CLAUDE.md §2.3 — first step: `git branch --show-current`; STOP if on `main`.

## Files / modules touched

- `packages/core/src/state-machines/op-sync-status.ts` (delete the literal, import). **`@bolusi/core` contended** — serialize; **coordinate with task 15**, which owns the sync loop and is the live consumer.
- `packages/ui/src/components/SyncStatusChip.tsx` + the gate. **`packages/ui` contended** (tasks 33/24 have items there).

## Acceptance

- **Reproduce first** (T-11): add a 4th member to the canonical `SYNC_STATUSES` and confirm **nothing** goes red in core or ui — that silence is the bug. If something fails, the premise changed; report it.
- **(2)** core imports `SyncStatus`; the literal is gone. Confirm task 15's sync loop still typechecks against it.
- **(3)** the ui mirror stays (the boundary requires it) but is **gated**: the sets must agree, and the gate goes **red** when they don't. **Assert its denominator** (T-14) — it names how many members it compared and fails on zero. A gate over an empty set is the failure this repo has shipped eight times.
- **Do not "fix" ui by importing schemas** — that violates 08 §3.3. If you believe the boundary is wrong, that is a spec change and its own task (§4).
- `pnpm test`, `pnpm lint`, `pnpm typecheck` green. **Read the output, not the exit code** (§2.1).

## Note

Found by the inverse enum sweep — the direction that was never run until someone asked *"what does the code declare that the spec doesn't know about?"* The forward sweep had just confirmed all 27 registry members live, correctly; a triple-declaration is invisible to it because every copy is a producer.

Worth carrying: the ui copy is **honest** — its docblock cites the registry it mirrors. That's the difference between this and the mirrors that caused real trouble (task 47's watermark mirror, which silently made a PG16 gate inert). **An acknowledged mirror with a gate is fine; the sin is the mirror that doesn't say so, or says so and isn't checked.**
