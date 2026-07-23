# TASK 165 — a blank cell in `ui-labels.md` seeds a blank RESERVED-namespace label and all 9 i18n gates pass

**Status:** todo
**Priority:** MEDIUM — same defect class as task 150 item 1, on the leg task 150 cannot reach. The blast radius is larger: reserved namespaces are the shared chrome of every screen, not one module's.
**Depends on:** 150, 123
**Blocks:** —
**SEC ids owned by THIS task:** none.
**Filed by:** the task-150 implementer, 2026-07-23, while falsifying item 1 (found-but-not-fixed).

## The finding

Task 150 closes the blank-value hole for **module** catalogs: `blankCatalogValues` in
`apps/mobile/test/module-catalog-coverage.test.ts` folds over `CLIENT_SCREEN_MODULES`. The **seed**
leg — the reserved namespaces (`core`, `auth`, `role`, `permission`, `sync`, `media`, `conflict`, …)
that `packages/i18n` bundles statically — has the same hole and is not covered by that fold, because
those catalogs are not in the client-screens registry at all.

**This is task 150 item 1's class, one layer up.** Item 1 was: every generalized assertion checked
that a value was *present and resolvable*, and none checked that it was *a non-blank string*, so
`''` satisfied all of them. Here the assertions are stronger — seed parity compares the catalog to
`ui-labels.md` byte for byte — but they are all **relative**: each one checks that the catalog agrees
with the doc, the generated union agrees with the catalog, and `id` agrees with `en` on key SETS. Not
one of them asks whether the value at the end of that chain is a usable label. Item 1's guard failed
because it looked at the wrong PROPERTY; this one fails because it looks at the wrong OBJECT — the
copy rather than the source. Both end the same way: a blank ships and every gate is green.

Nothing in `packages/i18n/scripts/check.mjs` tests a catalog value for emptiness. Grepped: the only
emptiness comparison in the file is `errors.length === 0`.

## Reproduction (run, not reasoned — CLAUDE.md §2.1/§2.11)

Two probes, on the real files, restored after each.

**Probe A — the catalog leg IS guarded, indirectly.** Blank a leaf directly in
`packages/i18n/catalogs/role/id.json` (`main_owner.name` → `""`), leaving the key structure intact:

```
i18n:check: FAIL  seed parity (ui-labels.md → catalogs)
  - catalogs/role/id.json has drifted from ai-docs/ui-labels.md — change the doc first, then run
    `pnpm --filter @bolusi/i18n i18n:seed` (07-i18n §7.1.5)
i18n:check: FAIL  generated key union + resources
EXIT=1
```

So a blank cannot be smuggled into a checked-in catalog. The guard is seed parity with the doc — the
catalog is only ever as good as `ui-labels.md`.

**Probe B — the SOURCE of truth is unguarded.** Blank the `id` cell of the `role.main_owner.name`
row in `ai-docs/ui-labels.md` (`| \`role.main_owner.name\` |  | Main Owner |`), then run the normal
authoring flow:

```
pnpm --filter @bolusi/i18n i18n:seed   SEED_EXIT=0
pnpm --filter @bolusi/i18n i18n:gen    GEN_EXIT=0
pnpm i18n:check
  i18n:check: PASS  seed parity (ui-labels.md → catalogs)
  i18n:check: PASS  key grammar (ui-labels.md rows)
  i18n:check: PASS  key grammar (catalogs)
  i18n:check: PASS  collision
  i18n:check: PASS  parity (id ↔ en)
  i18n:check: PASS  ICU restricted subset
  i18n:check: PASS  error-code coverage
  i18n:check: PASS  extraction
  i18n:check: PASS  generated key union + resources
  i18n:check: all 9 gates passed
CHECK_EXIT=0
```

**All 9 gates green on a shipped blank label.** Seed parity passes *because* the catalog faithfully
reproduces the blank; the id↔en parity gate compares key SETS, not values, so a blank on one side is
invisible; and the generated union is regenerated from the same blank.

## Why it matters

A blank reserved label is the task-122 symptom on the shared surface: the screen renders an empty
string where chrome should be. It is strictly worse than the module case task 150 fixed, because
`role.*` / `permission.*` / `sync.*` appear on every screen rather than one module's, and because the
only thing standing between an authoring slip in a markdown table and a shipped blank is review of a
diff whose changed cell is *empty* — the least visible diff there is.

## Fix direction (not prescriptive)

A 10th gate in `packages/i18n/scripts/check.mjs`: every seeded value is
`typeof value === 'string' && value.trim() !== ''`.

**Model it on `blankCatalogValues`** (`apps/mobile/test/module-catalog-coverage.test.ts`, task 150) —
same predicate, same reasons, and its docstring already records why each arm exists: `trim()` because
`'   '` renders as blank chrome exactly like `''`, and the non-string arm because a number, boolean
or `null` leaf yields no usable label either (`null` being how a half-finished translation pass
leaves a key it could not fill). It also returns a NAMED list rather than a boolean, which is what
lets its failure output point at the offending leaves instead of just asserting something is wrong.
Reuse that shape; the only real difference is the denominator it folds over.

Notes for whoever takes it:

- **Assert over the `ui-labels.md` ROWS, not the catalogs** — the row is what an author edits, so the
  failure message can name the row to fix. Checking catalogs only would report the symptom.
- **The gate must assert its own denominator** (count of rows read, with a floor) or it joins the
  list in CLAUDE.md §2.11 — this is precisely the shape of the key-grammar gate that was green
  because `SEED_DEFERRED_KEYS` kept the illegal keys out of what it read. Check how parked keys
  interact before assuming the denominator is the whole table.
- **Falsify it**: blank one cell, watch the new gate red and name that row; restore, watch it green.
  Positive control: a legitimately short cell (`OK`) must not red.

`packages/i18n` is CONTENDED shared code (CLAUDE.md §4) — this serializes, which is why it is a
separate task rather than an addition to 150.

## Acceptance

- A blank or whitespace-only cell in `ui-labels.md` fails `pnpm i18n:check`, naming the row.
- A short-but-real value does not.
- The gate reports how many rows it read, and reds if that count collapses.
- The falsification is reported with the observed failure text, per CLAUDE.md §2.11.
