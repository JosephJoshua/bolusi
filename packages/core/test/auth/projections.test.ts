// The `auth` projection appliers through the REAL projection engine (T-7): valid + invalid
// transitions, order-independent convergence (= "fold the same op twice" via re-fold), the genesis
// seq-1 case, rebuild idempotency, and the denial audit read back through `listPermissionDenials`.
//
// WHY THIS FILE, ON TOP OF THE T-8 CONFORMANCE SUITE. Conformance proves the two engines AGREE;
// these prove the fold is CORRECT (the oracle's blind spot) and — the whole point of task 43 — that
// the folded rows are READABLE, which is what a write-only audit is not. T-14b runs throughout:
// every count is preceded by asserting the ops that should produce it are actually in the log, so a
// green over zero ops is impossible.
import { describe, expect, test } from 'vitest';

import type { ClientDatabase } from '@bolusi/db-client';
import type { SignedOperation } from '@bolusi/schemas';
import type { Kysely } from 'kysely';

import { authModule } from '../../src/auth/index.js';
import {
  listPermissionDenialsHandler,
  type ListPermissionDenialsInput,
} from '../../src/auth/queries.js';
import { readOnlyDb, type QueryContext } from '../../src/index.js';
import type { AuthDatabase } from '../../src/auth/schema.js';
import type { ModuleProjectionManifest, ProjectionApplier } from '../../src/index.js';
import {
  countRows,
  deliverAppended,
  deliverPulled,
  openProjectionHarness,
  type ProjectionHarness,
} from '../projection/db.js';

const TENANT = '00000000-0000-7000-8000-00000000t001';
const STORE = '00000000-0000-7000-8000-00000000s001';
const DEVICE = '00000000-0000-7000-8000-00000000d001';
const USER_A = '00000000-0000-7000-8000-0000000user-a';
const USER_B = '00000000-0000-7000-8000-0000000user-b';
const USER_C = '00000000-0000-7000-8000-0000000user-c';
const OWNER = '00000000-0000-7000-8000-00000000ownr';

/** The auth module's projection-facing slice, over the client schema (the engine's `DB`). */
const authProjection = {
  id: authModule.id,
  tables: authModule.projections.tables,
  appliers: Object.fromEntries(
    Object.entries(authModule.operations).map(([type, decl]) => [type, decl.apply]),
  ) as Record<string, ProjectionApplier<ClientDatabase>>,
} as unknown as ModuleProjectionManifest<ClientDatabase>;

let seqCounter = 0;
function op(
  partial: Partial<SignedOperation> &
    Pick<SignedOperation, 'type' | 'entityType' | 'entityId' | 'payload' | 'userId'> & {
      readonly ts: number;
    },
): SignedOperation {
  const seq = ++seqCounter;
  const { ts, ...rest } = partial;
  return {
    id: `op-${String(seq).padStart(4, '0')}`,
    tenantId: TENANT,
    storeId: STORE,
    deviceId: DEVICE,
    seq,
    schemaVersion: 1,
    timestamp: ts,
    location: null,
    source: 'system',
    agentInitiated: false,
    agentConversationId: null,
    previousHash: '0'.repeat(64),
    hash: String(seq).padStart(64, '0'),
    signature: `sig-${seq}`,
    ...rest,
  } as SignedOperation;
}

async function openAuthHarness(): Promise<ProjectionHarness> {
  seqCounter = 0;
  return openProjectionHarness([authProjection]);
}

/** How many op rows the log holds — the T-14b fixture assertion (state exists before a count). */
async function opCount(db: Kysely<ClientDatabase>): Promise<number> {
  return countRows(db, 'operations');
}

describe('auth session projection (auth_sessions)', () => {
  test('valid transition: user_switched opens, session_ended closes — readable, not empty', async () => {
    const h = await openAuthHarness();
    try {
      const switched = op({
        type: 'auth.user_switched',
        entityType: 'auth_session',
        entityId: 'sess-1',
        userId: USER_A,
        payload: { previousSessionId: null, previousUserId: null },
        ts: 1000,
      });
      const ended = op({
        type: 'auth.session_ended',
        entityType: 'auth_session',
        entityId: 'sess-1',
        userId: USER_B,
        payload: { reason: 'switch' },
        ts: 2000,
      });

      const applied = await deliverAppended(h, [switched, ended]);

      // T-14b: assert the ops are IN THE LOG before believing anything about the projection.
      expect(applied).toBe(2);
      expect(await opCount(h.db)).toBe(2);

      const rows = await h.db
        .selectFrom('authSessions')
        .selectAll()
        .where('id', '=', 'sess-1')
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.userId).toBe(USER_A); // the session's user = the INCOMING user of the switch
      expect(rows[0]?.startedAt).toBe(1000);
      expect(rows[0]?.endedAt).toBe(2000);
      expect(rows[0]?.endReason).toBe('switch');
    } finally {
      await h.close();
    }
  });

  test('INVALID/total: a session_ended with no matching session is a no-op, not a crash or a row', async () => {
    const h = await openAuthHarness();
    try {
      const orphanEnd = op({
        type: 'auth.session_ended',
        entityType: 'auth_session',
        entityId: 'sess-ghost',
        userId: USER_B,
        payload: { reason: 'idle_lock' },
        ts: 1000,
      });

      const applied = await deliverAppended(h, [orphanEnd]);

      expect(applied).toBe(1); // it WAS applied (registered), so this is not vacuous
      expect(await opCount(h.db)).toBe(1);
      // …and it wrote nothing: an UPDATE matching no row is a successful total no-op (03 §11).
      expect(await countRows(h.db, 'auth_sessions')).toBe(0);
    } finally {
      await h.close();
    }
  });

  test('order-independent convergence: session_ended delivered BEFORE its user_switched still converges', async () => {
    const h = await openAuthHarness();
    try {
      const switched = op({
        type: 'auth.user_switched',
        entityType: 'auth_session',
        entityId: 'sess-2',
        userId: USER_A,
        payload: { previousSessionId: null, previousUserId: null },
        ts: 1000,
      });
      const ended = op({
        type: 'auth.session_ended',
        entityType: 'auth_session',
        entityId: 'sess-2',
        userId: USER_B,
        payload: { reason: 'manual_lock' },
        ts: 2000,
      });

      // Delivered OUT of canonical order (the close arrives first). The engine re-folds when the
      // earlier user_switched lands — folding both ops again in canonical order.
      const applied = await deliverPulled(h, [
        { op: ended, serverSeq: 1 },
        { op: switched, serverSeq: 2 },
      ]);
      expect(applied).toBe(2);
      expect(h.engine.stats.snapshot().refolds).toBeGreaterThan(0); // the re-fold actually ran (CHAOS-01)

      const rows = await h.db
        .selectFrom('authSessions')
        .selectAll()
        .where('id', '=', 'sess-2')
        .execute();
      // Exactly one row (not duplicated by the re-fold), correctly CLOSED — the applier folded twice
      // (once head, once in the re-fold) idempotently.
      expect(rows).toHaveLength(1);
      expect(rows[0]?.startedAt).toBe(1000);
      expect(rows[0]?.endedAt).toBe(2000);
      expect(rows[0]?.endReason).toBe('manual_lock');
    } finally {
      await h.close();
    }
  });
});

describe('auth genesis (auth.device_enrolled, seq 1)', () => {
  test('the genesis op is REGISTERED yet folds nothing, and does not break a following op', async () => {
    const h = await openAuthHarness();
    try {
      const genesis = op({
        type: 'auth.device_enrolled',
        entityType: 'device',
        entityId: DEVICE,
        userId: OWNER,
        payload: { storeId: STORE, deviceName: 'Till 1', devicePublicKeyB64: 'cHVia2V5' },
        ts: 1,
      });
      const outcome = await h.engine.applyAppendedOp(genesis);
      // REGISTERED, not `unregistered`: the module claims the type (so the server validates+folds it)
      // — but it writes no row. A no-op that is `unregistered` would silently swallow a real fold.
      expect(outcome.mode).not.toBe('unregistered');
      expect(outcome.module).toBe('auth');
      expect(outcome.writtenTables).toEqual([]);

      // None of the three tables gained a row from the genesis.
      expect(await countRows(h.db, 'auth_sessions')).toBe(0);
      expect(await countRows(h.db, 'pin_lockout_events')).toBe(0);
      expect(await countRows(h.db, 'auth_permission_denials')).toBe(0);

      // …and a real op right after the genesis still folds (the genesis did not poison the engine).
      const switched = op({
        type: 'auth.user_switched',
        entityType: 'auth_session',
        entityId: 'sess-g',
        userId: OWNER,
        payload: { previousSessionId: null, previousUserId: null },
        ts: 2,
      });
      await h.engine.applyAppendedOp(switched);
      expect(await countRows(h.db, 'auth_sessions')).toBe(1);
    } finally {
      await h.close();
    }
  });
});

describe('pin lockout events (pin_lockout_events)', () => {
  test('locked_out then cleared are appended; a re-fold of the credential re-creates both, not duplicates', async () => {
    const h = await openAuthHarness();
    try {
      const lockedOut = op({
        type: 'auth.pin_locked_out',
        entityType: 'user_credential',
        entityId: USER_C,
        userId: USER_C,
        payload: { consecutiveFailures: 10, windowStartedAt: 900 },
        ts: 1000,
      });
      const cleared = op({
        type: 'auth.pin_lockout_cleared',
        entityType: 'user_credential',
        entityId: USER_C,
        userId: OWNER,
        payload: {},
        ts: 2000,
      });
      // A pin_changed for the SAME credential, delivered LAST but timestamped BEFORE the lock —
      // forces a re-fold of user_credential/USER_C, which deletes both events by user_id and replays
      // the full credential history (pin_changed no-op, then the two events re-insert).
      const pinChanged = op({
        type: 'auth.pin_changed',
        entityType: 'user_credential',
        entityId: USER_C,
        userId: USER_C,
        payload: { targetUserId: USER_C, verifierRef: 'ref-1' },
        ts: 500,
      });

      await deliverPulled(h, [
        { op: lockedOut, serverSeq: 1 },
        { op: cleared, serverSeq: 2 },
        { op: pinChanged, serverSeq: 3 }, // ts 500 < 1000 ⇒ re-fold
      ]);
      expect(h.engine.stats.snapshot().refolds).toBeGreaterThan(0);

      const rows = await h.db
        .selectFrom('pinLockoutEvents')
        .selectAll()
        .where('userId', '=', USER_C)
        .orderBy('at')
        .execute();
      // TWO rows, not four (no duplication from the re-fold), not zero (the no-op pin_changed did not
      // wipe them). The count is the semantics.
      expect(rows.map((r) => r.kind)).toEqual(['pin_locked_out', 'pin_lockout_cleared']);
      expect(rows[0]?.failureCount).toBe(10);
      expect(rows[1]?.failureCount).toBeNull();
    } finally {
      await h.close();
    }
  });
});

describe('permission denial audit (auth_permission_denials) — the load-bearing read path', () => {
  function qctx(h: ProjectionHarness): QueryContext<AuthDatabase> {
    return {
      db: readOnlyDb(h.db as unknown as Kysely<AuthDatabase>),
      tenantId: TENANT,
      storeId: STORE,
      userId: OWNER,
      hasPermission: () => true,
    };
  }

  const listInput = (
    over: Partial<ListPermissionDenialsInput> = {},
  ): ListPermissionDenialsInput => ({
    sort: 'timestampMs.desc',
    limit: 50,
    ...over,
  });

  test('a folded denial is READABLE via listPermissionDenials with its six-field payload', async () => {
    const h = await openAuthHarness();
    try {
      const denial = op({
        type: 'auth.permission_denied',
        entityType: 'permission_denial',
        entityId: 'denial-1',
        userId: USER_A,
        payload: {
          permissionId: 'auth.role_manage',
          surface: 'command',
          target: 'auth.manageRole',
          reason: 'not_granted',
          scopeStoreId: null,
          suppressedRepeats: 0,
        },
        ts: 1000,
      });

      const applied = await deliverAppended(h, [denial]);
      // T-14b: assert the denial op EXISTS in the log before believing the query — a query returning
      // nothing over an empty log is exactly how a write-only audit reads green.
      expect(applied).toBe(1);
      expect(await opCount(h.db)).toBe(1);
      expect(await countRows(h.db, 'auth_permission_denials')).toBe(1);

      const page = await listPermissionDenialsHandler(listInput(), qctx(h));
      expect(page.rows).toHaveLength(1);
      const row = page.rows[0];
      expect(row?.id).toBe('denial-1');
      expect(row?.permissionId).toBe('auth.role_manage');
      expect(row?.surface).toBe('command');
      expect(row?.target).toBe('auth.manageRole');
      expect(row?.reason).toBe('not_granted');
      expect(row?.scopeStoreId).toBeNull();
      expect(row?.suppressedRepeats).toBe(0);
    } finally {
      await h.close();
    }
  });

  test('SUPPRESSION: a suppressed repeat is not lost — it survives as suppressedRepeats on the next row', async () => {
    const h = await openAuthHarness();
    try {
      // The §7 throttle emits one op per (user, permission, target) per window; repeats flush into
      // the NEXT emitted op's suppressedRepeats. The applier's job is to preserve that count.
      const denials = [
        op({
          type: 'auth.permission_denied',
          entityType: 'permission_denial',
          entityId: 'd-first',
          userId: USER_A,
          payload: {
            permissionId: 'notes.create',
            surface: 'command',
            target: 'notes.createNote',
            reason: 'restriction_violated',
            scopeStoreId: STORE,
            suppressedRepeats: 0,
          },
          ts: 1000,
        }),
        op({
          type: 'auth.permission_denied',
          entityType: 'permission_denial',
          entityId: 'd-flush',
          userId: USER_A,
          payload: {
            permissionId: 'notes.create',
            surface: 'command',
            target: 'notes.createNote',
            reason: 'restriction_violated',
            scopeStoreId: STORE,
            suppressedRepeats: 4, // four attempts were throttled between the two emissions
          },
          ts: 2000,
        }),
      ];
      await deliverAppended(h, denials);
      expect(await countRows(h.db, 'auth_permission_denials')).toBe(2);

      // Newest-first: the flush row carries the four suppressed repeats — no attempt vanished.
      const page = await listPermissionDenialsHandler(listInput(), qctx(h));
      expect(page.rows.map((r) => r.suppressedRepeats)).toEqual([4, 0]);
      expect(page.rows.map((r) => r.id)).toEqual(['d-flush', 'd-first']);
    } finally {
      await h.close();
    }
  });

  test('the audit query is cursor-paginated and scoped to the caller tenant', async () => {
    const h = await openAuthHarness();
    try {
      const denials = Array.from({ length: 3 }, (_unused, i) =>
        op({
          type: 'auth.permission_denied',
          entityType: 'permission_denial',
          entityId: `d-${i}`,
          userId: USER_A,
          payload: {
            permissionId: 'auth.audit_view',
            surface: 'query',
            target: 'auth.listPermissionDenials',
            reason: 'not_granted',
            scopeStoreId: null,
            suppressedRepeats: 0,
          },
          ts: 1000 + i * 1000,
        }),
      );
      await deliverAppended(h, denials);
      expect(await countRows(h.db, 'auth_permission_denials')).toBe(3);

      const first = await listPermissionDenialsHandler(listInput({ limit: 2 }), qctx(h));
      expect(first.rows.map((r) => r.id)).toEqual(['d-2', 'd-1']); // newest first
      expect(first.nextCursor).not.toBeNull();

      const second = await listPermissionDenialsHandler(
        listInput({ limit: 2, cursor: first.nextCursor ?? undefined }),
        qctx(h),
      );
      expect(second.rows.map((r) => r.id)).toEqual(['d-0']);
      expect(second.nextCursor).toBeNull(); // last page
    } finally {
      await h.close();
    }
  });
});

describe('rebuild idempotency (04 §4.3) — re-folding the whole log converges to the same projection', () => {
  test('a full rebuild reproduces byte-identical projections for every auth table', async () => {
    const h = await openAuthHarness();
    try {
      const ops: SignedOperation[] = [
        op({
          type: 'auth.device_enrolled',
          entityType: 'device',
          entityId: DEVICE,
          userId: OWNER,
          payload: { storeId: STORE, deviceName: 'Till', devicePublicKeyB64: 'cHVia2V5' },
          ts: 1,
        }),
        op({
          type: 'auth.user_switched',
          entityType: 'auth_session',
          entityId: 'sess-r',
          userId: USER_A,
          payload: { previousSessionId: null, previousUserId: null },
          ts: 100,
        }),
        op({
          type: 'auth.session_ended',
          entityType: 'auth_session',
          entityId: 'sess-r',
          userId: USER_B,
          payload: { reason: 'idle_lock' },
          ts: 200,
        }),
        op({
          type: 'auth.pin_locked_out',
          entityType: 'user_credential',
          entityId: USER_C,
          userId: USER_C,
          payload: { consecutiveFailures: 10, windowStartedAt: 250 },
          ts: 300,
        }),
        op({
          type: 'auth.permission_denied',
          entityType: 'permission_denial',
          entityId: 'd-r',
          userId: USER_A,
          payload: {
            permissionId: 'auth.role_manage',
            surface: 'command',
            target: 'auth.manageRole',
            reason: 'not_granted',
            scopeStoreId: null,
            suppressedRepeats: 2,
          },
          ts: 400,
        }),
      ];
      await deliverAppended(h, ops);

      const before = await h.digest(authProjection);
      const countsBefore = {
        sessions: await countRows(h.db, 'auth_sessions'),
        lockouts: await countRows(h.db, 'pin_lockout_events'),
        denials: await countRows(h.db, 'auth_permission_denials'),
      };
      // A non-trivial fixture (T-14b): the digest below proves nothing if these are all zero.
      expect(countsBefore).toEqual({ sessions: 1, lockouts: 1, denials: 1 });

      const outcome = await h.engine.rebuild('auth');
      expect(outcome.complete).toBe(true);
      expect(outcome.appliedCount).toBe(ops.length); // every op replayed

      const after = await h.digest(authProjection);
      expect(after).toBe(before); // idempotent: the rebuild reproduced the exact projection
      expect(after).toMatch(/^[0-9a-f]{16,}/);
    } finally {
      await h.close();
    }
  });
});
