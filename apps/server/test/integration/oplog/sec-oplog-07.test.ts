// SEC-OPLOG-07 no mutation path (security-guide §3.2) — the op log is append-only (05 §1,
// FR-831), enforced three ways. This test stands on the DB legs that task 05 installed and adds
// the leg this task owns: the ACCEPTANCE PATH itself only ever INSERTs.
//
// Ownership note (for task 31): this task file's own acceptance line attributes SEC-OPLOG-07 to
// task 05, but packages/test-support/src/sec-pending-allowlist.json maps it to task 07 and
// db-server/test/append-only.test.ts deliberately does NOT title it ("SEC-OPLOG-07 is NOT titled
// here on purpose: security-guide §3.2 scopes it to the full rejection pipeline"). The allowlist
// + that comment win; the id ships here.
//
// Legs (a) lint rule and (b) grants/trigger are asserted below; leg (c) is db-client's.
import { sql } from 'kysely';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import { ChainBuilder, makeWorld } from '@bolusi/test-support';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { serverCryptoPort } from '../../../src/oplog/crypto.js';
import { processPushBatch } from '../../../src/oplog/pipeline.js';
import { makeDeps, makeOplogTestDb, readOps, seedWorld, type OplogTestDb } from './helpers.js';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../..');

let testDb: OplogTestDb;

beforeEach(async () => {
  testDb = await makeOplogTestDb();
}, 120_000);

afterEach(async () => {
  await testDb?.close();
});

async function acceptOneOp() {
  const world = makeWorld(6001, serverCryptoPort);
  await seedWorld(testDb.db, world);
  const builder = new ChainBuilder(world, serverCryptoPort);
  const genesis = builder.genesis();
  await processPushBatch(
    makeDeps({ forTenant: testDb.appForTenant }),
    {
      deviceId: world.deviceId,
      tenantId: world.tenantId,
    },
    [genesis],
  );
  return { world, genesis };
}

describe('SEC-OPLOG-07 no mutation path — DB level', () => {
  test('SEC-OPLOG-07 UPDATE on operations as the app role is denied', async () => {
    const { world, genesis } = await acceptOneOp();

    const outcome = await testDb.appForTenant(world.tenantId, async (db) => {
      try {
        await db
          .updateTable('operations')
          .set({ signature: 'forged' })
          .where('id', '=', genesis.id)
          .execute();
        return 'ALLOWED';
      } catch (error) {
        return String(error);
      }
    });

    // Two independent reasons this must fail: bolusi_app holds SELECT/INSERT only (the grant), and
    // the BEFORE UPDATE trigger raises regardless of role (the belt). Either message is a pass;
    // 'ALLOWED' is the failure this test exists to catch.
    expect(outcome).toMatch(/permission denied|append-only/i);
  });

  test('SEC-OPLOG-07 DELETE on operations as the app role is denied', async () => {
    const { world, genesis } = await acceptOneOp();

    const outcome = await testDb.appForTenant(world.tenantId, async (db) => {
      try {
        await db.deleteFrom('operations').where('id', '=', genesis.id).execute();
        return 'ALLOWED';
      } catch (error) {
        return String(error);
      }
    });

    expect(outcome).toMatch(/permission denied|append-only/i);
  });

  test('SEC-OPLOG-07 the append-only trigger fires even for the table owner', async () => {
    const { genesis } = await acceptOneOp();

    // The braces behind the grant: a future role misconfiguration must not open a mutation path.
    await expect(
      testDb.db
        .updateTable('operations')
        .set({ signature: 'forged' })
        .where('id', '=', genesis.id)
        .execute(),
    ).rejects.toThrow(/append-only/i);
    await expect(
      testDb.db.deleteFrom('operations').where('id', '=', genesis.id).execute(),
    ).rejects.toThrow(/append-only/i);
  });

  test('SEC-OPLOG-07 the accepted op survives every mutation attempt byte-identical', async () => {
    const { world, genesis } = await acceptOneOp();
    const [before] = await readOps(testDb.db, world.tenantId);

    await testDb
      .appForTenant(world.tenantId, (db) =>
        db
          .updateTable('operations')
          .set({ signature: 'forged' })
          .where('id', '=', genesis.id)
          .execute(),
      )
      .catch(() => undefined);
    await testDb.db
      .updateTable('operations')
      .set({ signature: 'forged' })
      .where('id', '=', genesis.id)
      .execute()
      .catch(() => undefined);

    const [after] = await readOps(testDb.db, world.tenantId);
    expect(after?.signature).toBe(before?.signature);
    expect(after?.signedCoreJcs).toBe(before?.signedCoreJcs);
    expect(after?.hash).toBe(genesis.hash);
  });

  test('SEC-OPLOG-07 the app role CAN still SELECT and INSERT (non-vacuous control)', async () => {
    // Without this, the denials above could pass because bolusi_app cannot touch the table at all —
    // proving nothing about the append-only grant matrix specifically.
    const { world } = await acceptOneOp();

    const rows = await testDb.appForTenant(world.tenantId, (db) =>
      db.selectFrom('operations').select('id').execute(),
    );

    expect(rows).toHaveLength(1);
  });

  test('SEC-OPLOG-07 the app role is denied TRUNCATE on operations', async () => {
    const { world } = await acceptOneOp();

    const outcome = await testDb.appForTenant(world.tenantId, async (db) => {
      try {
        await sql`TRUNCATE operations`.execute(db);
        return 'ALLOWED';
      } catch (error) {
        return String(error);
      }
    });

    expect(outcome).toMatch(/permission denied|must be owner/i);
  });
});

describe('SEC-OPLOG-07 no mutation path — the acceptance path only INSERTs', () => {
  test('SEC-OPLOG-07 a full push emits no UPDATE or DELETE against operations', async () => {
    const world = makeWorld(6002, serverCryptoPort);
    await seedWorld(testDb.db, world);
    const builder = new ChainBuilder(world, serverCryptoPort);
    testDb.appStatements.length = 0;

    await processPushBatch(
      makeDeps({ forTenant: testDb.appForTenant }),
      { deviceId: world.deviceId, tenantId: world.tenantId },
      [
        builder.genesis(),
        builder.append({
          type: 'notes.note_created',
          entityType: 'note',
          payload: { title: 'a', body: 'b' },
        }),
      ],
    );

    const opsStatements = testDb.appStatements.filter((s) => /"operations"/i.test(s));
    // Denominator (T-14): the push really did touch the table — so "no UPDATE" is a fact about
    // this run, not an empty filter reading as clean.
    expect(opsStatements.length).toBeGreaterThan(0);
    expect(opsStatements.filter((s) => /^\s*update\s+"operations"/i.test(s))).toEqual([]);
    expect(opsStatements.filter((s) => /^\s*delete\s+from\s+"operations"/i.test(s))).toEqual([]);
  });
});

describe('SEC-OPLOG-07 no mutation path — lint level', () => {
  async function lintFixture(code: string, filePath: string): Promise<string[]> {
    const eslint = new ESLint({ cwd: REPO_ROOT });
    const results = await eslint.lintText(code, { filePath: resolve(REPO_ROOT, filePath) });
    return results.flatMap((r) => r.messages.map((m) => `${m.ruleId ?? 'unknown'}: ${m.message}`));
  }

  // Linted as a virtual *.test.ts under a real workspace: the `bolusi/server-typed` block turns on
  // typescript-eslint's projectService for apps/server/src/**/*.ts but IGNORES *.test.ts, so this
  // path gets the syntactic rules without a program lookup that would reject a non-existent file.
  const FIXTURE = 'packages/harness/src/__fixture-oplog-mutation__.test.ts';

  test('SEC-OPLOG-07 a lint fixture containing UPDATE on operations fails the build', async () => {
    const messages = await lintFixture(
      `import { sql } from 'kysely';\nexport const bad = (db: any) => db.updateTable('operations').set({ signature: 'x' }).execute();\nvoid sql;\n`,
      FIXTURE,
    );

    expect(messages.join('\n')).toMatch(/bolusi\/no-op-table-update/);
  });

  test('SEC-OPLOG-07 a lint fixture containing DELETE on operations fails the build', async () => {
    const messages = await lintFixture(
      `export const bad = (db: any) => db.deleteFrom('operations').where('id', '=', 'x').execute();\n`,
      FIXTURE,
    );

    expect(messages.join('\n')).toMatch(/bolusi\/no-op-table-update/);
  });

  test('SEC-OPLOG-07 an INSERT into operations passes lint (append is the sanctioned write)', async () => {
    // The negative control: the rule is COLUMN-aware and INSERT-tolerant (task 06). If it rejected
    // everything, the two tests above would pass for the wrong reason — and the acceptance path,
    // which must INSERT accepted ops, could not exist.
    const messages = await lintFixture(
      `export const ok = (db: any) => db.insertInto('operations').values({ id: 'x' }).execute();\n`,
      FIXTURE,
    );

    expect(messages.join('\n')).not.toMatch(/bolusi\/no-op-table-update/);
  });
});
