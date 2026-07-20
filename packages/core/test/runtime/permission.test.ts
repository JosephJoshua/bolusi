// Step 2 — the single enforcement point (02-permissions §4; 04-module-contract §5.1).
//
// This suite's job is not "does a denial deny". It is: **can ANYTHING reach a handler without a
// check** (testing-guide T-12 — test the class, not the instances you thought of), and **is the
// denial recorded** (02 §7). Every denial assertion below has a POSITIVE control next to it: a
// deny-test passes just as happily against a broken fixture where nothing runs at all (T-14b).
import { describe, expect, it } from 'vitest';

import type { SignedOperation } from '@bolusi/schemas';

import {
  DENIAL_THROTTLE_WINDOW_MS,
  DomainError,
  permissionDeniedPayload,
} from '../../src/index.js';

import {
  ArmableHangStore,
  ControllableTimer,
  expectDomainError,
  makeCommandSpy,
  makeRuntimeFixture,
  RecordingAuditDiagnostics,
  ThrowingAuditDiagnostics,
  type CommandSpy,
  type RuntimeFixture,
} from './_fixtures.js';

async function ready(seed: number, options?: Parameters<typeof makeRuntimeFixture>[1]) {
  const fixture = makeRuntimeFixture(seed, options);
  await fixture.prime();
  await fixture.enroll();
  return fixture;
}

/**
 * Drain all pending microtasks past a macrotask boundary. A resolved-promise await alone would only
 * advance one link of the deny→emit→race→throw chain; a `setTimeout(0)` fires AFTER the whole
 * microtask queue, so "did `execute` settle" is answered honestly. Not a sleep (T-6): zero delay,
 * a real timer only because the suite drives a FakeClock, not `vi.useFakeTimers()`.
 */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Observe a promise's settlement WITHOUT awaiting it — so a still-hung `execute` cannot hang the test. */
function track(p: Promise<unknown>): { settled: boolean; error?: unknown } {
  const state: { settled: boolean; error?: unknown } = { settled: false };
  p.then(
    () => {
      state.settled = true;
    },
    (error: unknown) => {
      state.settled = true;
      state.error = error;
    },
  );
  return state;
}

function opsOfType(fixture: RuntimeFixture, type: string): SignedOperation[] {
  return fixture.store
    .forDevice(fixture.deviceId)
    .map((row) => row.op)
    .filter((op) => op.type === type);
}

function denials(fixture: RuntimeFixture): SignedOperation[] {
  return opsOfType(fixture, 'auth.permission_denied');
}

function businessOps(fixture: RuntimeFixture): SignedOperation[] {
  return fixture.store
    .forDevice(fixture.deviceId)
    .map((row) => row.op)
    .filter((op) => !op.type.startsWith('auth.'));
}

describe('the permission check is unconditional and precedes the handler (04 §5.1 step 2)', () => {
  it('checks before the handler runs', async () => {
    const fixture = await ready(1);
    const command = makeCommandSpy(fixture.log);

    await fixture.runtime.execute(
      command,
      { title: 't', body: 'b' },
      fixture.runtime.createContext(fixture.ownerId),
    );

    expect(fixture.log.indexOf('permission-check')).toBeGreaterThanOrEqual(0);
    expect(fixture.log.indexOf('permission-check')).toBeLessThan(fixture.log.indexOf('handler'));
  });

  it('consults the evaluator with the command`s declared permission and the acting identity', async () => {
    const fixture = await ready(2);
    const command = makeCommandSpy(fixture.log, { permission: 'notes.archive' });

    await fixture.runtime.execute(
      command,
      { title: 't', body: 'b' },
      fixture.runtime.createContext(fixture.staffId),
    );

    expect(fixture.evaluator.checks).toEqual([
      { userId: fixture.staffId, permissionId: 'notes.archive' },
    ]);
  });

  /**
   * THE CLASS SWEEP (T-12) — every invocation SHAPE that can reach `execute`, enumerated.
   *
   * WHAT THIS ASSERTS, AND WHY THE OBVIOUS VERSION IS WRONG. The first draft of this sweep
   * asserted "a permission check precedes the handler". That assertion is GREEN FOR THE WRONG
   * REASON, and it was caught by falsifying it: replacing step 2's `await` with `void` leaves the
   * check running — so "a check preceded the handler" stays true — while its rejection is
   * discarded and the handler runs anyway. 26/31 of this file went red under a skipped check, but
   * only 5 under a dropped `await`, and NONE of the eleven sweep paths noticed.
   *
   * The load-bearing property is not "a check ran". It is **a denied check STOPS the handler**. So
   * each shape below runs as the zero-grant user (denied for everything) and must reach no
   * handler and append nothing — and runs again as the owner (granted) as the T-14b positive
   * control, because "the handler never ran" is also what a broken fixture looks like.
   */
  const SHAPES: {
    name: string;
    run: (fixture: RuntimeFixture, userId: string) => Promise<void>;
  }[] = [
    {
      name: 'a plain command',
      run: async (f, userId) => {
        await f.runtime
          .execute(
            makeCommandSpy(f.log),
            { title: 't', body: 'b' },
            f.runtime.createContext(userId),
          )
          .catch(() => undefined);
      },
    },
    {
      name: 'a retried command (same ctx, twice)',
      run: async (f, userId) => {
        const command = makeCommandSpy(f.log);
        const ctx = f.runtime.createContext(userId);
        await f.runtime.execute(command, { title: 't', body: 'b' }, ctx).catch(() => undefined);
        await f.runtime.execute(command, { title: 't', body: 'b' }, ctx).catch(() => undefined);
      },
    },
    {
      name: 'a command retried after a previous handler threw (an error path that resumes)',
      run: async (f, userId) => {
        const ctx = f.runtime.createContext(userId);
        await f.runtime
          .execute(
            makeCommandSpy(f.log, {
              onHandler: () => {
                throw new Error('handler blew up');
              },
            }),
            { title: 't', body: 'b' },
            ctx,
          )
          .catch(() => undefined);
        await f.runtime
          .execute(makeCommandSpy(f.log), { title: 't', body: 'b' }, ctx)
          .catch(() => undefined);
      },
    },
    {
      name: 'a command retried after the input failed to parse',
      run: async (f, userId) => {
        const ctx = f.runtime.createContext(userId);
        await f.runtime.execute(makeCommandSpy(f.log), { bad: 1 }, ctx).catch(() => undefined);
        await f.runtime
          .execute(makeCommandSpy(f.log), { title: 't', body: 'b' }, ctx)
          .catch(() => undefined);
      },
    },
    {
      name: 'a handler reaching for a nested command through its ctx',
      run: async (f, userId) => {
        await f.runtime
          .execute(
            makeCommandSpy(f.log, {
              onHandler: (_input, ctx) => {
                // §5.2: there is no `execute` on ctx. If one ever appears this shape must be
                // re-examined — a nested command re-enters the whole sequence.
                expect((ctx as unknown as Record<string, unknown>).execute).toBeUndefined();
              },
            }),
            { title: 't', body: 'b' },
            f.runtime.createContext(userId),
          )
          .catch(() => undefined);
      },
    },
    {
      name: 'two commands executed concurrently on one ctx',
      run: async (f, userId) => {
        const ctx = f.runtime.createContext(userId);
        await Promise.all([
          f.runtime.execute(makeCommandSpy(f.log), { title: 'a', body: 'b' }, ctx),
          f.runtime.execute(makeCommandSpy(f.log), { title: 'c', body: 'd' }, ctx),
        ]).catch(() => undefined);
      },
    },
    {
      name: 'a command whose handler awaits a query first',
      run: async (f, userId) => {
        await f.runtime
          .execute(
            makeCommandSpy(f.log, {
              onHandler: async (_input, ctx) => {
                await ctx.query(
                  {
                    permission: 'notes.read',
                    input: { parse: (raw: unknown) => raw as Record<string, never> },
                    handler: (): unknown => null,
                  },
                  {},
                );
              },
            }),
            { title: 't', body: 'b' },
            f.runtime.createContext(userId),
          )
          .catch(() => undefined);
      },
    },
  ];

  it.each(SHAPES)('$name — a DENIED check stops the handler', async ({ run }) => {
    const fixture = await ready(50);

    // The zero-grant user exists and is active, and holds nothing (04 §8). Every check denies.
    await run(fixture, fixture.zeroGrantId);

    expect(fixture.log.count('handler'), 'no handler may run when the check denied').toBe(0);
    expect(businessOps(fixture), 'nothing may be appended').toEqual([]);
  });

  it.each(SHAPES)('$name — POSITIVE CONTROL: reaches the handler when granted', async ({ run }) => {
    const fixture = await ready(52);

    // Without this leg, the sweep above passes against a runtime that never works at all, and
    // against a fixture whose "shapes" silently do nothing (T-14b).
    await run(fixture, fixture.ownerId);

    expect(fixture.log.count('handler'), 'the shape must actually reach a handler').toBeGreaterThan(
      0,
    );
    expect(fixture.log.indexOf('permission-check')).toBeLessThan(fixture.log.indexOf('handler'));
  });

  it('the sweep covers every shape and no shape is vacuous (T-14 denominator)', async () => {
    // The sweep is only as good as its list: a truncated or empty array makes every assertion
    // above vacuously true. Pin the count.
    expect(SHAPES).toHaveLength(7);

    for (const shape of SHAPES) {
      const fixture = await ready(51);
      await shape.run(fixture, fixture.zeroGrantId);
      expect(
        fixture.log.count('permission-check'),
        `${shape.name} reached no check at all — the shape does not exercise execute`,
      ).toBeGreaterThan(0);
    }
  });

  /** Degenerate permission declarations. No user can be granted these, so there is no positive leg. */
  const DEGENERATE: { name: string; permission: unknown }[] = [
    { name: 'no permission declared (undefined at runtime)', permission: undefined },
    { name: 'an empty-string permission', permission: '' },
    { name: 'a permission no registry knows', permission: 'ghost.module_wide_access' },
    { name: 'a permission id of the wrong type', permission: 42 },
  ];

  it.each(DEGENERATE)(
    '$name — denies, and no handler runs (fail closed)',
    async ({ permission }) => {
      const fixture = await ready(53);
      const command = makeCommandSpy(fixture.log);

      // The owner holds EVERY v0 permission — so if any of these reached a handler it would be
      // because the check was skipped, never because it passed on merit.
      const error = await fixture.runtime
        .execute(
          { ...command, permission: permission as string },
          { title: 't', body: 'b' },
          fixture.runtime.createContext(fixture.ownerId),
        )
        .catch((e: unknown) => e);

      expectDomainError(error, 'PERMISSION_DENIED');
      expect(command.invocations).toEqual([]);
      expect(businessOps(fixture)).toEqual([]);
    },
  );

  it('a sanctioned runtime emission reaches no handler and performs no permission check (02 §4)', async () => {
    const fixture = await ready(3);

    await fixture.runtime.emitRuntimeOp({
      type: 'auth.user_switched',
      entityType: 'session',
      entityId: fixture.newId(),
      payload: { toUserId: fixture.staffId },
      userId: fixture.staffId,
    });

    expect(fixture.log.count('handler')).toBe(0);
    expect(fixture.evaluator.checks, 'the five are exempt by design (02 §4)').toEqual([]);
    expect(opsOfType(fixture, 'auth.user_switched')).toHaveLength(1);
  });
});

describe('the permission-denied path (02 §4, §7)', () => {
  it('denies, never runs the handler, appends no business op, and emits exactly one denial op', async () => {
    const fixture = await ready(4);
    // `auth.role_manage` is tenant-scoped and held only by main_owner (§12) — staff lacks it.
    const command = makeCommandSpy(fixture.log, {
      name: 'manageRoles',
      permission: 'auth.role_manage',
    });

    const error = await fixture.runtime
      .execute(command, { title: 't', body: 'b' }, fixture.runtime.createContext(fixture.staffId))
      .catch((e: unknown) => e);

    // Denial is an ERROR, never an empty result (FR-1036 — an empty result leaks "the store
    // exists and is quiet").
    expectDomainError(error, 'PERMISSION_DENIED');
    expect(command.invocations, 'handler must never run').toEqual([]);
    expect(businessOps(fixture), 'no business op').toEqual([]);
    expect(denials(fixture), 'exactly one denial op').toHaveLength(1);
    expect(fixture.projected.filter((op) => !op.type.startsWith('auth.'))).toEqual([]);
  });

  it('POSITIVE CONTROL — the same command SUCCEEDS for a holder of the permission (T-14b)', async () => {
    const fixture = await ready(5);
    const command = makeCommandSpy(fixture.log, {
      name: 'manageRoles',
      permission: 'auth.role_manage',
    });

    // Without this, every denial assertion above would pass against a runtime that simply never
    // works, and against a fixture whose users hold nothing at all.
    await expect(
      fixture.runtime.execute(
        command,
        { title: 't', body: 'b' },
        fixture.runtime.createContext(fixture.ownerId),
      ),
    ).resolves.toBeDefined();

    expect(command.invocations).toHaveLength(1);
    expect(businessOps(fixture)).toHaveLength(1);
    expect(denials(fixture), 'a granted command emits no denial').toEqual([]);
  });

  it('the denial op carries a §7-valid payload and mirrors the attempt (task 09 wiring)', async () => {
    const fixture = await ready(6);
    const command = makeCommandSpy(fixture.log, {
      name: 'manageRoles',
      permission: 'auth.role_manage',
    });

    await fixture.runtime
      .execute(command, { title: 't', body: 'b' }, fixture.runtime.createContext(fixture.staffId))
      .catch(() => undefined);

    const op = denials(fixture)[0]!;
    // The payload shape is validated by the Zod `permissionDeniedPayload` (the auth op registry's
    // schema, on the real op path) — this asserts the WIRING, not the evaluation.
    expect(permissionDeniedPayload.safeParse(op.payload).success).toBe(true);
    expect(op.payload).toMatchObject({
      permissionId: 'auth.role_manage',
      surface: 'command',
      target: 'manageRoles',
      reason: 'not_granted',
      suppressedRepeats: 0,
    });
    expect(op.userId, 'attributed to the denied actor').toBe(fixture.staffId);
    expect(op.entityType).toBe('permission_denial');
  });

  it('a denied AGENT attempt is visible AS one (02 §7, ARCH-001 §9.3)', async () => {
    const fixture = await ready(7);
    const command = makeCommandSpy(fixture.log, {
      name: 'manageRoles',
      permission: 'auth.role_manage',
    });
    const ctx = fixture.runtime.createContext(fixture.staffId, {
      source: 'agent',
      agentInitiated: true,
      agentConversationId: 'conv-9',
    });

    await fixture.runtime.execute(command, { title: 't', body: 'b' }, ctx).catch(() => undefined);

    const op = denials(fixture)[0]!;
    expect(op.source).toBe('agent');
    expect(op.agentInitiated).toBe(true);
    expect(op.agentConversationId).toBe('conv-9');
  });

  it('the denial op is never itself permission-checked — no recursion (02 §7)', async () => {
    const fixture = await ready(8);
    const command = makeCommandSpy(fixture.log, { permission: 'auth.role_manage' });

    await fixture.runtime
      .execute(command, { title: 't', body: 'b' }, fixture.runtime.createContext(fixture.staffId))
      .catch(() => undefined);

    // ONE check: the denied command's. The denial's own append must not re-enter the evaluator,
    // or a denied user could never be logged as denied.
    expect(fixture.evaluator.checks).toHaveLength(1);
    expect(denials(fixture)).toHaveLength(1);
  });

  it('a zero-grant user is denied the literal 04 §8 case', async () => {
    const fixture = await ready(9);
    const command = makeCommandSpy(fixture.log);

    const error = await fixture.runtime
      .execute(
        command,
        { title: 't', body: 'b' },
        fixture.runtime.createContext(fixture.zeroGrantId),
      )
      .catch((e: unknown) => e);

    expectDomainError(error, 'PERMISSION_DENIED');
    expect(denials(fixture)).toHaveLength(1);
  });

  it('an unregistered permission denies `unknown_permission` and still logs (fail closed)', async () => {
    const fixture = await ready(10);
    const command = makeCommandSpy(fixture.log, { permission: 'ghost.total_access' });

    const error = await fixture.runtime
      .execute(command, { title: 't', body: 'b' }, fixture.runtime.createContext(fixture.ownerId))
      .catch((e: unknown) => e);

    const domainError = expectDomainError(error, 'PERMISSION_DENIED');
    expect(domainError.details?.reason).toBe('unknown_permission');
    expect(command.invocations).toEqual([]);
    expect(denials(fixture)).toHaveLength(1);
  });

  it('an unprimed evaluator denies everything — bootstrap fails closed (02 §6)', async () => {
    // No `prime()`: the evaluator has never loaded a directory, so it cannot see its own inputs.
    const fixture = makeRuntimeFixture(11);
    const command = makeCommandSpy(fixture.log);

    const error = await fixture.runtime
      .execute(command, { title: 't', body: 'b' }, fixture.runtime.createContext(fixture.ownerId))
      .catch((e: unknown) => e);

    const domainError = expectDomainError(error, 'PERMISSION_DENIED');
    expect(domainError.details?.reason).toBe('evaluation_error');
    expect(command.invocations).toEqual([]);
  });
});

describe('denial throttling (02 §7) — suppression must not swallow a distinct denial', () => {
  it('repeats of one tuple inside the window emit ONE op and count the rest', async () => {
    const fixture = await ready(12);
    const command = makeCommandSpy(fixture.log, {
      name: 'manageRoles',
      permission: 'auth.role_manage',
    });
    const ctx = fixture.runtime.createContext(fixture.staffId);

    for (let i = 0; i < 4; i += 1) {
      await fixture.runtime.execute(command, { title: 't', body: 'b' }, ctx).catch(() => undefined);
      fixture.clock.advance(1_000);
    }

    expect(denials(fixture), 'one op for four attempts in-window').toHaveLength(1);
    expect(
      fixture.denialSuppressed('manageRoles', 'auth.role_manage'),
      'the rest are counted',
    ).toBe(3);
  });

  it('EVERY attempt is still denied while suppressed — the throttle gags the log, not the control', async () => {
    const fixture = await ready(13);
    const command = makeCommandSpy(fixture.log, {
      name: 'manageRoles',
      permission: 'auth.role_manage',
    });
    const ctx = fixture.runtime.createContext(fixture.staffId);

    for (let i = 0; i < 4; i += 1) {
      const error = await fixture.runtime
        .execute(command, { title: 't', body: 'b' }, ctx)
        .catch((e: unknown) => e);
      // A suppressed audit record must never read as "allowed".
      expectDomainError(error, 'PERMISSION_DENIED');
    }
    expect(command.invocations).toEqual([]);
  });

  it('the first emission after the window carries the suppressed count', async () => {
    const fixture = await ready(14);
    const command = makeCommandSpy(fixture.log, {
      name: 'manageRoles',
      permission: 'auth.role_manage',
    });
    const ctx = fixture.runtime.createContext(fixture.staffId);

    await fixture.runtime.execute(command, { title: 't', body: 'b' }, ctx).catch(() => undefined);
    await fixture.runtime.execute(command, { title: 't', body: 'b' }, ctx).catch(() => undefined);
    await fixture.runtime.execute(command, { title: 't', body: 'b' }, ctx).catch(() => undefined);
    fixture.clock.advance(DENIAL_THROTTLE_WINDOW_MS);
    await fixture.runtime.execute(command, { title: 't', body: 'b' }, ctx).catch(() => undefined);

    const ops = denials(fixture);
    expect(ops).toHaveLength(2);
    expect(ops[0]!.payload).toMatchObject({ suppressedRepeats: 0 });
    expect(ops[1]!.payload).toMatchObject({ suppressedRepeats: 2 });
  });

  it('a DISTINCT permission is never swallowed by another tuple`s window', async () => {
    const fixture = await ready(15);
    const ctx = fixture.runtime.createContext(fixture.staffId);
    const roles = makeCommandSpy(fixture.log, {
      name: 'manageRoles',
      permission: 'auth.role_manage',
    });
    const tenant = makeCommandSpy(fixture.log, {
      name: 'configureTenant',
      permission: 'auth.tenant_configure',
    });

    await fixture.runtime.execute(roles, { title: 't', body: 'b' }, ctx).catch(() => undefined);
    await fixture.runtime.execute(roles, { title: 't', body: 'b' }, ctx).catch(() => undefined);
    await fixture.runtime.execute(tenant, { title: 't', body: 'b' }, ctx).catch(() => undefined);

    const ops = denials(fixture);
    expect(ops, 'the second, distinct denial must still be logged').toHaveLength(2);
    expect(ops.map((op) => (op.payload as { permissionId: string }).permissionId)).toEqual([
      'auth.role_manage',
      'auth.tenant_configure',
    ]);
  });

  it('a DISTINCT target is never swallowed by another tuple`s window', async () => {
    const fixture = await ready(16);
    const ctx = fixture.runtime.createContext(fixture.staffId);
    // Same permission, different command — a different `target`, hence a different tuple (§7).
    const a = makeCommandSpy(fixture.log, { name: 'createRole', permission: 'auth.role_manage' });
    const b = makeCommandSpy(fixture.log, { name: 'deleteRole', permission: 'auth.role_manage' });

    await fixture.runtime.execute(a, { title: 't', body: 'b' }, ctx).catch(() => undefined);
    await fixture.runtime.execute(b, { title: 't', body: 'b' }, ctx).catch(() => undefined);

    expect(denials(fixture)).toHaveLength(2);
  });

  it('a DISTINCT user is never swallowed by another tuple`s window', async () => {
    const fixture = await ready(17);
    const command = makeCommandSpy(fixture.log, {
      name: 'manageRoles',
      permission: 'auth.role_manage',
    });

    await fixture.runtime
      .execute(command, { title: 't', body: 'b' }, fixture.runtime.createContext(fixture.staffId))
      .catch(() => undefined);
    await fixture.runtime
      .execute(
        command,
        { title: 't', body: 'b' },
        fixture.runtime.createContext(fixture.zeroGrantId),
      )
      .catch(() => undefined);

    const ops = denials(fixture);
    expect(ops).toHaveLength(2);
    expect(ops.map((op) => op.userId)).toEqual([fixture.staffId, fixture.zeroGrantId]);
  });
});

describe('ctx.requirePermission — the handler-facing second check (04 §5.2)', () => {
  it('denies through the SAME path, emitting a denial op', async () => {
    const fixture = await ready(18);
    const command = makeCommandSpy(fixture.log, {
      onHandler: async (_input, ctx) => {
        // A granted command whose handler needs a second, input-dependent permission.
        await ctx.requirePermission('auth.role_manage');
      },
    });

    const error = await fixture.runtime
      .execute(command, { title: 't', body: 'b' }, fixture.runtime.createContext(fixture.staffId))
      .catch((e: unknown) => e);

    expectDomainError(error, 'PERMISSION_DENIED');
    expect(denials(fixture)).toHaveLength(1);
    expect(businessOps(fixture), 'the command must not append when its inner check denied').toEqual(
      [],
    );
  });

  it('POSITIVE CONTROL — passes for a holder, and the command completes (T-14b)', async () => {
    const fixture = await ready(19);
    const command = makeCommandSpy(fixture.log, {
      onHandler: async (_input, ctx) => {
        await ctx.requirePermission('auth.role_manage');
      },
    });

    await expect(
      fixture.runtime.execute(
        command,
        { title: 't', body: 'b' },
        fixture.runtime.createContext(fixture.ownerId),
      ),
    ).resolves.toBeDefined();
    expect(businessOps(fixture)).toHaveLength(1);
    expect(denials(fixture)).toEqual([]);
  });
});

describe('handler-declared restriction denials are audited (02 §7 amended; §5.4)', () => {
  // A §5.4 targeting/privileged-target restriction is decided by the handler (it needs the
  // directory), NOT the evaluator — so it cannot be emitted at step 2. The handler is PURE and
  // cannot emit either; it DECLARES the denial by throwing `restriction_violated`, and the runtime
  // EMITS the op through the SAME enforcement point an evaluator denial uses. Without this, a
  // `restriction_violated` denial is invisible in the FR-1045 audit — the class task 44 closes.
  const declareRestriction = (): void => {
    throw new DomainError(
      'PERMISSION_DENIED',
      { target: 'createNote', reason: 'restriction_violated' },
      'handler-declared §5.4 restriction',
    );
  };

  it('a granted command whose handler DECLARES a restriction is denied AND emits one denial op', async () => {
    const fixture = await ready(30);
    const command = makeCommandSpy(fixture.log, { onHandler: declareRestriction });

    const error = await fixture.runtime
      .execute(command, { title: 't', body: 'b' }, fixture.runtime.createContext(fixture.ownerId))
      .catch((e: unknown) => e);

    const denied = expectDomainError(error, 'PERMISSION_DENIED');
    expect(denied.details, 'the reason survives onto the thrown error').toMatchObject({
      reason: 'restriction_violated',
    });
    expect(businessOps(fixture), 'a declined command appends no business op').toEqual([]);
    const ops = denials(fixture);
    expect(ops, 'exactly one denial op — the WHOLE set (T-14)').toHaveLength(1);
    expect(permissionDeniedPayload.safeParse(ops[0]!.payload).success).toBe(true);
    expect(ops[0]!.payload).toMatchObject({
      permissionId: 'notes.create', // the command's declared permission
      surface: 'command',
      target: 'createNote',
      reason: 'restriction_violated',
      suppressedRepeats: 0,
    });
    expect(ops[0]!.userId, 'attributed to the denied actor').toBe(fixture.ownerId);
    expect(ops[0]!.entityType).toBe('permission_denial');
  });

  it('POSITIVE CONTROL — the same command WITHOUT the restriction appends and emits no denial (T-14b)', async () => {
    const fixture = await ready(31);
    const command = makeCommandSpy(fixture.log); // handler does not declare a restriction

    await expect(
      fixture.runtime.execute(
        command,
        { title: 't', body: 'b' },
        fixture.runtime.createContext(fixture.ownerId),
      ),
    ).resolves.toBeDefined();
    expect(businessOps(fixture)).toHaveLength(1);
    expect(denials(fixture), 'no restriction, no denial').toEqual([]);
  });

  it('the deny survives a FAILED audit append — a broken log must not authorize (task 10 ordering)', async () => {
    // The catch wraps the AUDIT, not the DECISION: if the denial op cannot be appended, the command
    // is STILL denied. A `catch` around a security decision is where fail-closed goes to die.
    let broken = false;
    const fixture = await ready(32, {
      insertFault: () => (broken ? new Error('disk full') : null),
    });
    const command = makeCommandSpy(fixture.log, { onHandler: declareRestriction });
    const ctx = fixture.runtime.createContext(fixture.ownerId);
    broken = true; // arm the fault only after enrollment

    const error = await fixture.runtime
      .execute(command, { title: 't', body: 'b' }, ctx)
      .catch((e: unknown) => e);

    // Denied regardless — the failed emit is swallowed, the throw is unconditional.
    const denied = expectDomainError(error, 'PERMISSION_DENIED');
    expect(denied.details).toMatchObject({ reason: 'restriction_violated' });
    // The audit append failed, so no denial op landed — proving the deny is INDEPENDENT of it.
    expect(denials(fixture), 'the append failed; the deny did not').toEqual([]);
    expect(businessOps(fixture)).toEqual([]);
  });
});

describe('a HUNG denial-audit emit must not wedge execute (task 40 — liveness)', () => {
  // The deny path awaits `DenialEmitter.record` → `port.emit` → `appendLocalOps` →
  // `store.transaction` (enforce.ts). A denial is the one thing an attacker can provoke at will, so
  // that await is the attacker-reachable one. If the client transaction NEVER settles (a stuck
  // op-sqlite WAL lock), `execute()` never settles and the runtime is wedged forever — there is no
  // timeout or abort on the chain. Task 40 bounds the emit so a hung audit is abandoned and the deny
  // still returns. Contrast task 10/44 (a FAILED emit, already swallowed) — here the emit HANGS.
  const deniedCommand = (fixture: RuntimeFixture) =>
    // `auth.role_manage` is main_owner-only (§12) — staff is denied, at will.
    makeCommandSpy(fixture.log, { name: 'manageRoles', permission: 'auth.role_manage' });

  it('WITHOUT the bound (no timer wired) the hung emit wedges execute — the wedge, reproduced (T-11)', async () => {
    // The pre-task-40 unbounded await, kept in-tree as the falsification witness: it is exactly what
    // the bounded test below becomes if the bound is removed. `entered` proves the hang is REACHED
    // (T-14b) — a wedge you never reached is not the wedge.
    let hang!: ArmableHangStore;
    const fixture = await ready(40, {
      wrapStore: (inner) => {
        hang = new ArmableHangStore(inner);
        return hang;
      },
    });
    const command = deniedCommand(fixture);
    hang.armed = true; // arm only AFTER enroll's genesis append

    const p = fixture.runtime.execute(
      command,
      { title: 't', body: 'b' },
      fixture.runtime.createContext(fixture.staffId),
    );
    const tracked = track(p);

    expect(hang.entered, 'the audit emit must actually reach the hanging append (T-14b)').toBe(
      true,
    );
    // No bound: nothing can free execute. Draining every microtask leaves it pending — the wedge.
    await flush();
    expect(
      tracked.settled,
      'unbounded, execute never settles even after the whole queue drains — the liveness bug',
    ).toBe(false);
  });

  it('WITH the bound wired, the hung emit no longer wedges — execute rejects PERMISSION_DENIED once it elapses', async () => {
    const timer = new ControllableTimer();
    let hang!: ArmableHangStore;
    const fixture = await ready(41, {
      denialAuditTimer: timer,
      wrapStore: (inner) => {
        hang = new ArmableHangStore(inner);
        return hang;
      },
    });
    const command = deniedCommand(fixture);
    hang.armed = true;

    const p = fixture.runtime.execute(
      command,
      { title: 't', body: 'b' },
      fixture.runtime.createContext(fixture.staffId),
    );
    const tracked = track(p);

    // Live fixture (T-14b): the emit reached the hang, AND the bound armed exactly one timeout.
    // Without the fix this second assertion fails CLEANLY (0 ≠ 1) — a discriminating RED, not a
    // runner hang (T-17).
    expect(hang.entered, 'the audit emit must reach the hanging append').toBe(true);
    expect(timer.scheduled, 'the emit await must be bounded by exactly one scheduled timeout').toBe(
      1,
    );

    // Genuinely wedged until the bound fires: draining the queue does not settle it.
    await flush();
    expect(
      tracked.settled,
      'still pending while the emit hangs and the bound has not elapsed',
    ).toBe(false);

    // The bound elapses.
    timer.fireAll();
    await flush();

    // The wedge is gone: execute settled, and it DENIED — unconditionally, despite the dead audit.
    expect(tracked.settled, 'execute must settle once the bound elapses').toBe(true);
    expectDomainError(tracked.error, 'PERMISSION_DENIED');
    // Unconditional deny: the hung append wrote nothing, yet the command still denied — the deny is
    // independent of the audit (the §6 guarantee task 40 must not weaken).
    expect(denials(fixture), 'the hung append landed no op — the deny did not wait on it').toEqual(
      [],
    );
    expect(businessOps(fixture), 'a denied command appends no business op').toEqual([]);
  });

  it('NON-REGRESSION — with the bound wired, a NORMAL denial still records its audit op and cancels the timeout (T-14b)', async () => {
    // The timeout must not trade a hang for a MISSING audit record. A working emit still lands
    // exactly one denial op, and the resolved emit cancels the timeout it armed — no per-denial leak.
    const timer = new ControllableTimer();
    const fixture = await ready(42, { denialAuditTimer: timer });
    const command = deniedCommand(fixture);

    const error = await fixture.runtime
      .execute(command, { title: 't', body: 'b' }, fixture.runtime.createContext(fixture.staffId))
      .catch((e: unknown) => e);

    expectDomainError(error, 'PERMISSION_DENIED');
    expect(denials(fixture), 'the happy-path audit trail is intact — one denial op').toHaveLength(
      1,
    );
    expect(timer.scheduled, 'the resolved emit cancels its bound (no dangling timer)').toBe(0);
  });
});

describe('a LOST denial audit is SURFACED, not swallowed silently (task 99 — FR-1045 completeness)', () => {
  // THE BUG THIS CLOSES. The denial-audit emit is best-effort: task 10 (evaluator denials) and task
  // 44 (restriction denials) both swallow a failed append so the DECISION survives it. Correct — and
  // for four tasks also SILENT, so a PERSISTENTLY failing append (full disk, corrupt DB) made the
  // FR-1045 trail quietly incomplete with nothing anywhere able to notice. The tests above prove the
  // deny survives; these prove the LOSS is now visible, on both paths, through one surfacing point.
  //
  // WHAT MAKES THESE LOAD-BEARING RATHER THAN DECORATIVE (§2.11, T-14b). Every fault case below
  // asserts BOTH halves in the same test — the signal fired AND the deny still threw — because a
  // surfacing test passes just as happily against a runtime that reports failures and forgot to
  // deny. And every one is paired against the no-fault positive control: "a failure was reported"
  // is also exactly what a sink that fires on EVERY denial looks like.
  //
  // Distinct command NAMES per denial throughout: the §7 throttle keys on
  // `(userId, permissionId, target)` and a suppressed repeat never reaches the store at all, so
  // re-denying one tuple would test the throttle, not the append.
  const deniedCommand = (fixture: RuntimeFixture, name: string) =>
    // `auth.role_manage` is main_owner-only (§12) — staff is denied at will, no fixture surgery.
    makeCommandSpy(fixture.log, { name, permission: 'auth.role_manage' });

  const denyAs = async (fixture: RuntimeFixture, userId: string, command: CommandSpy) =>
    fixture.runtime
      .execute(command, { title: 't', body: 'b' }, fixture.runtime.createContext(userId))
      .catch((e: unknown) => e);

  it('POSITIVE CONTROL — a healthy denial surfaces NOTHING (the sink is not fired per-denial, T-14b)', async () => {
    const diagnostics = new RecordingAuditDiagnostics();
    const fixture = await ready(90, { denialAuditDiagnostics: diagnostics });

    const error = await denyAs(fixture, fixture.staffId, deniedCommand(fixture, 'manageRoles'));

    expectDomainError(error, 'PERMISSION_DENIED');
    expect(denials(fixture), 'the audit landed — nothing was lost').toHaveLength(1);
    expect(
      diagnostics.failures,
      'a recorded audit is not a lost one; the WHOLE set must be empty',
    ).toEqual([]);
  });

  it('a PERSISTENTLY failing append surfaces every lost audit with a CLIMBING count — and denies every time', async () => {
    // The task-99 scenario itself: the store is broken and stays broken. Pre-fix, this ran to
    // completion with three denials, zero audit ops, and zero trace of the three lost records.
    const diagnostics = new RecordingAuditDiagnostics();
    let broken = false;
    const fixture = await ready(91, {
      insertFault: () => (broken ? new Error('disk full') : null),
      denialAuditDiagnostics: diagnostics,
    });
    broken = true; // arm only AFTER enrollment's genesis append

    for (const name of ['manageRolesA', 'manageRolesB', 'manageRolesC']) {
      const error = await denyAs(fixture, fixture.staffId, deniedCommand(fixture, name));
      // HALF ONE, asserted inside the loop: the deny is unconditional under a dead audit.
      expectDomainError(error, 'PERMISSION_DENIED');
    }

    // HALF TWO: the loss is visible, and the RUN of losses is what distinguishes a persistent
    // fault from an accepted transient one. Asserted as the whole array (T-14) — an over-firing
    // sink fails here just as loudly as a silent one.
    expect(diagnostics.failures.map((f) => f.consecutiveFailures)).toEqual([1, 2, 3]);
    expect(diagnostics.failures.map((f) => f.outcome)).toEqual(['failed', 'failed', 'failed']);
    expect(diagnostics.failures.map((f) => f.target)).toEqual([
      'manageRolesA',
      'manageRolesB',
      'manageRolesC',
    ]);
    expect(diagnostics.failures[0]).toMatchObject({
      userId: fixture.staffId,
      permissionId: 'auth.role_manage',
      surface: 'command',
      reason: 'not_granted',
    });
    expect(
      (diagnostics.failures[0]?.error as Error | undefined)?.message,
      'the structured record carries the rejection an operator has to diagnose',
    ).toBe('disk full');
    // The audit trail really is incomplete — which is the whole reason the signal must exist.
    expect(denials(fixture), 'nothing was appended; every denial happened anyway').toEqual([]);
    expect(businessOps(fixture), 'no denied command reached a handler').toEqual([]);
  });

  it('the RESTRICTION path (task 44) surfaces through the SAME point — not a mirrored second one (§2.8)', async () => {
    // Both denial classes route through `#recordBounded`. If they ever stop, this goes red while
    // the evaluator test above stays green — which is the drift §2.8 exists to catch.
    const diagnostics = new RecordingAuditDiagnostics();
    let broken = false;
    const fixture = await ready(92, {
      insertFault: () => (broken ? new Error('disk full') : null),
      denialAuditDiagnostics: diagnostics,
    });
    const command = makeCommandSpy(fixture.log, {
      onHandler: () => {
        throw new DomainError(
          'PERMISSION_DENIED',
          { target: 'createNote', reason: 'restriction_violated' },
          'handler-declared §5.4 restriction',
        );
      },
    });
    broken = true;

    const error = await denyAs(fixture, fixture.ownerId, command);

    expectDomainError(error, 'PERMISSION_DENIED');
    expect(diagnostics.failures).toHaveLength(1);
    expect(diagnostics.failures[0]).toMatchObject({
      outcome: 'failed',
      consecutiveFailures: 1,
      reason: 'restriction_violated',
      target: 'createNote',
      userId: fixture.ownerId,
    });
    expect(denials(fixture), 'the restriction audit was lost too').toEqual([]);
  });

  it('a TRANSIENT failure neither blocks a deny nor latches — the next append records and the count resets', async () => {
    // The fail-safe must not be traded for the signal: one bad append is FR-1045's accepted
    // tolerance, and a counter that never resets would report a healthy store as persistently
    // broken forever — a false alarm is how a real one stops being read.
    const diagnostics = new RecordingAuditDiagnostics();
    let broken = false;
    const fixture = await ready(93, {
      insertFault: () => (broken ? new Error('transient lock') : null),
      denialAuditDiagnostics: diagnostics,
    });

    broken = true;
    expectDomainError(
      await denyAs(fixture, fixture.staffId, deniedCommand(fixture, 'manageRolesA')),
      'PERMISSION_DENIED',
    );

    broken = false; // the store recovers
    expectDomainError(
      await denyAs(fixture, fixture.staffId, deniedCommand(fixture, 'manageRolesB')),
      'PERMISSION_DENIED',
    );
    expect(denials(fixture), 'the recovered append records again').toHaveLength(1);

    broken = true; // and fails once more, much later
    expectDomainError(
      await denyAs(fixture, fixture.staffId, deniedCommand(fixture, 'manageRolesC')),
      'PERMISSION_DENIED',
    );

    expect(
      diagnostics.failures.map((f) => f.consecutiveFailures),
      'two isolated losses, each reported as a run of ONE — not an escalating false alarm',
    ).toEqual([1, 1]);
  });

  it('a HUNG append that the task-40 bound abandons is surfaced as `timed_out` — a wedged store loses the record too', async () => {
    // Task 40 makes the timeout RESOLVE so the deny proceeds. That kept `execute` live and left the
    // abandoned record as invisible as a rejected one: to everything outside the enforcement point,
    // an audit that timed out looked exactly like an audit that succeeded.
    const diagnostics = new RecordingAuditDiagnostics();
    const timer = new ControllableTimer();
    let hang!: ArmableHangStore;
    const fixture = await ready(94, {
      denialAuditTimer: timer,
      denialAuditDiagnostics: diagnostics,
      wrapStore: (inner) => {
        hang = new ArmableHangStore(inner);
        return hang;
      },
    });
    hang.armed = true;

    const tracked = track(
      fixture.runtime.execute(
        deniedCommand(fixture, 'manageRoles'),
        { title: 't', body: 'b' },
        fixture.runtime.createContext(fixture.staffId),
      ),
    );
    expect(hang.entered, 'the emit must actually reach the hanging append (T-14b)').toBe(true);
    await flush();
    expect(diagnostics.failures, 'nothing is lost YET — the bound has not elapsed').toEqual([]);

    timer.fireAll();
    await flush();

    expect(tracked.settled, 'the bound still frees execute (task 40 unchanged)').toBe(true);
    expectDomainError(tracked.error, 'PERMISSION_DENIED');
    expect(diagnostics.failures).toHaveLength(1);
    expect(diagnostics.failures[0]).toMatchObject({
      outcome: 'timed_out',
      consecutiveFailures: 1,
      target: 'manageRoles',
    });
    expect(
      diagnostics.failures[0]?.error,
      'nothing rejected — a timeout has no error to report',
    ).toBeUndefined();
    expect(denials(fixture), 'the hung append landed no op').toEqual([]);
  });

  it('a diagnostics sink that THROWS cannot break the deny — the reporter is not a new way to fail closed', async () => {
    // The one regression a new surface on this path could introduce, and the reason the sink call
    // is guarded: a denial must not become a generic error because the log the app wired is broken.
    const diagnostics = new ThrowingAuditDiagnostics();
    let broken = false;
    const fixture = await ready(95, {
      insertFault: () => (broken ? new Error('disk full') : null),
      denialAuditDiagnostics: diagnostics,
    });
    broken = true;

    const error = await denyAs(fixture, fixture.staffId, deniedCommand(fixture, 'manageRoles'));

    expect(
      diagnostics.calls,
      'the sink really was reached (T-14b — a sink never called cannot throw)',
    ).toBe(1);
    expectDomainError(error, 'PERMISSION_DENIED');
    expect(businessOps(fixture), 'and the handler still never ran').toEqual([]);
  });

  it('WITHOUT a sink wired the deny is byte-for-byte the old behaviour — still denied, still silent', async () => {
    // The pre-task-99 composition root must be unaffected: the port is optional, and its absence
    // may not turn a swallowed audit failure into a thrown one.
    let broken = false;
    const fixture = await ready(96, {
      insertFault: () => (broken ? new Error('disk full') : null),
    });
    broken = true;

    const error = await denyAs(fixture, fixture.staffId, deniedCommand(fixture, 'manageRoles'));

    expectDomainError(error, 'PERMISSION_DENIED');
    expect(denials(fixture)).toEqual([]);
    expect(businessOps(fixture)).toEqual([]);
  });
});
