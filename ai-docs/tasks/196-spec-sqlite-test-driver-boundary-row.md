# TASK 196 — spec: add the `@bolusi/sqlite-test-driver` boundary row (08 §3.3) for task 185 leg 4

**Priority:** MEDIUM — a spec-only prerequisite. Per §3.3 rule 5 + CLAUDE.md §4, the boundary
matrix is **not** edited as a side effect of implementation; the amendment that lets a brand-new
`@bolusi/sqlite-test-driver` own the `better-sqlite3` → `DbDriver` adapter is its **own** task,
landing before the package code.
**Depends on:** — (docs-only).
**Blocks:** **185 leg 4** — the `@bolusi/sqlite-test-driver` extraction (5 byte-identical driver
copies from the 2026-07-26 duplication audit) cannot land until this row exists in the spec.
**SEC ids owned by THIS task:** none.
**Filed by:** task 185 leg-4 implementer, 2026-09-01, per the umbrella row's "whose 08 §3.3
amendment must be its own spec task" note.

## Why this is its own task

`ai-docs/08-stack-and-repo.md` §3.3 is the import-boundary matrix, whose markdown half is mirrored
by `tooling/eslint/src/plugin/rules/boundaries.js` (`DB_DRIVER_OWNERS`). Rule 5 of that section
forbids editing the table as an implementation side effect — the same discipline as CLAUDE.md §4
(spec changes are their own task). Leg 4 introduces a new workspace that becomes a `better-sqlite3`
owner; the spec must sanction that edge before the guard is changed to enforce it.

## Goal (the amendment — docs only)

In `ai-docs/08-stack-and-repo.md`:

1. **§3 monorepo-layout table** — add a `@bolusi/sqlite-test-driver` row (Node, test-only): the
   shared better-sqlite3 → `DbDriver` adapter (`createDriver` + the value/row normalizers),
   extracted from the five identical copies.
2. **§3.3 boundary table** — add the row
   `sqlite-test-driver` → `db-client` (**value** — `toDbError` + the `DbDriver` interface it owns),
   `better-sqlite3`; and redirect the `harness` row's `better-sqlite3` edge to `sqlite-test-driver`
   (harness consumes the package now, not the driver directly).
3. **§3.3 hard rule 9** — document that the package is the single home for the adapter (§2.8), is
   test-only (rule 6 extends to it), its `db-client` edge is a **value** import (so it is
   test-tooling like `harness`, not type-only like `test-support` under rule 7), and the direct
   `better-sqlite3` edge now belongs to exactly **three** workspaces: `sqlite-test-driver`,
   `db-client` (its keyed test opener **and** the codegen scratch DB, 10-db §11.4 — an independent
   use that keeps db-client an owner), and `apps/mobile` (its key-recording test opener, which
   wraps `createDriver` but keeps its own `new Database` to observe every key handed to the driver).
   `core`, `modules`, and `harness` no longer import `better-sqlite3`.
4. **§2 catalog note** (line: `better-sqlite3 … Test-only; never imported by shipping packages`) —
   point at the new adapter home; the "never imported by shipping packages" claim stays true (the
   package is test-tooling, not shipping).

## Acceptance

- The four edits above are present; the doc still reads coherently (no dangling "5 copies" claim).
- The new §3.3 row and hard rule 9 name the **three** post-extraction owners exactly — this is the
  contract `DB_DRIVER_OWNERS` is falsified against in leg 4 (the map must match the prose).
- No code changes in this task; enforcement (`boundaries.js` + its test) lands in 185 leg 4.

## Depends on / ordering

Docs-only, no code deps. Lands as the **first** commit of the leg-4 branch, before the package is
created — the spec leads the enforcement, per rule 5.
