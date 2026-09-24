# D28 — Owner ruling: op-type labels live in the ordinary catalog for their namespace

**Date:** 2026-09-24 · **Status:** Accepted — owner decision ("labels should just live in an i18n
store thing, just like normal standard projects, don't try to do anything weird").
**Amends: 07-i18n §4.4**, which required op-type labels to be *module-provided* and forbade
`@bolusi/i18n` from carrying any op-type rows. **Amends 07-i18n §3.1**, adding `platform` to the
reserved namespaces.
**Unblocks:** task 212.

## The rule

An op-type label is an ordinary catalog key and lives wherever its namespace lives:

- namespace is reserved and platform-owned (`auth`, `platform`) → `packages/i18n/catalogs/<ns>/{id,en}.json`
- module ships its own catalog (`notes`) → alongside its other keys, as today

There is no op-type-specific mechanism. `translateOpType` still derives `<module>.opType.<camelVerb>`
and still falls back to `core.opType.unknown`; only the question of *where a row may be written*
changes.

## What the old rule cost

07-i18n §4.4 read: "each module ships its own `opType.<verb>` rows in its catalog, and `@bolusi/i18n`
carries no op-type→label table (a table would duplicate what the module already declares)."

The reasoning is sound where it applies — `notes` declares its ops and ships its catalog, so a second
table in `@bolusi/i18n` would be a copy that can drift (§2.8). The rule's defect is that it was
written as if every module ships a catalog. `auth` and `platform` are modules in `ALL_MODULES` and
declare 11 op types between them, but neither is a *client-screen* module: neither appears in
`CLIENT_SCREEN_MODULES`, so neither has a catalog to write a row into. The rule therefore did not say
"put the label in the module's catalog" for them; it said "there is nowhere this label may exist."

Observable cost, measured before the fix: 11 of the 14 declared op types resolved to the fallback, so
the Sync Status rejected list rendered `Perubahan · 14:32` — "Change · 14:32" — for every rejected
auth and platform op. The row that should tell a shop *which* change the server refused instead read
like a real label with no information in it. A rejected PIN reset displayed "Something went wrong.
Try again. / Change · 5 min ago."

## Why this shape rather than the alternatives

Two other options were available and are worse:

1. **Give `auth` and `platform` client catalogs** purely to hold labels. That satisfies the old rule
   literally while inventing a catalog-registration path for two modules that ship no screens — new
   plumbing whose only purpose is to obey a constraint, which is the "anything weird" the ruling
   rejects.
2. **Special-case op types in `@bolusi/i18n`** with a lookup table. That is the duplication §4.4 was
   right to forbid.

Following the namespace needs no new mechanism at all: `auth` was already a reserved namespace with a
catalog, and `platform` becomes one the same way every other reserved namespace works.

## Consequences

- `platform` joins `RESERVED_NAMESPACES` (`packages/i18n/scripts/catalog.mjs`). Safe: the collision
  gate (`scripts/gates.mjs`) fires only for catalogs where `isModule` is true, and no module ships a
  `platform` catalog. `auth` has been both a module id and a reserved namespace since before this.
- The requirement is enforced, not remembered: `apps/mobile/test/op-type-labels.test.ts` enumerates
  `ALL_MODULES`' declared `operations` and fails when any declared type has no row. A future module,
  or a new op type on an existing one, is covered the moment it is declared.
- No change to `translateOpType`, to the fallback, or to how `notes` ships its rows.
