# TASK 123 — module i18n catalog registration is a hand-maintained per-module call, not driven by the module list: the next module with screens can still forget it and ship English chrome

**Status:** done
**Priority:** LOW-MEDIUM — the acute defect (notes) is fixed (task 122); this closes the CLASS so it cannot recur silently. Not user-visible today (notes is the only module with screens). Becomes live the moment a second module ships a screen.
**Depends on:** 122 (the direct fix + the `registerModuleCatalogs` seam), 90 (`ALL_MODULES`, the single module list)
**Blocks:** honest "the next module can't forget its catalog" claim
**SEC ids owned by THIS task:** none.
**Filed by:** impl-122, 2026-07-21, as the explicit generalization deferred by task 122 (per its Deliverable: "ship the direct call now and file the generalisation").

## The finding

Task 122 fixed the acute bug — `registerNotesCatalog` had zero production callers, so `notes.*` chrome rendered in English — by adding `apps/mobile/src/bootstrap/module-catalogs.ts`'s `registerModuleCatalogs()`, called from BOTH real entries (`bootstrapI18n` on native, `index.web.tsx` on web). That fixes notes. It does NOT fix the class: `registerModuleCatalogs` is a hand-maintained list of one. A future module that ships screens and a catalog must remember to add its line there, and NOTHING fails if it doesn't — the module's `*.` chrome just falls back to the humanized English key, invisible to every mounted-screen test whose harness registers the catalog itself (the exact §2.11 blind spot task 122 documents).

The standing question this leaves open: *"who binds the NEXT module's catalog in production? whoever remembers."* That is the shape this repo keeps re-shipping.

## Why it wasn't done in 122 (the constraint to respect)

The obvious home — `@bolusi/modules`' `ALL_MODULES` (the ONE registration list, task 90) — is **platform-free by design** (08 §3.2): it imports only the manifests and must not reach `./screens`. But:
- the registrar (`registerNotesCatalog`) lives in the **RN-only** `@bolusi/modules/notes/screens` surface (boundary rule 3 — importable only from apps/mobile), and
- the catalog JSON lives OUTSIDE `@bolusi/modules`' compiled `rootDir` (`packages/modules/<id>/i18n/`), handed in by the composition root by deliberate design (see the header of `packages/modules/src/notes/screens/i18n.ts`).

So wiring catalogs into `ALL_MODULES` is a cross-package refactor touching the module contract, not a one-liner — which is why 122 shipped the direct call and filed this.

## Deliverable (design, then build)

Make the set of module catalogs derivable from a single source so a new module CANNOT silently omit its catalog. Candidate shapes (pick one in review):
1. A parallel **client-screens registry** in apps/mobile (`{ moduleId, registrar, catalogs }[]`) that `registerModuleCatalogs` folds over, with a test asserting its module-id set EQUALS `ALL_MODULES`' screen-bearing subset (so adding a module to `ALL_MODULES` without a catalog row reds a test — the T-14 denominator move).
2. A platform-free **catalog descriptor** on the module manifest (`i18nCatalogs?: { id, en }` as plain JSON refs) that `@bolusi/i18n` or the composition root merges generically, keeping the RN registrar out of the platform-free graph.
- Whichever shape: the guard must be **load-bearing** (§2.11) — a module added without its catalog must turn a committed test RED, and that red must be witnessed.
- Update 07-i18n §3.3 to state the chosen mechanism (it currently says "the runtime merges every catalog" without saying who calls it for module namespaces).

## Falsification (required)

Add a module (or a fixture module) to the registry WITHOUT its catalog and watch the coverage test go RED; restore; green. Report verbatim. A generalization whose omission is silent is worse than the per-module call it replaces.

## Constraints

Touches `@bolusi/modules` (contended, platform-free) and/or `apps/mobile` boot + the i18n package. Coordinate serialization (CLAUDE.md §4 — shared packages). Do NOT regress task 122's fix: notes chrome must stay Indonesian on both entries throughout.
