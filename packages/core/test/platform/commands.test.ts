// The `platform` module's commands + queries against the REAL command/query runtimes.
//
// ── WHY THIS FILE EXISTS (review-17, F1/F2) ───────────────────────────────────────────────────
//
// F1. The 01 §6 tenant-scope mechanism shipped with **zero test witnesses**. review-17 deleted it
// outright and ran the full suite: `tsc -b` EXIT=0, 187 files / 2633 passed, EXIT=0 — **not one of
// 2633 tests noticed**, and `git grep -lE "resolveScope|scopeFor|conflictFor" -- '**/*.test.ts'`
// returned zero files. Meanwhile it is live at `ctx.ts`, deciding every op's `storeId`.
//
// That is the same shape this task spent its whole length proving elsewhere: **`tsc` cannot see
// composition, only a test driving the real path can.** I proved a missing `SERVER_MODULES` entry
// is a well-typed empty list, then shipped a mechanism with no witness two files away. The failure
// it is waiting for is silent and specific: `setLocale` emits a STORE-scoped op, the preference
// reaches only the emitting store's devices, `user_prefs` never folds elsewhere, and task 21's
// notification falls back to the default — the exact trap task 17 exists to close, reintroduced one
// layer up. It cannot bite today only because no client calls `setLocale` yet.
//
// F2. §2.5: access control ships its adversarial tests IN the task, before review — "the review gate
// is the backstop, not the plan". My earlier claim that these needed a device DB was WRONG, and
// review-17's counter is exact: **denial is execute step 2, BEFORE the handler's read**, so the
// denial legs need no DB at all. The query-denial leg below goes further and hands the runtime a db
// that THROWS if touched — so "denied" cannot be confused with "ran and returned nothing".
//
// The one leg genuinely out of reach is `setLocale` END-TO-END (op → `user_prefs` row → a second
// device reading it), which needs the client runtime over a device DB — tasks 24/25/50. The op it
// emits is asserted here; the fold is asserted by the server registration suite and the T-8
// conformance suite.
import { DomainError } from '../../src/errors/domain-error.js';
import { registerModules, type AnyModuleDefinition } from '../../src/module/registry.js';
import { platformModule } from '../../src/platform/index.js';
import { QueryRuntime } from '../../src/query/execute.js';
import type { SignedOperation } from '@bolusi/schemas';
import type { Kysely } from 'kysely';

import type { AppendedOp } from '../../src/oplog/append.js';
import { beforeEach, describe, expect, test } from 'vitest';

import { makeRuntimeFixture, type RuntimeFixture } from '../runtime/_fixtures.js';

/**
 * The REAL platform registry — `registerModules` over the shipped manifest.
 *
 * Not a hand-built map: `ctx.op()` reads `scopeFor` from this to decide `storeId`, so a fixture
 * registry would be asserting its own opinion of the manifest rather than the manifest (T-13).
 * Assembly also VALIDATES the manifest, so a malformed platform module fails here loudly.
 */
const platformRegistry = registerModules([platformModule as unknown as AnyModuleDefinition<never>]);

/** The signed op of an `appended` outcome. `AppendedOp` is a union (`appended` | `duplicate`), so
 *  the narrowing is real: a `duplicate` carries no op, and a test that assumed otherwise would be
 *  asserting against `undefined`. */
function appendedOp(outcome: { ops: readonly AppendedOp[] }, index = 0): SignedOperation {
  const entry = outcome.ops[index];
  if (entry === undefined || entry.status !== 'appended') {
    throw new Error(`expected an appended op at ${index}, got ${entry?.status ?? 'nothing'}`);
  }
  return entry.op;
}

/**
 * The device's ops, EXCLUDING the genesis enrolment — the assertion surface.
 *
 * Genesis is filtered because `enroll()` appends it as setup: 05 §9.5 requires the first op on a
 * device to be `auth.device_enrolled`, so every command below is necessarily preceded by one, and
 * counting it would make every "no op was emitted" assertion read `toHaveLength(1)`.
 */
function storedOps(): SignedOperation[] {
  return fixture.store
    .forDevice(fixture.deviceId)
    .map((row) => row.op)
    .filter((op) => op.type !== 'auth.device_enrolled');
}

/**
 * The conflict under test — a REAL UUIDv7, minted per test from the fixture's IdSource.
 *
 * Not a readable `'conflict-1'`: `entityId` is `zUuidV7` (05 §2.1), validated inside the hash path,
 * so a non-v7 id fails envelope parse and the test goes red for the wrong reason. `ChainBuilder`'s
 * header warns about exactly this; I walked into it anyway, and the two positive-control tests —
 * the ones that actually EMIT an op — are what caught it.
 */
let conflictId: string;

/** A conflict row shaped as `listConflicts` returns it — what `ctx.query` hands the handler. */
function conflictRow(overrides: Record<string, unknown> = {}) {
  return {
    id: conflictId,
    storeId: null,
    entityType: 'note',
    entityId: 'note-1',
    conflictKey: 'note.archived',
    severity: 'significant',
    status: 'surfaced',
    opAId: 'op-a',
    opBId: 'op-b',
    detectedAt: 1_726_000_000_000,
    acknowledgedBy: null,
    acknowledgedAt: null,
    acknowledgementOpId: null,
    ...overrides,
  };
}

let fixture: RuntimeFixture;

beforeEach(async () => {
  // The real platform registry drives the runtime — so `scopeFor` below is the manifest's answer.
  fixture = makeRuntimeFixture(1701, { operations: platformRegistry.operations });
  await fixture.prime();
  // 05 §9.5: the device's first op must be the genesis enrolment, so a platform command can never
  // be the chain's first. `enroll()` goes through `emitRuntimeOp`, which is a sanctioned runtime
  // emission and does not consult the operations registry — so the platform-only registry above
  // is enough to drive it.
  await fixture.enroll();
  conflictId = fixture.newId();
});

// ── F1: the 01 §6 envelope-scope mechanism ──────────────────────────────────────────────────────

describe('01 §6 envelope scope — the mechanism review-17 deleted and nothing noticed', () => {
  test('a TENANT-scoped op type records storeId: null', async () => {
    // 01 §6: `platform.user_locale_changed` is "Tenant-scoped (`storeId = null`): the preference
    // follows the user to every device." The device HAS a store (fixture.storeId), so `null` here
    // can only be the type's declared scope winning over the device identity — which is the whole
    // mechanism, and the assertion that goes red when it is deleted.
    const outcome = await fixture.runtime.execute(
      platformModule.commands.setLocale,
      { locale: 'en' },
      fixture.runtime.createContext(fixture.staffId), // staff HOLDS platform.set_locale (§12)
    );

    expect(outcome.ops).toHaveLength(1);
    const op = appendedOp(outcome);
    expect(op.type).toBe('platform.user_locale_changed');
    expect(op.storeId).toBeNull();
    // Self-only by construction (07-i18n §1.1): entityId IS the acting user; the input carries no
    // target, so there is no value a caller could supply to aim this at someone else.
    expect(op.entityId).toBe(fixture.staffId);
    expect(op.userId).toBe(fixture.staffId);
  });

  test('a STORE-scoped op type records the device’s store — the positive control (T-17)', async () => {
    // Without this, the test above passes against a runtime that nulls EVERY op's storeId — a
    // mechanism that is broken in the opposite direction and equally invisible. Same runtime, same
    // device, different declared scope: the only variable is the manifest's `scope`.
    fixture.queries.stub('platform.conflict_view', { rows: [conflictRow()], nextCursor: null });

    const outcome = await fixture.runtime.execute(
      platformModule.commands.acknowledgeConflict,
      { conflictId, note: null },
      fixture.runtime.createContext(fixture.ownerId),
    );

    const op = appendedOp(outcome);
    expect(op.type).toBe('platform.conflict_acknowledged');
    // `platform.conflict_acknowledged` declares no `scope`, so it defaults to 'store' (01 §6) and
    // records the device's store — NOT null.
    expect(op.storeId).toBe(fixture.storeId);
  });

  test('the manifest declares exactly one tenant-scoped type (the T-14 denominator)', () => {
    // The mechanism's whole footprint in v0, asserted from the REAL registry. Three types examined,
    // one tenant-scoped — so "scopes resolve" is not vacuously true over an empty set, and a type
    // silently flipping scope is a red test rather than a shipped bug.
    const types = platformRegistry.operations.types();
    expect(types).toHaveLength(3);
    const tenantScoped = types.filter((t) => platformRegistry.operations.scopeFor(t) === 'tenant');
    expect(tenantScoped).toEqual(['platform.user_locale_changed']);
    // … and the rest really are store-scoped (not `undefined` masquerading as "not tenant").
    for (const t of types.filter((x) => x !== 'platform.user_locale_changed')) {
      expect(platformRegistry.operations.scopeFor(t)).toBe('store');
    }
    // An UNDECLARED type answers undefined — the runtime's fail-closed signal, not the 'store'
    // default. (`#resolveScope` throws on it; defaulting would silently scope an unknown op.)
    expect(platformRegistry.operations.scopeFor('platform.nope')).toBeUndefined();
  });
});

// ── F2: the denial legs (§2.5 — adversarial tests ship IN the task) ─────────────────────────────

describe('acknowledgeConflict — permission denial (02 §12) and lifecycle (03 §7)', () => {
  test('staff (no platform.conflict_acknowledge) → PERMISSION_DENIED, denial op, no ack op', async () => {
    // 02 §12: staff holds `platform.set_locale` and NOT `platform.conflict_acknowledge`. The denial
    // is execute step 2 — before the handler — so the stubbed query is never even reached.
    const before = storedOps().length;

    await expect(
      fixture.runtime.execute(
        platformModule.commands.acknowledgeConflict,
        { conflictId, note: null },
        fixture.runtime.createContext(fixture.staffId),
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });

    // 02 §7: the denial is RECORDED — a denied attempt is audit evidence, not silence.
    const appended = storedOps().slice(before);
    expect(appended.map((o) => o.type)).toEqual(['auth.permission_denied']);
    // … and no acknowledgment op exists. The handler never ran, so nothing was decided.
    expect(appended.some((o) => o.type === 'platform.conflict_acknowledged')).toBe(false);
    // The handler's read never happened either — step 2 precedes it (review-17's F2 point).
    expect(fixture.queries.calls).toHaveLength(0);
  });

  test('the owner CAN acknowledge — the positive control for the denial above (T-17)', async () => {
    // Without this, the denial test passes against a command that denies EVERYONE — including the
    // owner — which is a broken command and a green test.
    fixture.queries.stub('platform.conflict_view', { rows: [conflictRow()], nextCursor: null });
    const before = storedOps().length;

    const outcome = await fixture.runtime.execute(
      platformModule.commands.acknowledgeConflict,
      { conflictId, note: 'seen' },
      fixture.runtime.createContext(fixture.ownerId),
    );

    expect(outcome.result).toEqual({ conflictId });
    const appended = storedOps().slice(before);
    expect(appended.map((o) => o.type)).toEqual(['platform.conflict_acknowledged']);
    expect(appended[0]?.payload).toEqual({ note: 'seen' });
    // The conflict IS the entity (01 §6) — same entityType/entityId as its detection op, which is
    // what lets the §4.2 re-fold replay the pair together.
    expect(appended[0]?.entityType).toBe('conflict');
    expect(appended[0]?.entityId).toBe(conflictId);
  });

  test('acknowledging an auto_resolved conflict → INVALID_TRANSITION, no op (03 §7/§12)', async () => {
    // 01 §8.3: `minor → auto_resolved` is TERMINAL. 03 §7's "Invalid (command-time)" row.
    fixture.queries.stub('platform.conflict_view', {
      rows: [conflictRow({ severity: 'minor', status: 'auto_resolved' })],
      nextCursor: null,
    });
    const before = storedOps().length;

    const error = await fixture.runtime
      .execute(
        platformModule.commands.acknowledgeConflict,
        { conflictId, note: null },
        fixture.runtime.createContext(fixture.ownerId),
      )
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe('INVALID_TRANSITION');
    // 03 §12's details shape, exactly — `{machine, from, event, entityId}`.
    expect((error as DomainError).details).toEqual({
      machine: 'conflict',
      from: 'auto_resolved',
      event: 'platform.conflict_acknowledged',
      entityId: conflictId,
    });
    // NO op emitted. The applier would no-op this anyway, but emitting it would append a permanent,
    // signed, synced lie to an append-only log — every device replaying an acknowledgment that
    // acknowledged nothing, and the user told their click worked.
    expect(storedOps().slice(before)).toHaveLength(0);
  });

  test('acknowledging an ALREADY-acknowledged conflict → INVALID_TRANSITION (03 §7)', async () => {
    // The other terminal state. Two rows in 03 §7 reach it; both must refuse at command time.
    fixture.queries.stub('platform.conflict_view', {
      rows: [conflictRow({ status: 'acknowledged' })],
      nextCursor: null,
    });

    const error = await fixture.runtime
      .execute(
        platformModule.commands.acknowledgeConflict,
        { conflictId, note: null },
        fixture.runtime.createContext(fixture.ownerId),
      )
      .catch((e: unknown) => e);

    expect((error as DomainError).code).toBe('INVALID_TRANSITION');
    expect((error as DomainError).details).toMatchObject({ from: 'acknowledged' });
  });

  test('a conflict outside the caller’s scope → ENTITY_NOT_FOUND, no op', async () => {
    // The query layer scopes by tenant/store, so an out-of-scope conflict simply is not in the
    // page. The command must not treat "invisible" as "acknowledgeable".
    fixture.queries.stub('platform.conflict_view', { rows: [], nextCursor: null });
    const before = storedOps().length;

    const error = await fixture.runtime
      .execute(
        platformModule.commands.acknowledgeConflict,
        { conflictId: fixture.newId(), note: null },
        fixture.runtime.createContext(fixture.ownerId),
      )
      .catch((e: unknown) => e);

    expect((error as DomainError).code).toBe('ENTITY_NOT_FOUND');
    expect(storedOps().slice(before)).toHaveLength(0);
  });
});

describe('listConflicts — permission denial (02 §12, FR-1036)', () => {
  /**
   * A db that THROWS if touched.
   *
   * The point of the denial test, not scenery: 02 §9 / security-guide §2.2 require a denial to be
   * an ERROR, never an empty page — "an empty page leaks 'the store exists and is quiet', and is
   * indistinguishable from the legitimate empty page". A test asserting `rejects` against a real db
   * would pass whether the check ran BEFORE the read or after it discarded the rows. This handle
   * makes "denied" and "ran and returned nothing" different observable events: if the enforcement
   * point ever moved after the read, this throws the wrong error and the test fails.
   */
  const exploding = new Proxy({} as Kysely<never>, {
    get() {
      throw new Error('the query handler READ the database on a denied call (02 §4/§9)');
    },
  });

  test('staff (no platform.conflict_view) → PERMISSION_DENIED, never an empty page', async () => {
    // The REAL QueryRuntime over the REAL enforcement point — the same one `createModuleRuntime`
    // wires (module/runtime.ts), so this is production's check, not a re-implementation.
    const queries = new QueryRuntime<never>({
      db: exploding,
      enforcement: fixture.runtime.enforcementPoint,
    });

    const error = await queries
      .execute(
        platformModule.queries.listConflicts,
        { sort: 'detectedAt.desc', limit: 50 },
        {
          tenantId: fixture.tenantId,
          storeId: fixture.storeId,
          userId: fixture.staffId,
          deviceId: fixture.deviceId,
        },
      )
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe('PERMISSION_DENIED');
    // Explicitly NOT an empty result — the FR-1036 rule. `rejects` already says this, but the
    // failure mode it guards is a future refactor "helpfully" returning `{rows: []}`.
    expect(error).not.toMatchObject({ rows: [] });
  });

  test('the owner’s call passes the gate and reaches the handler — positive control (T-17)', async () => {
    // Proves the denial above is the PERMISSION's doing, not a QueryRuntime that denies everyone
    // or an `exploding` db that fails every call. The owner gets past step 2 and hits the db — and
    // the db throws ITS distinctive error, which is how we know the handler was reached.
    const queries = new QueryRuntime<never>({
      db: exploding,
      enforcement: fixture.runtime.enforcementPoint,
    });

    const error = await queries
      .execute(
        platformModule.queries.listConflicts,
        { sort: 'detectedAt.desc', limit: 50 },
        {
          tenantId: fixture.tenantId,
          storeId: fixture.storeId,
          userId: fixture.ownerId,
          deviceId: fixture.deviceId,
        },
      )
      .catch((e: unknown) => e);

    expect((error as Error).message).toMatch(/READ the database/);
    expect(error).not.toBeInstanceOf(DomainError);
  });
});
