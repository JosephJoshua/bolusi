// The `repair` module projections and permissions (digital repair ticket, slice 1).
//
// The server folds the same appliers as the device, so these tables mirror client migration 4.
// Permissions are seeded here because the app role cannot write the global `permissions` table;
// the drift guard (apps/server acting-user.test.ts) keeps this list equal to the module manifest.
import { sql, type Kysely } from 'kysely';

import { secureTenantTable } from '../src/schema/security.js';

const PERMISSIONS = [
  {
    id: 'repair.read',
    action: 'read',
    isDangerous: false,
    description: "Can see the store's repair tickets and customers.",
  },
  {
    id: 'repair.intake',
    action: 'intake',
    isDangerous: false,
    description: 'Can take in devices for repair, register customers and correct their details.',
  },
  {
    id: 'repair.work',
    action: 'work',
    isDangerous: false,
    description:
      'Can take repair tickets from the queue, update repair progress and propose price changes.',
  },
  {
    id: 'repair.assign',
    action: 'assign',
    isDangerous: false,
    description: 'Can assign repair tickets to technicians.',
  },
  {
    id: 'repair.quote_change',
    action: 'quote_change',
    isDangerous: true,
    description:
      "Can change a repair's price after intake and accept or decline technicians' proposals.",
  },
  {
    id: 'repair.cancel',
    action: 'cancel',
    isDangerous: false,
    description: 'Can cancel a repair. The device stays in the store until it is handed back.',
  },
  {
    id: 'repair.handover',
    action: 'handover',
    isDangerous: false,
    description: 'Can hand a device back to its customer, with a photo and signature.',
  },
] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE repair_customers (
      id         uuid PRIMARY KEY,
      tenant_id  uuid NOT NULL REFERENCES tenants(id),
      store_id   uuid NOT NULL REFERENCES stores(id),
      name       text NOT NULL,
      phone      text,
      created_by uuid NOT NULL,
      created_at bigint NOT NULL,
      updated_by uuid NOT NULL,
      updated_at bigint NOT NULL
    )
  `.execute(db);
  await sql`CREATE INDEX idx_repair_customers_store ON repair_customers (tenant_id, store_id)`.execute(
    db,
  );
  await secureTenantTable(db, 'repair_customers');

  await sql`
    CREATE TABLE repair_tickets (
      id                 uuid PRIMARY KEY,
      tenant_id          uuid NOT NULL REFERENCES tenants(id),
      store_id           uuid NOT NULL REFERENCES stores(id),
      ticket_number      text NOT NULL,
      customer_id        uuid NOT NULL,
      device_brand       text NOT NULL,
      device_model       text NOT NULL,
      device_color       text NOT NULL,
      device_imei        text,
      device_passcode    text,
      complaint          text NOT NULL,
      intake_notes       text NOT NULL,
      checklist_json     text NOT NULL,
      peripherals_json   text NOT NULL,
      estimated_ready_at bigint,
      outcome            text NOT NULL,
      outcome_note       text,
      location           text NOT NULL,
      technician_id      uuid,
      quote_total        bigint NOT NULL,
      created_by         uuid NOT NULL,
      created_at         bigint NOT NULL,
      updated_at         bigint NOT NULL,
      returned_by        uuid,
      returned_at        bigint
    )
  `.execute(db);
  await sql`CREATE INDEX idx_repair_tickets_store_created ON repair_tickets (tenant_id, store_id, created_at)`.execute(
    db,
  );
  await secureTenantTable(db, 'repair_tickets');

  await sql`
    CREATE TABLE repair_quote_lines (
      id              uuid PRIMARY KEY,
      tenant_id       uuid NOT NULL REFERENCES tenants(id),
      store_id        uuid NOT NULL REFERENCES stores(id),
      ticket_id       uuid NOT NULL,
      kind            text NOT NULL,
      description     text NOT NULL,
      amount          bigint NOT NULL,
      status          text NOT NULL,
      reason          text,
      customer_agreed integer,
      created_by      uuid NOT NULL,
      created_at      bigint NOT NULL,
      decided_by      uuid,
      decided_at      bigint,
      decision_note   text
    )
  `.execute(db);
  await sql`CREATE INDEX idx_repair_quote_lines_ticket ON repair_quote_lines (ticket_id)`.execute(
    db,
  );
  await secureTenantTable(db, 'repair_quote_lines');

  await sql`
    CREATE TABLE repair_ticket_photos (
      ticket_id    uuid NOT NULL,
      slot         text NOT NULL,
      tenant_id    uuid NOT NULL REFERENCES tenants(id),
      store_id     uuid NOT NULL REFERENCES stores(id),
      media_id     uuid NOT NULL,
      media_sha256 text NOT NULL,
      media_mime   text NOT NULL,
      captured_at  bigint NOT NULL,
      added_by     uuid NOT NULL,
      added_at     bigint NOT NULL,
      PRIMARY KEY (ticket_id, slot)
    )
  `.execute(db);
  await secureTenantTable(db, 'repair_ticket_photos');

  await sql`
    CREATE TABLE repair_ticket_events (
      id          uuid PRIMARY KEY,
      tenant_id   uuid NOT NULL REFERENCES tenants(id),
      store_id    uuid NOT NULL REFERENCES stores(id),
      ticket_id   uuid NOT NULL,
      kind        text NOT NULL,
      actor_id    uuid NOT NULL,
      at          bigint NOT NULL,
      detail_json text NOT NULL
    )
  `.execute(db);
  await sql`CREATE INDEX idx_repair_ticket_events_ticket ON repair_ticket_events (ticket_id, at)`.execute(
    db,
  );
  await secureTenantTable(db, 'repair_ticket_events');

  for (const p of PERMISSIONS) {
    await sql`
      INSERT INTO permissions (id, module, action, scope, description, is_dangerous)
      VALUES (${p.id}, 'repair', ${p.action}, 'store', ${p.description}, ${p.isDangerous})
      ON CONFLICT (id) DO UPDATE SET
        module = EXCLUDED.module, action = EXCLUDED.action, scope = EXCLUDED.scope,
        description = EXCLUDED.description, is_dangerous = EXCLUDED.is_dangerous
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const p of PERMISSIONS) {
    await sql`DELETE FROM permissions WHERE id = ${p.id}`.execute(db);
  }
  for (const table of [
    'repair_ticket_events',
    'repair_ticket_photos',
    'repair_quote_lines',
    'repair_tickets',
    'repair_customers',
  ]) {
    await sql`DROP TABLE ${sql.table(table)}`.execute(db);
  }
}
