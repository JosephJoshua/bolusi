// CLIENT module registration (04-module-contract §1/§3/§4; 02-permissions §3.2).
//
// The client mirror of `SERVER_MODULES` (apps/server/src/deps.ts). `registerModules` derives the
// permission vocabulary, the op-type→applier map AND the operation registry from THIS ONE list, so
// the device can never validate a type it cannot fold, or fold one it never validated (§2.8).
//
// ── WHY A SECOND LIST EXISTS, AND WHY THAT IS A FINDING RATHER THAN A DESIGN ───────────────────
// This is the second `[platformModule]` literal in the repo; the server holds the first. Both sides
// must register the same manifests: task 25 appended `notes` to BOTH, and task 97 appended `auth`
// to BOTH — each a two-place edit with nothing checking they agree, which is the shape §2.8 exists
// to prevent. The proper fix
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
import { authModule, platformModule, type AnyModuleDefinition } from '@bolusi/core';
import { notesModule } from '@bolusi/modules/notes';

/**
 * The modules this device registers.
 *
 * `platform` (conflicts + user prefs) shipped at v0; `notes` landed with task 25 (`@bolusi/modules`);
 * `auth`'s appliers land with THIS task (97 — the client half). Task 43 registered `authModule` in
 * `SERVER_MODULES` so the server folds `auth.*`; this registers the SAME manifest on the device, so
 * both sides fold the identical `auth.*` set (task 49's `registerModules` invariant, on both). Every
 * module appears in BOTH lists — here and in `SERVER_MODULES`.
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
  // task 97 (auth, client half): the `auth.*` op validators + the `auth_sessions` /
  // `pin_lockout_events` / `auth_permission_denials` projection appliers + the auth permission
  // vocabulary. The DDL for the three tables already ships in CLIENT_MIGRATIONS (001-initial-schema),
  // so this is pure data-layer registration — WITHOUT this line the device folds every `auth.*` op
  // through the projection engine's `unregistered` no-op and those projections stay write-only
  // on-device (task 43's f-1). `authModule` is platform-free (`@bolusi/core`, built by task 43), so
  // registering it needs no RN surface. Task 43 did the mirror edit to `SERVER_MODULES`.
  authModule as unknown as AnyModuleDefinition<never>,
];
