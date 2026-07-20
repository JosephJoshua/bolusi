// CLIENT module registration (04-module-contract §1/§3/§4; 02-permissions §3.2).
//
// `CLIENT_MODULES` is `@bolusi/modules`' single `ALL_MODULES` — the SAME list `apps/server`'s
// `SERVER_MODULES` is. Task 90 unified the two hand-maintained `defineModule` literals that used to
// live here and in `deps.ts`: they HAD to hold the same manifests (task 25 appended `notes` to both,
// task 97 appended `auth` to both), and NOTHING checked they agreed — the shape §2.8 exists to
// prevent. Now there is one list, so a module added or dropped in `@bolusi/modules` is noticed by
// BOTH apps' registration suites off the same edit.
//
// `registerModules(CLIENT_MODULES)` (bootstrap.ts) derives the permission vocabulary, the
// op-type→applier map AND the operation registry from THIS ONE list, so the device can never
// validate a type it cannot fold, or fold one it never validated (§2.8). `bootstrap.test.ts` asserts
// the denominator (3 modules, 19 permissions, the op types) over the REAL bootstrap, so the list
// cannot silently empty: `registerModules([])` SUCCEEDS and folds nothing — this repo's signature
// failure, shipped eight times (T-14).
//
// No cast here: `ALL_MODULES` is already `readonly AnyModuleDefinition<never>[]`. `never` is the
// shared bottom the device needs — the appliers are dialect-neutral (04 §2) and `AnyModuleDefinition`
// is contravariant in `DB`, so a heterogeneous list cannot be built without erasing it (see
// `@bolusi/modules`' index for the full rationale and the T-8 proof). `apps/server` re-casts to its
// generated `DB`; the device folds on `never`.
import { type AnyModuleDefinition } from '@bolusi/core';
import { ALL_MODULES } from '@bolusi/modules';

/**
 * The modules this device registers — `@bolusi/modules`' `ALL_MODULES` (04 §1): `platform`
 * (conflicts + user prefs), `notes` (task 25 — the reference module's data layer), and `auth`
 * (task 97 — the `auth.*` validators + `auth_sessions` / `pin_lockout_events` /
 * `auth_permission_denials` appliers + the auth permission vocabulary). The SAME set the server
 * folds, from the SAME list.
 */
export const CLIENT_MODULES: readonly AnyModuleDefinition<never>[] = ALL_MODULES;
