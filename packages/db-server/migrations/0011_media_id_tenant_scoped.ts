// 10-db-schema §8 — tenant-scope the media id (owner ruling D23 §2, task 170).
//
// WHY. `POST /v1/media/:id/init` was a cross-tenant existence oracle: `media.id` was a GLOBAL
// `PRIMARY KEY`, so a media id another tenant already held could not be inserted — RLS hides the
// foreign row from the SELECT but does NOT stop a unique conflict (10-db §6) — and the route rendered
// `404 MEDIA_NOT_FOUND` for a held id versus `200` for a free one. Held-vs-free was distinguishable
// across a tenant boundary, over ids the caller was never shown (SEC-TENANT-04; task 141a). The owner
// ruled REMOVE the oracle rather than document it (D23 §2): its budget is 120/min (deps.ts), so
// §2.2 exception 2's rate-limit justification does not transfer.
//
// THE FIX. Make media id uniqueness `(tenant_id, id)` rather than `(id)`. A foreign tenant's id then
// simply does not exist in THIS tenant, so the insert succeeds cleanly and returns `200` — identical
// to a free id. Two tenants may independently hold the same id; that is the point.
//
// `media_chunks` FK'd `media(id)`, the single-column key we are removing, so its FK must be rewritten
// to the composite `(tenant_id, media_id) → media(tenant_id, id)`. `media_chunks.tenant_id` is
// already NOT NULL (0005), so the composite reference is total. Order matters: drop the dependent FK
// before dropping the PK it points at, recreate the PK, then recreate the FK.
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // 1. Release the dependent FK (Postgres auto-named the inline `REFERENCES media(id)`).
  await sql`ALTER TABLE media_chunks DROP CONSTRAINT media_chunks_media_id_fkey`.execute(db);
  // 2. `media_chunks` PK was `(media_id, chunk_index)` — globally unique per chunk. Once two tenants
  //    may legally share a media id (below), each uploading chunk 0 would collide on that PK. Add
  //    `tenant_id` so the chunk key is `(tenant_id, media_id, chunk_index)`. `media_chunks.tenant_id`
  //    is already NOT NULL and the chunk-PUT handler stamps `device.tenantId`, so this is total.
  await sql`ALTER TABLE media_chunks DROP CONSTRAINT media_chunks_pkey`.execute(db);
  await sql`ALTER TABLE media_chunks ADD PRIMARY KEY (tenant_id, media_id, chunk_index)`.execute(
    db,
  );
  // 3. Repoint media's uniqueness: global id → (tenant_id, id). This is the line that closes the
  //    oracle — a foreign id no longer trips a unique conflict in this tenant.
  await sql`ALTER TABLE media DROP CONSTRAINT media_pkey`.execute(db);
  await sql`ALTER TABLE media ADD PRIMARY KEY (tenant_id, id)`.execute(db);
  // 4. Re-establish the chunk FK on the composite key.
  await sql`
    ALTER TABLE media_chunks
      ADD CONSTRAINT media_chunks_media_id_fkey
      FOREIGN KEY (tenant_id, media_id) REFERENCES media (tenant_id, id)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Reverse order. NOTE: the down migration reintroduces the global-id oracle by construction — it
  // exists for schema symmetry, not as a safe state to run in production. A tenant holding a
  // duplicate id (legal after `up`) would make `ADD PRIMARY KEY (id)` fail; that is correct — you
  // cannot restore global uniqueness once two tenants share an id.
  await sql`ALTER TABLE media_chunks DROP CONSTRAINT media_chunks_media_id_fkey`.execute(db);
  await sql`ALTER TABLE media_chunks DROP CONSTRAINT media_chunks_pkey`.execute(db);
  await sql`ALTER TABLE media_chunks ADD PRIMARY KEY (media_id, chunk_index)`.execute(db);
  await sql`ALTER TABLE media DROP CONSTRAINT media_pkey`.execute(db);
  await sql`ALTER TABLE media ADD PRIMARY KEY (id)`.execute(db);
  await sql`
    ALTER TABLE media_chunks
      ADD CONSTRAINT media_chunks_media_id_fkey
      FOREIGN KEY (media_id) REFERENCES media (id)
  `.execute(db);
}
