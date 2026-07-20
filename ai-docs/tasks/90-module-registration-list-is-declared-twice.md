# TASK 90 — the module registration list is two literals with nothing checking they agree

**Status:** done
**Priority:** MEDIUM — nothing is broken today (both lists hold one module and it is the same one). Filed because task 25 must edit **both** and the compiler finds neither, and because §2.8 is explicit that this is the shape to prevent.
**Depends on:** 49, 50

## The finding (task 50, 2026-07-16)

`registerModules(...)` is called from two places over two hand-maintained literals:

| # | site | list |
| - | ---- | ---- |
| 1 | `apps/server/src/deps.ts:95` — `SERVER_MODULES` (task 49) | `[platformModule]` |
| 2 | `apps/mobile/src/bootstrap/modules.ts` — `CLIENT_MODULES` (task 50) | `[platformModule]` |

Both derive the permission vocabulary, the op-type→applier map and the operation registry from their own list. **They agree today by coincidence, and nothing enforces it.**

**Task 25's own file already assumes one list**: *"add the notes manifest to **the module registration list**"* — singular. There are two. A task 25 that appends `notes` to only `SERVER_MODULES` ships a server that folds notes and a device that answers `UNKNOWN_TYPE` to its own module's ops; the reverse ships a device that folds locally and a server that rejects every push. **Both halves typecheck**, because each list is independently well-formed — and task 17 already proved `tsc` stays `EXIT=0` through a missing registration. Only a test can see it, and no test compares the two.

This is the sibling of task 53's finding (`SyncStatus` declared 3×, compiler finds zero) and of task 16's mirror lesson: a copy the boundary *requires* is legitimate; an **unguarded** copy is not.

## Why task 50 did not fix it

Unifying means editing `apps/server/src/deps.ts` while **task 17 is live in that file** (CLAUDE.md §4/§6: do not edit contended code with other agents' work in flight). Task 50 filed it and asserted its own list's denominator instead (`apps/mobile/test/bootstrap.test.ts` — `CLIENT_MODULES` has length 1, `registry.modules` is `['platform']`, permissions size 3), so the client list cannot silently empty in the meantime. The server side has the equivalent in `apps/server/test/integration/sync/platform-registration.test.ts`.

## The two candidate shapes — decide, do not split the difference

1. **ONE exported list in `@bolusi/modules`.** Its `index.ts` is still the bootstrap placeholder (`export const PACKAGE_NAME`), and this is its designed home: the package exists to hold module manifests, and both apps already may import it (08 §3.2's split-export row — `./notes` is platform-free, `./notes/screens` is RN-only and mobile-only). Both apps import `ALL_MODULES`. §2.8, no ceremony.
2. **Two lists + a gate**, if a real asymmetry emerges. None exists today: `registerModules` reads only the manifest slice (ops/permissions/appliers), and 04 §2's whole point is that an applier is dialect-neutral and runs on both engines. The screens split is a *subpath* concern, not a list concern. **Do not adopt (2) without naming the module that legitimately registers on one side only** — "they might diverge" is not such a name.

Prefer (1). If (2), the gate must be **falsified** (§2.11): add a module to one side, watch it go red.

## Docs to read

- `04-module-contract.md` §1/§3/§4 (registration; the one-list property).
- `packages/core/src/module/registry.ts` — `registerModules`'s header: *"one module list feeding three registries that previously had no common entry point (CLAUDE.md §2.8)"*. It solved this **within** a process and the duplication moved up a level.
- `apps/server/src/deps.ts` (`SERVER_MODULES`), `apps/mobile/src/bootstrap/modules.ts` (`CLIENT_MODULES` — its header states this finding).
- `apps/server/test/integration/sync/platform-registration.test.ts` — the server's denominator guard and why it drives the REAL push path over production deps. Whatever lands here must not weaken it.
- `ai-docs/tasks/49-*.md` (the server list's origin), `53-*.md` (the same class, different set), `25-*.md` (the task that must edit both).
- `testing-guide.md` T-14, T-16.

## Acceptance

- **One list, or one gate.** If (1): both apps register from the same export, and deleting a module from it turns tests red on **both** sides. If (2): a check that the two id sets agree, falsified by adding a module to one side.
- **Denominator, asserted** (T-14): the count is checked, not just "no throw". `registerModules([])` succeeds and returns a registry that folds nothing, validates nothing, and answers `undefined` to every lookup — the loop-over-an-empty-registry failure this repo has shipped eight times.
- Neither side's existing registration guard is weakened to make the unification fit.
- `@bolusi/modules` gaining a runtime export must not put an RN edge on `apps/server`'s graph — the `./notes` vs `./notes/screens` split is what prevents it, and `bolusi/boundaries` enforces it (`*/screens` importable only from apps/mobile). Confirm the server's build after the change.
