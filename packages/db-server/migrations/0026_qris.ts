// Integrated QRIS through Xendit (product-scope.md, "Repair payments"): which payment accounts are
// connected to a Xendit account, and each QR the counter showed a customer. Server only: devices
// never hold a Xendit key, and a QR's payment reaches them as an ordinary money record.
//
// The secret key is sealed (AES-256-GCM, PAYMENT_SECRETS_KEY) because the server must use it again;
// the callback token only has to be compared, so only its hash is kept. A charge's id is the QR's
// `reference_id` at Xendit and the id of the money record its payment becomes, so one QR can never
// record two payments. A charge keeps the sealed key and token hash it was made under, so a QR
// already on a customer's screen is still confirmed after its account is disconnected or
// reconnected; the key is cleared once the QR is paid or long expired. Merge after 0025: the migrator refuses an earlier number later.
import { sql, type Kysely } from 'kysely';

import { secureTenantTable } from '../src/schema/security.js';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE qris_connections (
      account_id          uuid PRIMARY KEY,
      tenant_id           uuid NOT NULL REFERENCES tenants(id),
      secret_sealed       text NOT NULL,
      callback_token_hash text NOT NULL,
      environment         text NOT NULL,
      connected_by        uuid NOT NULL,
      connected_at        bigint NOT NULL
    )
  `.execute(db);
  await secureTenantTable(db, 'qris_connections');

  await sql`
    CREATE TABLE qris_charges (
      id              uuid PRIMARY KEY,
      tenant_id       uuid NOT NULL REFERENCES tenants(id),
      store_id        uuid NOT NULL REFERENCES stores(id),
      account_id      uuid NOT NULL,
      document_json   text NOT NULL,
      amount          bigint NOT NULL,
      xendit_qr_id    text NOT NULL,
      qr_string       text NOT NULL,
      environment     text NOT NULL,
      expires_at      bigint NOT NULL,
      requested_by    uuid NOT NULL,
      device_id       uuid NOT NULL,
      created_at      bigint NOT NULL,
      checked_at      bigint,
      secret_sealed       text,
      callback_token_hash text NOT NULL,
      payment_id      text,
      paid_at         bigint
    )
  `.execute(db);
  await sql`CREATE UNIQUE INDEX idx_qris_charges_qr ON qris_charges (xendit_qr_id)`.execute(db);
  await secureTenantTable(db, 'qris_charges');
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE qris_charges`.execute(db);
  await sql`DROP TABLE qris_connections`.execute(db);
}
