// The injection seam that makes the convergence rig platform- AND domain-free (task 181).
//
// TWO things bind a chaos run to a concrete platform/domain, and BOTH are hoisted here so the shared
// rig (device.ts, oracle.ts, convergence.ts) references neither directly:
//
//   1. The DB engine — `openDb` builds a `ClientDbHandle` (its own driver + Kysely + `OpAppendStore`).
//      The Node harness binds better-sqlite3 + `createClientOpStore`; the on-device rig binds
//      op-sqlite. Keeping the *values* out of @bolusi/test-support honours 08 §3.3 (no DB values here)
//      — this file names only db-client TYPES, which erase at build.
//
//   2. The module — `module` / `moduleManifest` / `projectionManifest` are the notes module trio. The
//      notes definition lives in `@bolusi/modules`, which dev-depends on @bolusi/test-support; importing
//      it back would form a cycle (and drag RN peer deps into this test-only package). Injecting it as a
//      seam breaks the cycle by construction — every caller already depends on `@bolusi/modules` and
//      supplies the trio (the harness's `NODE_SEAMS`, apps/mobile's device env).
//
// A device may register EXTRA modules per-run (CHAOS-07's `platform`) via `VirtualDevice.open`'s
// `extraModules`; the seam supplies only the always-present PRIMARY module.
import type {
  AnyModuleDefinition,
  ModulePermissionManifest,
  ModuleProjectionManifest,
} from '@bolusi/core';
import type { ClientDatabase } from '@bolusi/db-client';

import type { ClientDbHandle } from './client-db.js';

export interface ConvergenceSeams {
  /** Open a fresh device DB (driver + Kysely + bound `OpAppendStore`). Platform-specific. */
  readonly openDb: () => Promise<ClientDbHandle>;
  /** The always-registered primary module (notes). */
  readonly module: AnyModuleDefinition<ClientDatabase>;
  /** Its permission manifest, for the grant-all evaluator. */
  readonly moduleManifest: ModulePermissionManifest;
  /** Its projection manifest, for the digest oracle (§3.4) and per-device digests. */
  readonly projectionManifest: ModuleProjectionManifest<ClientDatabase>;
}
