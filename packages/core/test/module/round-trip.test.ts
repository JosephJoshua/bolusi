// The module contract, end to end (04-module-contract §1/§5/§6; 02-permissions §4/§9).
//
// Register → command → op → projection → query, through REAL runtimes over a REAL SQLite database
// (testing-guide §2.1 L2). This is the suite that proves the seam actually joins up; the unit
// suites prove each piece in isolation.
//
// Everything here asserts an OUTCOME, never a mechanism. Task 10's review established why: a test
// asserting "the permission check was called" is defeated by changing `await check()` to `void
// check()` — the check still runs, its verdict is discarded, and the spy still sees the call. A test
// asserting "the forbidden field is ABSENT from the result" cannot be defeated that way, because
// that IS the property 02 §9 requires.
import { describe, expect, test } from 'vitest';

import { DomainError, type CommandContext } from '../../src/index.js';
import {
  FIXTURE_SECRET_PERMISSION,
  type CreateItemInput,
  type FixtureItemRow,
  type ListItemsInput,
} from '@bolusi/test-support';
import { openModuleHarness, type ModuleHarness } from './_harness.js';

/** The fixture's command/query, typed for the call sites. */
type CreateItem = Parameters<ModuleHarness['commands']['execute']>[0];

function createItemCommand(harness: ModuleHarness): CreateItem {
  return harness.module.commands!.createItem as unknown as CreateItem;
}

function listItemsQuery(harness: ModuleHarness): never {
  return harness.module.queries!.listItems as never;
}

/** Run `listItems` as `userId`. */
async function listItems(
  harness: ModuleHarness,
  userId: string,
  input: Partial<ListItemsInput> = {},
): Promise<{ rows: readonly FixtureItemRow[]; nextCursor: string | null }> {
  return harness.queries.execute(listItemsQuery(harness), input as never, {
    tenantId: harness.tenantId,
    storeId: harness.storeId,
    userId,
    deviceId: harness.deviceId,
  }) as Promise<{ rows: readonly FixtureItemRow[]; nextCursor: string | null }>;
}

/** Create one item as `userId`, advancing the clock so `createdAt` is distinct per item. */
async function createItem(
  harness: ModuleHarness,
  userId: string,
  input: CreateItemInput,
): Promise<void> {
  const ctx: CommandContext = harness.commands.createContext(userId);
  await harness.commands.execute(createItemCommand(harness), input as never, ctx);
  harness.advanceClock(1_000);
}

async function expectDomainError(promise: Promise<unknown>, code: string): Promise<DomainError> {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  if (!(error instanceof DomainError)) {
    throw new Error(`expected DomainError(${code}), got ${String(error)}`);
  }
  expect(error.code).toBe(code);
  return error;
}

describe('round-trip: register → command → op → projection → query (04 §1/§5/§6)', () => {
  test('a command appends its op, the engine projects it, and the query returns the row', async () => {
    const harness = await openModuleHarness(301);
    try {
      await createItem(harness, harness.adminId, { label: 'ledger-301', secretNote: 'hidden-301' });

      // The op reached the log, with the registry's schemaVersion — not a default (04 §3).
      expect(harness.appended).toHaveLength(1);
      const op = harness.appended[0]!;
      expect(op.type).toBe('fixture.item_created');
      expect(op.schemaVersion).toBe(1);
      expect(op.entityType).toBe('fixture_item');

      // ...the projection applied it, and the query — the real one, through the real runtime —
      // returns it. `nextCursor: null` because one row is the whole list (04 §6).
      const page = await listItems(harness, harness.adminId);
      expect(page.rows).toHaveLength(1);
      expect(page.rows[0]!.label).toBe('ledger-301');
      expect(page.nextCursor).toBeNull();
    } finally {
      await harness.close();
    }
  });

  test('the op carries the schemaVersion the operation registry declares (task 10 stopgap resolved)', async () => {
    // `ctx.op()` no longer defaults to 1 — it resolves from the 04 §3 registry. Asserting the value
    // alone would be indistinguishable from the old default, so the NEXT test asserts the property
    // that only a real lookup can satisfy.
    const harness = await openModuleHarness(302);
    try {
      await createItem(harness, harness.adminId, { label: 'ledger-302', secretNote: 'hidden-302' });

      expect(harness.appended[0]!.schemaVersion).toBe(
        harness.registry.operations.schemaVersionFor('fixture.item_created'),
      );
    } finally {
      await harness.close();
    }
  });

  test('a handler emitting an UNDECLARED op type fails rather than defaulting its version', async () => {
    // The property the old `?? 1` default could not have: an op type no module declares has no
    // applier either, so an op of that type would sync everywhere and be folded by nobody. This is
    // what proves the resolution is a real registry lookup and not a constant.
    const harness = await openModuleHarness(303);
    try {
      const rogue = {
        name: 'rogueCommand',
        permission: 'fixture.create',
        input: { parse: (raw: unknown) => raw as CreateItemInput },
        handler: (_input: CreateItemInput, ctx: CommandContext) => ({
          ops: [
            ctx.op({
              type: 'fixture.never_declared',
              entityType: 'fixture_item',
              entityId: ctx.newId(),
              payload: {},
            }),
          ],
        }),
      };
      const ctx = harness.commands.createContext(harness.adminId);

      const error = await expectDomainError(
        harness.commands.execute(rogue as never, { label: 'x', secretNote: 'y' }, ctx),
        'VALIDATION_FAILED',
      );
      expect(error.message).toContain('fixture.never_declared');
      // Nothing was appended: the failure is before the write, not after it.
      expect(harness.appended).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });
});

describe('query permission denial (02 §4, FR-1036; security-guide §2.2)', () => {
  test('a caller without the query’s permission gets PERMISSION_DENIED, NOT an empty page', async () => {
    // THE rule: "a denial is always an explicit error, never an empty result" (02 §4). An empty page
    // leaks "the store exists and is quiet" AND is indistinguishable from a legitimate empty list.
    const harness = await openModuleHarness(311);
    try {
      await createItem(harness, harness.adminId, { label: 'ledger-311', secretNote: 'hidden-311' });

      await expectDomainError(listItems(harness, harness.zeroGrantId), 'PERMISSION_DENIED');
    } finally {
      await harness.close();
    }
  });

  test('the rows the denied caller did not receive DO exist (T-14b: assert the fixture)', async () => {
    // Without this, the denial test above would pass identically against an empty database — i.e.
    // it would be green whether the gate worked or the fixture was broken. THIS is what makes the
    // denial assertion mean "denied" rather than "there was nothing to return anyway".
    const harness = await openModuleHarness(312);
    try {
      await createItem(harness, harness.adminId, { label: 'ledger-312', secretNote: 'hidden-312' });

      const authorized = await listItems(harness, harness.adminId);
      expect(authorized.rows).toHaveLength(1);

      await expectDomainError(listItems(harness, harness.zeroGrantId), 'PERMISSION_DENIED');
    } finally {
      await harness.close();
    }
  });

  test('a query denial emits a denial op with surface "query" and the query name as target (02 §7)', async () => {
    const harness = await openModuleHarness(313);
    try {
      await expectDomainError(listItems(harness, harness.zeroGrantId), 'PERMISSION_DENIED');

      const denials = harness.appended.filter((op) => op.type === 'auth.permission_denied');
      expect(denials).toHaveLength(1);
      const payload = denials[0]!.payload as unknown as {
        surface: string;
        target: string;
        permissionId: string;
        reason: string;
      };
      expect(payload.surface).toBe('query');
      expect(payload.target).toBe('listItems');
      expect(payload.permissionId).toBe('fixture.read');
      expect(payload.reason).toBe('not_granted');
    } finally {
      await harness.close();
    }
  });

  test('a query denial is attributed to the DENIED user, not the device owner', async () => {
    const harness = await openModuleHarness(314);
    try {
      await expectDomainError(listItems(harness, harness.zeroGrantId), 'PERMISSION_DENIED');

      const denial = harness.appended.find((op) => op.type === 'auth.permission_denied');
      expect(denial?.userId).toBe(harness.zeroGrantId);
    } finally {
      await harness.close();
    }
  });

  test('an over-large limit is VALIDATION_FAILED before the handler runs (04 §6 max(100))', async () => {
    const harness = await openModuleHarness(315);
    try {
      await expectDomainError(
        listItems(harness, harness.adminId, { limit: 101 }),
        'VALIDATION_FAILED',
      );
    } finally {
      await harness.close();
    }
  });

  test('a tampered cursor is VALIDATION_FAILED, never a silent restart from page one', async () => {
    const harness = await openModuleHarness(316);
    try {
      await createItem(harness, harness.adminId, { label: 'ledger-316', secretNote: 'hidden-316' });

      await expectDomainError(
        listItems(harness, harness.adminId, { cursor: 'not-a-real-cursor' }),
        'VALIDATION_FAILED',
      );
    } finally {
      await harness.close();
    }
  });
});

describe('COLUMN GATING — the mandated adversarial test (02 §9.3; CLAUDE.md §2.5)', () => {
  test('an unauthorized caller’s rows OMIT the gated key entirely — absent, not null, not masked', async () => {
    // 02 §9.2, asserted as the outcome: `'secretNote' in row === false`. Not `=== null`, not
    // `=== '***'`. Absence is the contract, because `null` is indistinguishable from real data.
    const harness = await openModuleHarness(321);
    try {
      await createItem(harness, harness.adminId, { label: 'ledger-321', secretNote: 'hidden-321' });

      const page = await listItems(harness, harness.readerId);

      expect(page.rows).toHaveLength(1);
      const row = page.rows[0]!;
      expect('secretNote' in row).toBe(false);
      expect(row.secretNote).toBeUndefined();
      // And the value is nowhere in the payload at all — not under another key, not stringified.
      expect(JSON.stringify(page)).not.toContain('hidden-321');
    } finally {
      await harness.close();
    }
  });

  test('POSITIVE CONTROL: an authorized caller DOES receive the gated field (T-14b)', async () => {
    // Without this, the absence test above passes against a broken fixture — a column that is
    // always missing, a query that never selects it, a typo in the key. The gate is only proven by
    // the pair: one caller sees it, the other does not, same row, same query.
    const harness = await openModuleHarness(322);
    try {
      await createItem(harness, harness.adminId, { label: 'ledger-322', secretNote: 'hidden-322' });

      const page = await listItems(harness, harness.secretReaderId);

      expect(page.rows).toHaveLength(1);
      expect('secretNote' in page.rows[0]!).toBe(true);
      expect(page.rows[0]!.secretNote).toBe('hidden-322');
    } finally {
      await harness.close();
    }
  });

  test('the two callers differ ONLY by the gating permission — same row, same query', async () => {
    // Pins that the difference is the PERMISSION and nothing else: same database, same item, same
    // query, two users whose roles differ by exactly `fixture.read_secret`. If the absence came
    // from a different store, a different row, or a different code path, this fails.
    const harness = await openModuleHarness(323);
    try {
      await createItem(harness, harness.adminId, { label: 'ledger-323', secretNote: 'hidden-323' });

      const denied = await listItems(harness, harness.readerId);
      const allowed = await listItems(harness, harness.secretReaderId);

      expect(denied.rows[0]!.id).toBe(allowed.rows[0]!.id);
      expect(denied.rows[0]!.label).toBe(allowed.rows[0]!.label);
      expect('secretNote' in denied.rows[0]!).toBe(false);
      expect('secretNote' in allowed.rows[0]!).toBe(true);
    } finally {
      await harness.close();
    }
  });

  test('gating holds across a multi-row page — the CLASS, not one row (T-12)', async () => {
    // A gate implemented with a `rows[0]`-shaped bug would pass a single-row test. Every row must
    // omit the key.
    const harness = await openModuleHarness(324);
    try {
      for (let i = 0; i < 5; i += 1) {
        await createItem(harness, harness.adminId, {
          label: `ledger-324-${i}`,
          secretNote: `hidden-324-${i}`,
        });
      }

      const page = await listItems(harness, harness.readerId);

      expect(page.rows).toHaveLength(5);
      for (const row of page.rows) {
        expect('secretNote' in row).toBe(false);
      }
      // The denominator: 5 rows really were there to leak.
      const allowed = await listItems(harness, harness.secretReaderId);
      expect(allowed.rows.filter((row) => 'secretNote' in row)).toHaveLength(5);
    } finally {
      await harness.close();
    }
  });

  test('gating is enforced with NO UI layer present — it lives in the handler (02 §9.1)', async () => {
    // FR-1029 / 02 §9.1: the gate is in the query handler, never in the UI. This whole suite is the
    // proof — there is no React, no screen, no component anywhere in it, and the gated field is
    // still absent. The V2 agent (FR-1028) calls exactly this path and never sees a button.
    const harness = await openModuleHarness(325);
    try {
      await createItem(harness, harness.adminId, { label: 'ledger-325', secretNote: 'hidden-325' });

      const page = await listItems(harness, harness.readerId);

      expect('secretNote' in page.rows[0]!).toBe(false);
    } finally {
      await harness.close();
    }
  });

  test('a gated field emits NO denial op — gating is not a denied attempt (02 §7)', async () => {
    // The distinction that keeps the audit log readable: `qctx.hasPermission` shapes a result the
    // caller IS entitled to receive. Emitting a denial op per gated field per row would bury the
    // real denials under thousands of rows — which is what the §7 throttle exists to prevent.
    const harness = await openModuleHarness(326);
    try {
      await createItem(harness, harness.adminId, { label: 'ledger-326', secretNote: 'hidden-326' });
      const before = harness.appended.filter((op) => op.type === 'auth.permission_denied').length;

      await listItems(harness, harness.readerId);

      const after = harness.appended.filter((op) => op.type === 'auth.permission_denied').length;
      expect(after).toBe(before);
    } finally {
      await harness.close();
    }
  });
});

describe('qctx surface (04 §6)', () => {
  test('exposes exactly { db, tenantId, storeId, userId, hasPermission } — nothing more', async () => {
    // The spec's list is exhaustive, so the KEY SET is the assertion (the exact set, not a sample —
    // a `toContain` check would not notice a `clock` or an `op` appearing).
    const harness = await openModuleHarness(331);
    try {
      let captured: object | null = null;
      const probe = {
        name: 'probeQuery',
        permission: 'fixture.read',
        input: { parse: (raw: unknown) => raw },
        handler: (_input: unknown, qctx: object) => {
          captured = qctx;
          return { rows: [], nextCursor: null };
        },
      };

      await harness.queries.execute(probe as never, {} as never, {
        tenantId: harness.tenantId,
        storeId: harness.storeId,
        userId: harness.adminId,
        deviceId: harness.deviceId,
      });

      expect(Object.keys(captured!).sort()).toEqual([
        'db',
        'hasPermission',
        'storeId',
        'tenantId',
        'userId',
      ]);
    } finally {
      await harness.close();
    }
  });

  test('qctx.hasPermission answers for the CALLER, from the real evaluator', async () => {
    const harness = await openModuleHarness(332);
    try {
      const answers: boolean[] = [];
      const probe = {
        name: 'permProbe',
        permission: 'fixture.read',
        input: { parse: (raw: unknown) => raw },
        handler: (_input: unknown, qctx: { hasPermission(id: string): boolean }) => {
          answers.push(qctx.hasPermission(FIXTURE_SECRET_PERMISSION));
          return { rows: [], nextCursor: null };
        },
      };
      const identity = (userId: string) => ({
        tenantId: harness.tenantId,
        storeId: harness.storeId,
        userId,
        deviceId: harness.deviceId,
      });

      await harness.queries.execute(probe as never, {} as never, identity(harness.secretReaderId));
      await harness.queries.execute(probe as never, {} as never, identity(harness.readerId));

      expect(answers).toEqual([true, false]);
    } finally {
      await harness.close();
    }
  });
});

describe('qctx.db is READ-ONLY (04 §6)', () => {
  /** Attempt `method` through qctx.db inside a real query, and return what happened. */
  async function attemptThroughQctx(
    harness: ModuleHarness,
    attempt: (db: Record<string, (...args: unknown[]) => unknown>) => unknown,
  ): Promise<unknown> {
    let thrown: unknown = null;
    const probe = {
      name: 'writeProbe',
      permission: 'fixture.read',
      input: { parse: (raw: unknown) => raw },
      handler: (_input: unknown, qctx: { db: unknown }) => {
        try {
          attempt(qctx.db as Record<string, (...args: unknown[]) => unknown>);
        } catch (error) {
          thrown = error;
        }
        return { rows: [], nextCursor: null };
      },
    };
    await harness.queries.execute(probe as never, {} as never, {
      tenantId: harness.tenantId,
      storeId: harness.storeId,
      userId: harness.adminId,
      deviceId: harness.deviceId,
    });
    return thrown;
  }

  test.each([
    [
      'insertInto',
      (db: Record<string, (...a: unknown[]) => unknown>) => db.insertInto!('fixtureItems'),
    ],
    [
      'updateTable',
      (db: Record<string, (...a: unknown[]) => unknown>) => db.updateTable!('fixtureItems'),
    ],
    [
      'deleteFrom',
      (db: Record<string, (...a: unknown[]) => unknown>) => db.deleteFrom!('fixtureItems'),
    ],
    [
      'replaceInto',
      (db: Record<string, (...a: unknown[]) => unknown>) => db.replaceInto!('fixtureItems'),
    ],
    ['destroy', (db: Record<string, (...a: unknown[]) => unknown>) => db.destroy!()],
    ['transaction', (db: Record<string, (...a: unknown[]) => unknown>) => db.transaction!()],
    // The escape hatches, enumerated as a CLASS (T-12) rather than as the writes I thought of:
    // `getExecutor` reaches every statement via raw `sql`; `with` hands its callback a full
    // QueryCreator (so `db.with('x', qb => qb.insertInto(...))` is a write through a read-shaped
    // door, and on Postgres a data-modifying CTE genuinely writes); `schema` is DDL.
    ['getExecutor', (db: Record<string, (...a: unknown[]) => unknown>) => db.getExecutor!()],
    ['with', (db: Record<string, (...a: unknown[]) => unknown>) => db.with!('x', () => undefined)],
    ['schema', (db: Record<string, (...a: unknown[]) => unknown>) => db.schema],
  ])('rejects qctx.db.%s', async (name, attempt) => {
    const harness = await openModuleHarness(340 + name.length);
    try {
      const thrown = await attemptThroughQctx(harness, attempt);

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).name).toBe('ReadOnlyDbError');
    } finally {
      await harness.close();
    }
  });

  test('a write CANNOT reach the database through qctx.db — the outcome, not the throw', async () => {
    // The outcome assertion behind the throws above: even if a future refactor made the guard
    // return something instead of throwing, the row count must not move.
    const harness = await openModuleHarness(351);
    try {
      await createItem(harness, harness.adminId, { label: 'ledger-351', secretNote: 'hidden-351' });
      const before = await harness.db.selectFrom('fixtureItems').selectAll().execute();

      await attemptThroughQctx(harness, (db) => db.deleteFrom!('fixtureItems'));

      const after = await harness.db.selectFrom('fixtureItems').selectAll().execute();
      expect(after).toHaveLength(before.length);
      expect(before).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  test('reads still work through qctx.db — the guard is not just "everything throws"', async () => {
    // The positive control for the whole block: a `readOnlyDb` that threw on EVERYTHING would pass
    // every rejection test above and make the query layer useless.
    const harness = await openModuleHarness(352);
    try {
      await createItem(harness, harness.adminId, { label: 'ledger-352', secretNote: 'hidden-352' });

      const page = await listItems(harness, harness.adminId);

      expect(page.rows).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });
});
