// CLIENT module registration (04-module-contract §1/§3/§4; 02-permissions §3.2).
//
// The client mirror of `SERVER_MODULES` (apps/server/src/deps.ts). `registerModules` derives the
// permission vocabulary, the op-type→applier map AND the operation registry from THIS ONE list, so
// the device can never validate a type it cannot fold, or fold one it never validated (§2.8).
//
// ── WHY A SECOND LIST EXISTS, AND WHY THAT IS A FINDING RATHER THAN A DESIGN ───────────────────
// This is the second `[platformModule]` literal in the repo; the server holds the first. Both sides
// must register the same manifests, and task 25 will have to append `notes` to BOTH — a two-place
// edit with nothing checking they agree, which is the shape §2.8 exists to prevent. The proper fix
// is ONE exported list (`@bolusi/modules` is its designed home — its index is still a placeholder),
// and it is not done here because it means editing `apps/server/src/deps.ts` while task 17 is live
// in that file (CLAUDE.md §4/§6: do not edit contended code with other agents' work in flight).
// Filed as a task rather than left as a comment. `modules.test.ts` asserts the denominator so the
// list cannot silently empty in the meantime.
//
// ── THE DENOMINATOR IS THE POINT (T-14) ───────────────────────────────────────────────────────
// `registerModules([])` succeeds and returns a registry that folds nothing, validates nothing and
// answers `undefined` to every lookup. A bootstrap looping over it reports green having done
// nothing — this repo's signature failure, shipped eight times. So the count is asserted, not
// assumed, and `bootstrap.test.ts` drives the REAL list rather than a hand-built one.
import { platformModule, type AnyModuleDefinition } from '@bolusi/core';
import { notesModule } from '@bolusi/modules/notes';

/**
 * The modules this device registers.
 *
 * `platform` (conflicts + user prefs) is the only one at v0. `notes` lands with task 25; `auth`'s
 * appliers with task 43. Both append here — and to `SERVER_MODULES`.
 *
 * The cast mirrors `apps/server/src/deps.ts`'s: `AnyModuleDefinition<DB>` is contravariant in `DB`
 * (`apply(db: Kysely<DB>, …)`), so two concrete modules over different schemas are mutually
 * unassignable and a heterogeneous list cannot be built without it. `registerModules` reads only
 * the structural slice, and the applier-conformance suite (T-8) is what proves each applier folds
 * on both engines.
 */
export const CLIENT_MODULES: readonly AnyModuleDefinition<never>[] = [
  platformModule as unknown as AnyModuleDefinition<never>,
  // task 25 (notes): the reference module's data layer — op validators, `notes` projection
  // appliers, and the notes.* permission vocabulary. Platform-free (`@bolusi/modules/notes`, never
  // `/screens`), so this is a data-layer registration; the RN screens are task 96.
  notesModule as unknown as AnyModuleDefinition<never>,
];
