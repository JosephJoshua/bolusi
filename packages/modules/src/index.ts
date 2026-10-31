// @bolusi/modules — the defineModule manifests (04-module-contract), and THE ONE registration list
// both apps fold from.
//
// ── ONE LIST, NOT TWO LITERALS (task 90; CLAUDE.md §2.8) ──────────────────────────────────────────
//
// `registerModules(list)` derives a build's permission vocabulary, its op-type→applier map AND its
// operation registry from a single module list. Before task 90 that list was hand-maintained TWICE —
// `SERVER_MODULES` in `apps/server/src/deps.ts` and `CLIENT_MODULES` in `apps/mobile/src/bootstrap/
// modules.ts` — and NOTHING checked the two agreed. They agreed only by coincidence: a task that
// appended a module to one and not the other would ship a server that folds an op type the device
// answers `UNKNOWN_TYPE` to (or the reverse), and BOTH halves typecheck, because each list is
// independently well-formed (04 §1). Only a test could see it, and no test compared the two.
//
// `ALL_MODULES` is that single source. `apps/server` and `apps/mobile` both register from it, so
// there is exactly one place to add a module and one place a deletion can happen — and when it does,
// both apps' registration suites go red off the same edit (that is the property, falsified in
// `index.test.ts` and in each app's registration suite).
//
// ── PLATFORM-FREE, SO THE SERVER CARRIES NO RN EDGE (08 §3.2) ─────────────────────────────────────
//
// This entry (`@bolusi/modules`, the `.` export) imports the `platform`/`auth` manifests from
// `@bolusi/core` and the `notes` manifest from `./notes/manifest` — its definition module, not the
// `./notes` barrel (importing the barrel would pull its whole public surface into this entry's graph
// and mislabel the barrel's other re-exports as unused). All three are platform-free; this never
// touches `./notes/screens` (the RN-only surface, importable ONLY from apps/mobile —
// `bolusi/boundaries` rule 3), so the server importing `ALL_MODULES` puts no react-native edge on
// its graph. The split export is what keeps that true; do not re-export anything under `./screens`.
//
// ── THE CAST (04 §2; mirrors both apps' former per-element casts) ─────────────────────────────────
//
// `AnyModuleDefinition<DB>` is CONTRAVARIANT in `DB` (`apply(db: Kysely<DB>, …)`), so two concrete
// modules over different schemas are mutually unassignable and a heterogeneous list cannot be built
// without erasing `DB`. `never` is the shared bottom the client already used; the appliers are
// dialect-neutral (04 §2) and the T-8 applier-conformance suite is what proves each folds
// byte-identically on both engines. `apps/server` re-casts to its own generated `DB` at the import
// site. The cast lives ONCE here now, in the manifests' home, rather than per element in two apps.
import { authModule, platformModule, type AnyModuleDefinition } from '@bolusi/core';

import { createApprovalsModule, type ApprovalsModule } from './approvals/manifest.js';
import { defineInventoryModule, type InventoryModule } from './inventory/index.js';
import { createMoneyApprovalKinds } from './money/approval-kinds.js';
import { createMoneyModule } from './money/manifest.js';
import { notesModule } from './notes/manifest.js';
import { repairApprovalKinds } from './repair/approval-kinds.js';
import { repairModule } from './repair/manifest.js';
import { REPAIR_DOCUMENT_KIND, repairMoneyDocument } from './repair/money-document.js';
import { repairPartUse } from './repair/part-use.js';

/**
 * The one `inventory` instance: stock rules ask the module that owns each use whether parts may be
 * drawn for it, so the uses are wired here, where every module is in reach.
 */
export const inventoryModule: InventoryModule = defineInventoryModule({
  repair_ticket: repairPartUse,
});

/**
 * The money ledger, checking each charge against the module that issued the document. A module that
 * charges customers adds its document source here.
 */
const moneyDocumentSources = { [REPAIR_DOCUMENT_KIND]: repairMoneyDocument };
export const moneyModule = createMoneyModule(moneyDocumentSources);

/**
 * Approval requests, for the decisions each module lets an owner hand out. A module with such
 * decisions adds its kinds here.
 */
export const approvalsModule: ApprovalsModule = createApprovalsModule({
  ...repairApprovalKinds,
  ...createMoneyApprovalKinds(moneyDocumentSources),
});

/**
 * The modules every Bolusi build registers — the ONE list `SERVER_MODULES` and `CLIENT_MODULES`
 * both are (04 §1/§3/§4; 02 §3.2). Order is `platform`, `notes`, `repair`, `inventory`, `money`, `approvals`, `auth`; a registration list's
 * failure mode is a silent omission, so the count is guarded in `index.test.ts` (T-14) and folded
 * on the real push path (server) and real bootstrap (client) — an empty list would fold nothing.
 */
export const ALL_MODULES = [
  platformModule,
  notesModule,
  repairModule,
  inventoryModule,
  moneyModule,
  approvalsModule,
  authModule,
] as unknown as readonly AnyModuleDefinition<never>[];
export * from './role-abilities.js';
