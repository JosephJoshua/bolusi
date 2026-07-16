// The `platform` module manifest (04 §1; 01 §6/§7) — conflicts + user prefs.
//
// This is the module `SERVER_MODULES` (apps/server/src/deps.ts) must carry. Registering it lights
// up BOTH the op-payload validators and the projection appliers from ONE list (task 49's seam), so
// the server can never validate a type it cannot fold, or fold one it never validated.
//
// It declares no `migrations`: the DDL for `conflicts` / `user_prefs` is owned by 10-db and already
// shipped on both engines (tasks 04/05). 04 §4.4's migration block is for a module bringing its own
// tables; re-declaring these here would be a second source of truth about a schema that exists
// (CLAUDE.md §2.8) — and, worse, the two could disagree while both looked authoritative. The T-8
// applier-conformance runner creates the tables it needs from 10-db's DDL instead.
import {
  defineModule,
  type ModuleDefinition,
  type ModuleManifest,
} from '../module/define-module.js';
import {
  acknowledgeConflictHandler,
  acknowledgeConflictInput,
  setLocaleHandler,
  setLocaleInput,
} from './commands.js';
import {
  CONFLICTS_TABLE,
  PLATFORM_MODULE_ID,
  PLATFORM_PERMISSION,
  USER_PREFS_TABLE,
} from './constants.js';
import { platformOperations } from './operations.js';
import { conflictsTable } from './projections/conflicts.js';
import { userPrefsTable } from './projections/user-prefs.js';
import { listConflictsQuery } from './queries.js';
import type { PlatformDatabase } from './schema.js';

/** The manifest as authored (04 §1). */
export const platformModuleManifest = {
  id: PLATFORM_MODULE_ID,

  operations: platformOperations,

  projections: {
    tables: {
      [CONFLICTS_TABLE]: conflictsTable,
      [USER_PREFS_TABLE]: userPrefsTable,
    },
    // No `migrations` — see the file header.
  },

  /**
   * The platform permission registry (02 §11.3), verbatim: ids, scopes, `isDangerous`, and the
   * canonical EN descriptions. All three are `scope: 'store'`, so per 02 §5.2 step 3 a null
   * `storeId` at evaluation is `missing_scope` — including for `set_locale`, whose OP is
   * tenant-scoped. Those are different scopes and it is worth being explicit that they differ: the
   * PERMISSION is evaluated in the device's store (02 §5.2's v0 rule); the OP is recorded
   * tenant-wide (01 §6) because the preference follows the user, not the store.
   */
  permissions: {
    [PLATFORM_PERMISSION.conflictView]: {
      scope: 'store',
      isDangerous: false,
      description:
        'Can see conflicts — places where two devices recorded contradictory changes to the same record.',
    },
    [PLATFORM_PERMISSION.conflictAcknowledge]: {
      scope: 'store',
      isDangerous: false,
      description:
        'Can review a surfaced conflict and acknowledge it, confirming the recorded outcome.',
    },
    [PLATFORM_PERMISSION.setLocale]: {
      scope: 'store',
      isDangerous: false,
      description: 'Can change their own app language.',
    },
  },

  commands: {
    acknowledgeConflict: {
      permission: PLATFORM_PERMISSION.conflictAcknowledge,
      input: acknowledgeConflictInput,
      handler: acknowledgeConflictHandler,
    },
    setLocale: {
      permission: PLATFORM_PERMISSION.setLocale,
      input: setLocaleInput,
      handler: setLocaleHandler,
    },
  },

  queries: {
    listConflicts: listConflictsQuery,
  },
} as const satisfies ModuleManifest<PlatformDatabase>;

/**
 * The defined `platform` module — validated at IMPORT time (04 §3/§4.4).
 *
 * Unlike `@bolusi/test-support`'s fixture manifest (which exports a manifest for consumers to
 * define, so it never binds to a `dist` vs `src` copy of `defineModule`), this file lives INSIDE
 * core, so there is exactly one `defineModule` it could call. Defining it here means a malformed
 * platform manifest is a startup failure for every consumer, not a per-consumer obligation.
 */
export const platformModule: ModuleDefinition<PlatformDatabase, typeof platformModuleManifest> =
  defineModule<PlatformDatabase, typeof platformModuleManifest>(platformModuleManifest);
