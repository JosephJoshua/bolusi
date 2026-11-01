/**
 * Bind a `RepairRuntime` (the repair screens' port) over a composed `ModuleRuntime`, the twin of
 * the notes adapter. The database, invalidation bus and media seams are parameters so a test drives
 * the same screens over a real runtime on an in-memory database with fake media.
 */
import {
  bindModulePort,
  listSwitcherUsers,
  OP_SYNC_STATUS_TABLE,
  readStores,
  type CommandIdentity,
  type InvalidationBus,
  type ModuleRuntime,
} from '@bolusi/core';
import type { ClientDatabase } from '@bolusi/db-client';
import { approvalsModule, moneyModule } from '@bolusi/modules';
import { APPROVALS_TABLE } from '@bolusi/modules/approvals';
import { MONEY_ENTRY_ENTITY, MONEY_TABLE, type QrisPort } from '@bolusi/modules/money';
import {
  PHONE_MODELS_TABLE,
  REPAIR_DOCUMENT_KIND,
  REPAIR_PERMISSION,
  REPAIR_TABLE,
  REPAIR_TICKET_ENTITY,
  repairModule,
} from '@bolusi/modules/repair';
import type { RepairRuntime } from '@bolusi/modules/repair/screens';
import type { OperationSyncStatus } from '@bolusi/ui';
import type { Kysely } from 'kysely';

import {
  readEntitySyncStatuses,
  readLinkedRefusals,
} from '../../bootstrap/entity-sync-statuses.js';
import { consoleDiagnostics } from '../../ports/diagnostics.js';

/** The native half: capture, signing, verified thumbnails and sharing a photo. */
export type RepairMediaSeams = Pick<
  RepairRuntime,
  | 'capturePhoto'
  | 'captureSignature'
  | 'loadThumbnail'
  | 'sharePhoto'
  | 'loadModelPhoto'
  | 'pickPhoto'
  | 'recordVideo'
  | 'playVideo'
  | 'videoKept'
>;

export interface RepairRuntimeDeps {
  readonly runtime: ModuleRuntime<ClientDatabase>;
  readonly db: Kysely<ClientDatabase>;
  readonly invalidation: InvalidationBus;
  readonly identity: CommandIdentity;
  readonly media: RepairMediaSeams;
  readonly printing?: RepairRuntime['printing'];
  readonly inventory?: RepairRuntime['inventory'];
  readonly purchasing?: RepairRuntime['purchasing'];
  /** QRIS through Xendit, as this user; absent on a device that cannot reach the server. */
  readonly qris?: QrisPort | undefined;
  /** `RepairRuntime.statusSite`; absent, no status links (tests). */
  readonly statusSite?: string | null;
}

/** Every repair table, the op log for each ticket's sync status, the phone catalog (a
 * download that lands while the device step is open updates its suggestions), the money
 * ledger, whose payments the board and handover show, and the approval requests on servisan. */
const LIVE_TABLES = [
  ...Object.values(REPAIR_TABLE),
  ...Object.values(MONEY_TABLE),
  APPROVALS_TABLE,
  OP_SYNC_STATUS_TABLE,
  PHONE_MODELS_TABLE,
];

/**
 * Each ticket's op statuses, with the viewer's refused charges and payments on it: those are money
 * entries, but the servisan is where the person needs to see that one did not go through.
 */
export async function readTicketSyncStatuses(
  db: Kysely<ClientDatabase>,
  ids: readonly string[],
  viewerId: string,
): Promise<Readonly<Record<string, readonly OperationSyncStatus[]>>> {
  const [own, money] = await Promise.all([
    readEntitySyncStatuses(db, REPAIR_TICKET_ENTITY, ids, viewerId),
    readLinkedRefusals(db, MONEY_ENTRY_ENTITY, viewerId, repairDocumentOf),
  ]);
  const wanted = new Set(ids);
  const out: Record<string, readonly OperationSyncStatus[]> = { ...own };
  for (const [ticketId, count] of money) {
    if (!wanted.has(ticketId)) continue;
    out[ticketId] = [
      ...(out[ticketId] ?? []),
      ...Array<OperationSyncStatus>(count).fill('rejected'),
    ];
  }
  return out;
}

/** The servisan a money entry's payload is for, if it is for one. */
function repairDocumentOf(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const document = (payload as { readonly document?: unknown }).document;
  if (typeof document !== 'object' || document === null) return null;
  const { kind, id } = document as { readonly kind?: unknown; readonly id?: unknown };
  return kind === REPAIR_DOCUMENT_KIND && typeof id === 'string' ? id : null;
}

export function createRepairRuntime(deps: RepairRuntimeDeps): RepairRuntime {
  const port = bindModulePort(repairModule, deps.runtime, deps.identity);
  return {
    ...port,
    money: {
      ...bindModulePort(moneyModule, deps.runtime, deps.identity),
      stores: () => readStores(deps.db),
      ...(deps.qris === undefined ? {} : { qris: deps.qris }),
    },
    approvals: bindModulePort(approvalsModule, deps.runtime, deps.identity),
    // Every repair table, not one: a ticket row joins its customer, lines and photos, and a pulled
    // change to any of them must re-render the open screen (04 §7). The op log too, since each
    // screen shows its tickets' sync status.
    subscribe: (listener) => deps.invalidation.subscribeTables(LIVE_TABLES, listener),
    ticketSyncStatuses: (ids) => readTicketSyncStatuses(deps.db, ids, deps.identity.userId),
    technicians: async () =>
      (await listSwitcherUsers(deps.db))
        .filter((user) => port.colleagueHasPermission(user.id, REPAIR_PERMISSION.work))
        .map(({ id, name }) => ({ id, name })),
    ...deps.media,
    statusSite: deps.statusSite ?? null,
    diagnostics: consoleDiagnostics,
    ...(deps.printing === undefined ? {} : { printing: deps.printing }),
    ...(deps.inventory === undefined ? {} : { inventory: deps.inventory }),
    ...(deps.purchasing === undefined ? {} : { purchasing: deps.purchasing }),
  };
}
