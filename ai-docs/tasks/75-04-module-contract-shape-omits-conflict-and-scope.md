# TASK 75 — `04 §3`'s registry-entry shape omits `conflict` and has no way to express `01 §6`'s tenant-scoped op

**Status:** todo
**Priority:** MEDIUM — a spec/code divergence in the contended module contract. The CODE is now correct and shipped (task 17); `04` is the owning doc and does not describe two fields it now has.
**Depends on:** —
**Filed by:** impl-17, 2026-07-16 (spec change is its own task — CLAUDE.md §4)

## The finding

Task 17 added two fields to `OperationDeclaration` (`packages/core/src/module/define-module.ts`). Both are **required by an owning doc** — neither is an invention — but **04-module-contract §3, which owns the registry-entry shape, lists neither.**

### 1. `conflict` — mandated by 01 §8.1, absent from 04 §3

`01-domain-model.md` §8.1, verbatim:

> An op type that can collide declares, in its registry entry (extends 04-module-contract §3):
> ```ts
> conflict: { key: 'note.body', severity: 'minor' }   // optional field
> ```

01 §8.1 says "extends 04-module-contract §3" — but 04 §3's shape block does not carry the key. Compare how the same situation is handled for `permissions`: **02 §3.2 explicitly obliges 04 to list it**, and 04 §1 does. `conflict` never got that treatment.

Without the field, Rule 1 has nothing to key off — it is the only thing that makes two accepted ops on one entity a collision rather than a sequence — so task 17 could not have shipped without it.

### 2. `scope` — the FACT is in 01 §6, the MECHANISM existed nowhere

`01-domain-model.md` §6's registry row for `platform.user_locale_changed`:

> Tenant-scoped (`storeId = null`): the preference follows the user to every device.

But **04 §5's runtime stamps `storeId` from the device identity for every draft** (`execute.ts`'s `AppendContext`, `append.ts:123`), and `OpDraftInput` has no `storeId`. So the fact 01 §6 states was **inexpressible**: no command handler could emit the tenant-scoped op the spec requires. 01 §6 states the fact and names no mechanism.

Task 17 declared it on the op TYPE (`scope?: 'store' | 'tenant'`, default `'store'`), resolved by `ctx.op()` from the registry — the same shape and the same rationale `schemaVersion` already uses (ctx.ts: "Resolved from the 04 §3 operation registry — never defaulted, never caller-supplied"), because scope is a property of the type, not of the emission. A handler that could state its own scope could record an op in a store it was not authorized in.

## Why this is filed and not fixed

CLAUDE.md §4: "Do not edit spec content as a side effect of implementation — spec changes are their own task." Both fields ship in code with their owning-doc citation in a comment; `04 §3`/`§1` is the doc that must describe them, and `testing-guide §1`'s change-control rule ("the owning doc changes first, then the code") means this one is already inverted and should be squared deliberately rather than by an implementer editing a contended spec mid-task.

## Scope

- `04-module-contract.md` §3: add `conflict?: { key, severity }` to the registry-entry shape, citing 01 §8.1 as the owner of its semantics (mirroring how §1 lists `permissions` and points at 02 §3).
- `04-module-contract.md` §3: add `scope?: 'store' | 'tenant'` (default `'store'`), citing 01 §6.
- `04-module-contract.md` §5.1 step 4: the envelope-completion step currently implies `storeId` always comes from the device identity. It now comes from the type's declared scope, which resolves to the device's store for every `'store'` type. State it.
- **Decide the open question this exposes:** is `scope` the right mechanism, or should 01 §6's tenant-scoping be expressed some other way? Task 17 chose the `schemaVersion` precedent deliberately, but the owner of 04 should ratify or replace it. If replaced, `packages/core/src/platform/operations.ts`'s `scope: 'tenant'` and `ctx.op()`'s resolution are the two call sites.

## Verify (don't assume)

The claim "04 §3 does not list these" was checked by reading 04 §3's shape block directly. Re-read before writing — three premises have been refuted on this project by an agent trusting an upstream summary.
