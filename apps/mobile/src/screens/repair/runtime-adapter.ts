/**
 * Bind a `RepairRuntime` (the repair screens' port) over a composed `ModuleRuntime`, the twin of
 * the notes adapter. The database, invalidation bus and media seams are parameters so a test drives
 * the same screens over a real runtime on an in-memory database with fake media.
 */
import {
  bindModulePort,
  listSwitcherUsers,
  type CommandIdentity,
  type InvalidationBus,
  type ModuleRuntime,
} from '@bolusi/core';
import type { ClientDatabase } from '@bolusi/db-client';
import {
  PHONE_MODELS_TABLE,
  REPAIR_PERMISSION,
  REPAIR_TABLE,
  REPAIR_TICKET_ENTITY,
  repairModule,
} from '@bolusi/modules/repair';
import type { RepairRuntime } from '@bolusi/modules/repair/screens';
import type { Kysely } from 'kysely';

import { readEntitySyncStatuses } from '../../bootstrap/entity-sync-statuses.js';

/** The native half: capture, signing, verified thumbnails and sharing a photo. */
export type RepairMediaSeams = Pick<
  RepairRuntime,
  'capturePhoto' | 'captureSignature' | 'loadThumbnail' | 'sharePhoto' | 'loadModelPhoto'
>;

export interface RepairRuntimeDeps {
  readonly runtime: ModuleRuntime<ClientDatabase>;
  readonly db: Kysely<ClientDatabase>;
  readonly invalidation: InvalidationBus;
  readonly identity: CommandIdentity;
  readonly media: RepairMediaSeams;
}

// The phone catalog too: a download that lands while the device step is open updates its suggestions.
const REPAIR_TABLES = [...Object.values(REPAIR_TABLE), PHONE_MODELS_TABLE];

export function createRepairRuntime(deps: RepairRuntimeDeps): RepairRuntime {
  const port = bindModulePort(repairModule, deps.runtime, deps.identity);
  return {
    ...port,
    // Every repair table, not one: a ticket row joins its customer, lines and photos, and a pulled
    // change to any of them must re-render the open screen (04 §7).
    subscribe: (listener) => deps.invalidation.subscribeTables(REPAIR_TABLES, listener),
    ticketSyncStatuses: (ids) => readEntitySyncStatuses(deps.db, REPAIR_TICKET_ENTITY, ids),
    technicians: async () =>
      (await listSwitcherUsers(deps.db))
        .filter((user) => port.colleagueHasPermission(user.id, REPAIR_PERMISSION.work))
        .map(({ id, name }) => ({ id, name })),
    ...deps.media,
  };
}
