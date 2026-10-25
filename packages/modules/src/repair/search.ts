// What repair makes searchable, for the shared fuzzy search in @bolusi/core (search/). Tickets are
// found by customer name or phone, ticket number, IMEI, brand or model; customers by name or phone.
// Names and phones are encrypted at rest, so the database cannot match them: the core keeps an
// in-memory index per store, loads it once, and reloads only the entities that change.
import type {
  ChangedEntities,
  ReadonlyProjectionDb,
  SearchDocument,
  SearchScope,
  SearchSource,
} from '@bolusi/core';

import { REPAIR_CUSTOMER_ENTITY, REPAIR_TABLE, REPAIR_TICKET_ENTITY } from './constants.js';
import type { RepairDatabase } from './schema.js';

type Db = ReadonlyProjectionDb<RepairDatabase>;

/** SQLite caps bound parameters; a big sync can change thousands of entities at once. */
const CHUNK = 500;

function chunks<T>(values: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += CHUNK) out.push(values.slice(i, i + CHUNK));
  return out;
}

function ticketRows(db: Db, scope: SearchScope) {
  return db
    .selectFrom('repairTickets as t')
    .innerJoin('repairCustomers as c', 'c.id', 't.customerId')
    .select([
      't.id',
      't.ticketNumber',
      't.deviceBrand',
      't.deviceModel',
      't.deviceImei',
      't.createdAt',
      'c.name',
      'c.phone',
    ])
    .where('t.tenantId', '=', scope.tenantId)
    .where('t.storeId', '=', scope.storeId);
}

type TicketSearchRow = Awaited<ReturnType<ReturnType<typeof ticketRows>['execute']>>[number];

function ticketDocument(row: TicketSearchRow): SearchDocument {
  return {
    id: row.id,
    text: [row.name, row.deviceBrand, row.deviceModel],
    phones: [row.phone],
    numbers: [row.deviceImei],
    codes: [row.ticketNumber],
    rank: Number(row.createdAt),
  };
}

export const ticketSearchSource: SearchSource<RepairDatabase> = {
  name: 'repair.tickets',
  tables: [REPAIR_TABLE.tickets, REPAIR_TABLE.customers],
  entityTypes: [REPAIR_TICKET_ENTITY, REPAIR_CUSTOMER_ENTITY],
  async loadAll(db, scope) {
    return (await ticketRows(db, scope).execute()).map(ticketDocument);
  },
  async loadChanged(db, scope, changed: ChangedEntities) {
    const ticketIds = changed.get(REPAIR_TICKET_ENTITY) ?? [];
    const customerIds = changed.get(REPAIR_CUSTOMER_ENTITY) ?? [];
    const documents: SearchDocument[] = [];
    for (const ids of chunks(ticketIds)) {
      const rows = await ticketRows(db, scope).where('t.id', 'in', ids).execute();
      documents.push(...rows.map(ticketDocument));
    }
    // A corrected name or phone changes every ticket of that customer.
    for (const ids of chunks(customerIds)) {
      const rows = await ticketRows(db, scope).where('t.customerId', 'in', ids).execute();
      documents.push(...rows.map(ticketDocument));
    }
    return { documents, checked: ticketIds };
  },
};

function customerRows(db: Db, scope: SearchScope) {
  return db
    .selectFrom('repairCustomers')
    .select(['id', 'name', 'phone', 'createdAt'])
    .where('tenantId', '=', scope.tenantId)
    .where('storeId', '=', scope.storeId);
}

type CustomerSearchRow = Awaited<ReturnType<ReturnType<typeof customerRows>['execute']>>[number];

function customerDocument(row: CustomerSearchRow): SearchDocument {
  return { id: row.id, text: [row.name], phones: [row.phone], rank: Number(row.createdAt) };
}

export const customerSearchSource: SearchSource<RepairDatabase> = {
  name: 'repair.customers',
  tables: [REPAIR_TABLE.customers],
  entityTypes: [REPAIR_CUSTOMER_ENTITY],
  async loadAll(db, scope) {
    return (await customerRows(db, scope).execute()).map(customerDocument);
  },
  async loadChanged(db, scope, changed) {
    const ids = changed.get(REPAIR_CUSTOMER_ENTITY) ?? [];
    const documents: SearchDocument[] = [];
    for (const chunk of chunks(ids)) {
      documents.push(
        ...(await customerRows(db, scope).where('id', 'in', chunk).execute()).map(customerDocument),
      );
    }
    return { documents, checked: ids };
  },
};
