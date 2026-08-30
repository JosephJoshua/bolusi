# TASK 193 — add a type-only ui→schemas boundary exception; delete the forced enum mirror

**Depends on:** —
**Blocks:** 190
**SEC ids owned by THIS task:** none.

**Filed by:** the 2026-08-30 complexity/over-engineering audit (owner-approved cut-list, Tier 2 #6).

## Goal

`@bolusi/ui` may not import `@bolusi/schemas` (`ai-docs/08-stack-and-repo.md` §3.3, `:161`/`:175`), which forces `packages/ui/src/components/SyncStatusChip.tsx` to re-declare `OPERATION_SYNC_STATUSES` locally (a duplicated 3-element literal + an 11-line rationale comment + a runtime `Set` guard), kept honest by the cross-package parity gate. But the rule's real intent is **no zod / platform-free in ui** — and a **type-only** import erases at compile, pulling **no** zod. Precedent already exists: §3.3 **rule 7** blesses `dbClientTypeOnly` (test-support → db-client, type-only).

Add a symmetric **`uiSchemasTypeOnly`** exception; import `type OperationSyncStatus` from schemas; **delete the literal mirror + rationale comment.** Keep or drop the runtime `Set` guard per the "closed, DB-backed enum" comment (`SyncStatusChip.tsx:49-51`) — if kept, keep a **local** 3-element array but retire the **cross-package parity arm** (handed to task 190).

## Must preserve (do NOT cut)

- The **no-zod-in-ui / platform-free** guarantee. Scope the exception to **`import type` exactly** — a **value** import of schemas (which pulls zod) stays forbidden.

## Docs to read

- `ai-docs/08-stack-and-repo.md` §3.3 (boundary matrix + rule 7 precedent); `ai-docs/design-system.md` §preamble.

## Files / modules touched

- `packages/ui/src/components/SyncStatusChip.tsx` (remove mirror + comment; `import type`).
- `ai-docs/08-stack-and-repo.md` §3.3 (add `uiSchemasTypeOnly` mirroring rule 7 — **this task owns the spec edit**; convention-level, not an owner ruling, so no §6 sign-off).
- `packages/ui/test/package-hygiene.test.ts` (add the "value-import still forbidden" falsification).
- `packages/test-support/src/enum-mirror-parity.test.ts` — the ui/schemas arm is removed here; the gate shrink is task 190 (which depends on this).

## Acceptance

- ui imports `type OperationSyncStatus`; no local literal mirror or 11-line rationale remains; the spec records the type-only exception; value imports of schemas stay forbidden.

### Falsification (§2.11)

1. **Value imports still forbidden** — add a **value** import of `@bolusi/schemas` to a ui source → the package-hygiene/boundary gate must **red**. This proves the exception is type-only and the guarantee is intact.
2. **The type is really needed** — remove the type-only exception → `tsc -b` reds ui. Restore.
3. **zod not in ui's graph** — after the change, `expo export` / bundle inspection shows zod is **not** pulled into ui (the platform-free guarantee held). Run `tsc -b` between the src change and the cross-package check (memory: `bolusi-falsify-at-the-boundary` — cross-package guards falsify against DIST).
