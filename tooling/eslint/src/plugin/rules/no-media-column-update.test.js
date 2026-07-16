import { RuleTester } from 'eslint';
import { describe, it } from 'vitest';

import rule from './no-media-column-update.js';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

tester.run('no-media-column-update', rule, {
  valid: [
    // The bookkeeping columns the drain loop legitimately writes (06 §4) — every one of these is a
    // real statement from packages/core/src/media/repository.ts. If the rule flagged them the
    // engine could not be written at all, which is the failure mode a too-broad column list has.
    { code: "await sql`UPDATE media_items SET upload_status = 'uploading' WHERE id = ${id}`;" },
    {
      code: "await sql`UPDATE media_items SET upload_status = 'uploaded', uploaded_at = ${at}, upload_attempts = 0 WHERE id = ${id}`;",
    },
    {
      code: 'await sql`UPDATE media_items SET upload_attempts = upload_attempts + 1, last_error_code = ${code}, next_attempt_at = ${next} WHERE id = ${id}`;',
    },
    { code: 'await sql`UPDATE media_items SET local_path = NULL WHERE id = ${id}`;' },
    {
      code: 'await sql`UPDATE media_items SET chunk_size = ${n}, chunks_total = ${t} WHERE id = ${id}`;',
    },
    // Reading an immutable column in a WHERE clause is not writing it. A naive
    // /update[\s\S]*media_items[\s\S]*sha256/ would flag this and make the rule useless.
    { code: "await sql`UPDATE media_items SET upload_status = 'failed' WHERE sha256 = ${h}`;" },
    { code: 'await sql`UPDATE media_items SET local_path = NULL WHERE captured_at < ${cutoff}`;' },
    // SELECTing them is fine.
    { code: 'await sql`SELECT sha256, captured_at, device_id FROM media_items WHERE id = ${id}`;' },
    // INSERT is the capture path — that is where these columns are legitimately set, once.
    {
      code: 'await db.insertInto("media_items").values({ sha256, capturedAt, deviceId, type, mimeType, byteSize }).execute();',
    },
    // A different table's sha256 is not our business.
    { code: 'await db.updateTable("operations").set({ sha256 }).execute();' },
    { code: 'await sql`UPDATE quarantined_ops SET sha256 = ${h}`;' },
    // Kysely bookkeeping writes.
    {
      code: 'await db.updateTable("mediaItems").set({ uploadStatus: "uploaded", uploadedAt: at }).execute();',
    },
    { code: 'await db.updateTable("mediaItems").set({ localPath: null }).execute();' },
    // DELETE is deliberately NOT this rule's business — 06 §7's orphan rule requires it.
    { code: 'await db.deleteFrom("mediaItems").where("id", "=", id).execute();' },
    { code: 'await sql`DELETE FROM media_items WHERE id = ${id}`;' },
    // An allowlisted adversarial test may construct the mutation in order to prove it is refused.
    {
      code: 'await db.updateTable("mediaItems").set({ sha256: other }).execute();',
      options: [{ allowFiles: ['packages/core/test/media/adversarial.test.ts'] }],
      filename: '/repo/packages/core/test/media/adversarial.test.ts',
    },
  ],
  invalid: [
    // Each of 06 §4/§3.2's eight frozen columns, raw SQL — the prong that matters, because the
    // client media repository is written in raw sql templates.
    {
      code: 'await sql`UPDATE media_items SET captured_at = ${t} WHERE id = ${id}`;',
      errors: [{ messageId: 'rawSqlImmutableColumn' }],
    },
    {
      code: 'await sql`UPDATE media_items SET location = ${loc} WHERE id = ${id}`;',
      errors: [{ messageId: 'rawSqlImmutableColumn' }],
    },
    {
      code: 'await sql`UPDATE media_items SET captured_by_user_id = ${u} WHERE id = ${id}`;',
      errors: [{ messageId: 'rawSqlImmutableColumn' }],
    },
    {
      code: 'await sql`UPDATE media_items SET device_id = ${d} WHERE id = ${id}`;',
      errors: [{ messageId: 'rawSqlImmutableColumn' }],
    },
    {
      code: "await sql`UPDATE media_items SET type = 'signature' WHERE id = ${id}`;",
      errors: [{ messageId: 'rawSqlImmutableColumn' }],
    },
    {
      code: "await sql`UPDATE media_items SET mime_type = 'image/png' WHERE id = ${id}`;",
      errors: [{ messageId: 'rawSqlImmutableColumn' }],
    },
    {
      code: 'await sql`UPDATE media_items SET byte_size = ${n} WHERE id = ${id}`;',
      errors: [{ messageId: 'rawSqlImmutableColumn' }],
    },
    {
      code: 'await sql`UPDATE media_items SET sha256 = ${h} WHERE id = ${id}`;',
      errors: [{ messageId: 'rawSqlImmutableColumn' }],
    },
    // The attach-then-replace shape (FR-819): a legal bookkeeping column smuggling a frozen one
    // alongside it. This is the case a table-level rule would wave through.
    {
      code: "await sql`UPDATE media_items SET upload_status = 'pending', sha256 = ${h} WHERE id = ${id}`;",
      errors: [{ messageId: 'rawSqlImmutableColumn' }],
    },
    // A plain string literal, not just a template.
    {
      code: 'await run("UPDATE media_items SET sha256 = ?");',
      errors: [{ messageId: 'rawSqlImmutableColumn' }],
    },
    // Case and quoting variants — the same class, not the one instance I thought of (T-12).
    {
      code: 'await run("update media_items set SHA256 = ?");',
      errors: [{ messageId: 'rawSqlImmutableColumn' }],
    },
    {
      code: 'await run(\'UPDATE "media_items" SET "captured_at" = ?\');',
      errors: [{ messageId: 'rawSqlImmutableColumn' }],
    },
    // Multi-line, as the repository actually writes them.
    {
      code: 'await sql`\n  UPDATE media_items\n  SET device_id = ${d}\n  WHERE id = ${id}\n`;',
      errors: [{ messageId: 'rawSqlImmutableColumn' }],
    },
    // Kysely prong, camelCase keys.
    {
      code: 'await db.updateTable("mediaItems").set({ sha256 }).execute();',
      errors: [{ messageId: 'immutableColumn' }],
    },
    {
      code: 'await db.updateTable("media_items").set({ capturedAt: t }).execute();',
      errors: [{ messageId: 'immutableColumn' }],
    },
    {
      code: 'await db.updateTable("mediaItems").set({ uploadStatus: "pending", deviceId: d }).execute();',
      errors: [{ messageId: 'immutableColumn' }],
    },
    // Fail closed: a dynamic or spread .set() cannot be proven free of the frozen columns.
    {
      code: 'await db.updateTable("mediaItems").set(patch).execute();',
      errors: [{ messageId: 'immutableColumnDynamic' }],
    },
    {
      code: 'await db.updateTable("mediaItems").set({ ...patch }).execute();',
      errors: [{ messageId: 'immutableColumnDynamic' }],
    },
    {
      code: 'await db.updateTable("mediaItems").set({ [col]: v }).execute();',
      errors: [{ messageId: 'immutableColumnDynamic' }],
    },
    // The allowlist is EXACT-FILE: another test file is not covered by a sibling's exemption.
    {
      code: 'await db.updateTable("mediaItems").set({ sha256: other }).execute();',
      options: [{ allowFiles: ['packages/core/test/media/adversarial.test.ts'] }],
      filename: '/repo/packages/core/test/media/drain.test.ts',
      errors: [{ messageId: 'immutableColumn' }],
    },
  ],
});
