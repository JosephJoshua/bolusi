// The 04-module-contract §5.1 sequence and the §2.1 envelope it completes.
import { describe, expect, it } from 'vitest';

import { zSignedCore, type SignedOperation } from '@bolusi/schemas';

import {
  expectDomainError,
  makeCommandSpy,
  makeRuntimeFixture,
  TEST_LOCATION,
  type RuntimeFixture,
} from './_fixtures.js';

/** A primed, enrolled fixture whose active user holds every v0 permission. */
async function ready(seed: number, options?: Parameters<typeof makeRuntimeFixture>[1]) {
  const fixture = makeRuntimeFixture(seed, options);
  await fixture.prime();
  await fixture.enroll();
  return fixture;
}

function appendedOps(fixture: RuntimeFixture): SignedOperation[] {
  return fixture.store
    .forDevice(fixture.deviceId)
    .map((row) => row.op)
    .filter((op) => op.type !== 'auth.device_enrolled');
}

describe('step 1 — strict input parse (04 §5.1)', () => {
  it('rejects an unknown key with VALIDATION_FAILED, never reaching the handler', async () => {
    const fixture = await ready(1);
    const command = makeCommandSpy(fixture.log);

    const error = await fixture.runtime
      .execute(
        command,
        { title: 't', body: 'b', extra: 'nope' },
        fixture.runtime.createContext(fixture.ownerId),
      )
      .catch((e: unknown) => e);

    expectDomainError(error, 'VALIDATION_FAILED');
    expect(command.invocations, 'handler must not run on a parse failure').toEqual([]);
    expect(appendedOps(fixture), 'nothing appended').toEqual([]);
    expect(fixture.projected, 'projections untouched').toEqual([]);
  });

  it('rejects a wrong type with VALIDATION_FAILED, never reaching the handler', async () => {
    const fixture = await ready(2);
    const command = makeCommandSpy(fixture.log);

    const error = await fixture.runtime
      .execute(command, { title: 't', body: 42 }, fixture.runtime.createContext(fixture.ownerId))
      .catch((e: unknown) => e);

    expectDomainError(error, 'VALIDATION_FAILED');
    expect(command.invocations).toEqual([]);
    expect(appendedOps(fixture)).toEqual([]);
  });

  it('parses before it checks the permission — a malformed input never reaches the evaluator', async () => {
    const fixture = await ready(3);
    const command = makeCommandSpy(fixture.log);

    await fixture.runtime
      .execute(command, { nope: 1 }, fixture.runtime.createContext(fixture.ownerId))
      .catch(() => undefined);

    expect(fixture.evaluator.checks, 'step 1 precedes step 2 (04 §5.1)').toEqual([]);
  });

  it('VALIDATION_FAILED details name the command and the failing field, never caller-controlled text', async () => {
    const fixture = await ready(4);
    const command = makeCommandSpy(fixture.log);
    const secret = 'super-secret-value';

    const error = await fixture.runtime
      .execute(
        command,
        // `secret` appears both as a VALUE and as an unrecognized KEY — the two ways caller text
        // can reach a schema error. `details` is surfaced to logs/telemetry (03 §12), so neither
        // may ride along: that is how a mistyped PIN ends up in a log file.
        { title: secret, body: 1, [secret]: 1 },
        fixture.runtime.createContext(fixture.ownerId),
      )
      .catch((e: unknown) => e);

    const domainError = expectDomainError(error, 'VALIDATION_FAILED');
    expect(domainError.details?.command).toBe('createNote');
    // It still says something useful — the failing FIELD, which is schema structure, not data.
    expect(String(domainError.details?.issue)).toContain('body');
    expect(JSON.stringify(domainError.details)).not.toContain(secret);
    expect(domainError.message).not.toContain(secret);
  });
});

describe('the sequence runs in 04 §5.1 order', () => {
  it('parse → permission → handler → project → schedule sync, once each', async () => {
    const fixture = await ready(5);
    const command = makeCommandSpy(fixture.log);

    await fixture.runtime.execute(
      command,
      { title: 't', body: 'b' },
      fixture.runtime.createContext(fixture.ownerId),
    );

    expect(fixture.log.events).toEqual(['permission-check', 'handler', 'project', 'schedule-sync']);
  });

  it('schedules sync exactly once per successful command, and never when the command failed', async () => {
    const fixture = await ready(6);
    const command = makeCommandSpy(fixture.log);
    const ctx = fixture.runtime.createContext(fixture.ownerId);

    await fixture.runtime.execute(command, { title: 't', body: 'b' }, ctx);
    expect(fixture.scheduler.calls).toBe(1);

    await fixture.runtime.execute(command, { bad: true }, ctx).catch(() => undefined);
    expect(fixture.scheduler.calls, 'a failed command schedules no sync').toBe(1);
  });

  it('returns the handler result alongside the appended ops', async () => {
    const fixture = await ready(7);
    const command = makeCommandSpy(fixture.log);

    const outcome = await fixture.runtime.execute(
      command,
      { title: 't', body: 'b' },
      fixture.runtime.createContext(fixture.ownerId),
    );

    expect(outcome.ops).toHaveLength(1);
    expect(outcome.result?.noteId).toBe(appendedOps(fixture)[0]?.entityId);
  });
});

describe('step 4 — envelope completion (05 §2.1)', () => {
  it('every appended op is exactly a §2.1 signed core — every field present, none extra', async () => {
    const fixture = await ready(8);
    const command = makeCommandSpy(fixture.log);

    await fixture.runtime.execute(
      command,
      { title: 't', body: 'b' },
      fixture.runtime.createContext(fixture.ownerId),
    );

    const ops = appendedOps(fixture);
    expect(ops, 'fixture must have produced an op to check (T-14b)').toHaveLength(1);
    const op = ops[0]!;

    // `zSignedCore` is strict: a missing field OR an extra one fails. Parsing the op against the
    // spec's own schema is the assertion — a hand-listed field set would drift from 05 §2.1.
    const { hash, signature, ...core } = op as SignedOperation;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(signature.length).toBeGreaterThan(0);
    expect(() => zSignedCore.parse(core)).not.toThrow();

    // The §2.1 field set, asserted as a SET so a field added to the envelope without a decision
    // here fails loudly (T-14 — the denominator, not a sample).
    expect(Object.keys(core).sort()).toEqual(
      [
        'agentConversationId',
        'agentInitiated',
        'deviceId',
        'entityId',
        'entityType',
        'id',
        'location',
        'payload',
        'previousHash',
        'schemaVersion',
        'seq',
        'source',
        'storeId',
        'tenantId',
        'timestamp',
        'type',
        'userId',
      ].sort(),
    );
  });

  it('applies the §2.1 defaults: source "ui", agentInitiated false, agentConversationId null', async () => {
    const fixture = await ready(9);
    const command = makeCommandSpy(fixture.log);

    await fixture.runtime.execute(
      command,
      { title: 't', body: 'b' },
      fixture.runtime.createContext(fixture.ownerId),
    );

    const op = appendedOps(fixture)[0]!;
    expect(op.source).toBe('ui');
    expect(op.agentInitiated).toBe(false);
    expect(op.agentConversationId).toBeNull();
  });

  it('nullable fields are explicitly present-and-null, never absent (05 §3)', async () => {
    const fixture = await ready(10, { location: null });
    const command = makeCommandSpy(fixture.log);

    await fixture.runtime.execute(
      command,
      { title: 't', body: 'b' },
      fixture.runtime.createContext(fixture.ownerId),
    );

    const op = appendedOps(fixture)[0]!;
    for (const field of ['location', 'agentConversationId'] as const) {
      expect(field in op, `${field} must be PRESENT`).toBe(true);
      expect(op[field], `${field} must be null`).toBeNull();
    }
  });

  it('an agent-initiated invocation stamps its attribution onto the ops (ARCH-001 §9.3)', async () => {
    const fixture = await ready(11);
    const command = makeCommandSpy(fixture.log);
    const ctx = fixture.runtime.createContext(fixture.ownerId, {
      source: 'agent',
      agentInitiated: true,
      agentConversationId: 'conv-7',
    });

    await fixture.runtime.execute(command, { title: 't', body: 'b' }, ctx);

    const op = appendedOps(fixture)[0]!;
    expect(op.source).toBe('agent');
    expect(op.agentInitiated).toBe(true);
    expect(op.agentConversationId).toBe('conv-7');
  });

  it('stamps the device identity from construction, not from the call site (02 §5.2 v0 rule)', async () => {
    const fixture = await ready(12);
    const command = makeCommandSpy(fixture.log);

    await fixture.runtime.execute(
      command,
      { title: 't', body: 'b' },
      fixture.runtime.createContext(fixture.staffId),
    );

    const op = appendedOps(fixture)[0]!;
    expect(op.tenantId).toBe(fixture.tenantId);
    expect(op.storeId).toBe(fixture.storeId);
    expect(op.deviceId).toBe(fixture.deviceId);
    expect(op.userId, 'the acting user is the per-context part').toBe(fixture.staffId);
  });
});

describe('step 4 — the atomic timestamp stamp (04 §5.2)', () => {
  it('all drafts of one command share ONE runtime timestamp, even as the clock moves', async () => {
    const fixture = await ready(13);
    // A handler that advances the clock mid-command: if the stamp were read per draft, the ops
    // would disagree. Handlers have no clock (§5.2), so this reaches the FakeClock the fixture
    // owns — modelling any clock movement concurrent with the command.
    const command = makeCommandSpy(fixture.log, {
      extraOps: 2,
      onHandler: () => {
        fixture.clock.advance(5_000);
      },
    });

    const outcome = await fixture.runtime.execute(
      command,
      { title: 't', body: 'b' },
      fixture.runtime.createContext(fixture.ownerId),
    );

    const ops = appendedOps(fixture);
    expect(ops, 'the command must emit 3 drafts for this to mean anything (T-14b)').toHaveLength(3);
    const stamps = new Set(ops.map((op) => op.timestamp));
    expect(stamps.size, 'one stamp for the whole command (04 §5.2)').toBe(1);
    expect([...stamps][0]!).toBe(outcome.timestamp);
  });

  it('separate commands get separate stamps', async () => {
    const fixture = await ready(14);
    const command = makeCommandSpy(fixture.log);
    const ctx = fixture.runtime.createContext(fixture.ownerId);

    const first = await fixture.runtime.execute(command, { title: 'a', body: 'b' }, ctx);
    fixture.clock.advance(1_000);
    const second = await fixture.runtime.execute(command, { title: 'c', body: 'd' }, ctx);

    expect(second.timestamp - first.timestamp).toBe(1_000);
  });
});

describe('step 4 — location (04 §5.1; PRD-009 FR-802)', () => {
  it('stamps a fix verbatim', async () => {
    const fixture = await ready(15);
    const command = makeCommandSpy(fixture.log);

    await fixture.runtime.execute(
      command,
      { title: 't', body: 'b' },
      fixture.runtime.createContext(fixture.ownerId),
    );

    expect(appendedOps(fixture)[0]?.location).toEqual(TEST_LOCATION);
  });

  it('a null fix appends location: null and never blocks — the port is read once, never polled', async () => {
    const fixture = await ready(16, { location: null });
    const command = makeCommandSpy(fixture.log);

    await fixture.runtime.execute(
      command,
      { title: 't', body: 'b' },
      fixture.runtime.createContext(fixture.ownerId),
    );

    expect(appendedOps(fixture)[0]?.location).toBeNull();
    // "Never blocks" is only meaningful if nothing retries: one call, one command.
    expect(fixture.location.calls, 'no retry, no poll of the location port').toBe(1);
  });

  it('reads the location port exactly once per command however many ops it emits', async () => {
    const fixture = await ready(17);
    const command = makeCommandSpy(fixture.log, { extraOps: 3 });

    await fixture.runtime.execute(
      command,
      { title: 't', body: 'b' },
      fixture.runtime.createContext(fixture.ownerId),
    );

    expect(appendedOps(fixture)).toHaveLength(4);
    expect(fixture.location.calls).toBe(1);
  });
});

describe('ctx — the §5.2 surface', () => {
  it('exposes exactly the 04 §5.2 members and nothing else', async () => {
    const fixture = await ready(18);
    const ctx = fixture.runtime.createContext(fixture.ownerId);

    // The DENOMINATOR (T-14): asserted as an exact set. A db handle, a clock, or an `execute`
    // appearing on ctx is precisely the §5.2 purity breach this pins, and a spot-check of "does
    // ctx have op()?" would never see it.
    expect(Object.keys(ctx).sort()).toEqual(
      [
        'deviceId',
        'newId',
        'op',
        'query',
        'requirePermission',
        'storeId',
        'tenantId',
        'userId',
      ].sort(),
    );
  });

  it('carries no clock, no db handle, no transport and no nested execute', async () => {
    const fixture = await ready(19);
    const ctx = fixture.runtime.createContext(fixture.ownerId) as unknown as Record<
      string,
      unknown
    >;

    for (const forbidden of [
      'db',
      'kysely',
      'now',
      'clock',
      'execute',
      'fetch',
      'transport',
      'store',
    ]) {
      expect(ctx[forbidden], `ctx must not expose ${forbidden} (04 §5.2)`).toBeUndefined();
    }
  });

  it('ctx.newId() yields a valid UUIDv7 from the injected IdSource', async () => {
    const fixture = await ready(20);
    const ctx = fixture.runtime.createContext(fixture.ownerId);

    const id = ctx.newId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('ctx.query() routes to the injected executor carrying the ctx identity', async () => {
    const fixture = await ready(21);
    const listNotes = {
      permission: 'notes.read',
      input: { parse: (raw: unknown) => raw as { limit: number } },
      handler: (): { rows: string[] } => ({ rows: [] }),
    };
    fixture.queries.stub('notes.read', { rows: ['a'] });

    const command = makeCommandSpy(fixture.log, {
      onHandler: async (_input, ctx) => {
        const result = await ctx.query(listNotes, { limit: 5 });
        expect(result).toEqual({ rows: ['a'] });
      },
    });

    await fixture.runtime.execute(
      command,
      { title: 't', body: 'b' },
      fixture.runtime.createContext(fixture.staffId),
    );

    expect(fixture.queries.calls).toHaveLength(1);
    expect(fixture.queries.calls[0]?.input).toEqual({ limit: 5 });
    expect(fixture.queries.calls[0]?.identity).toMatchObject({
      userId: fixture.staffId,
      tenantId: fixture.tenantId,
      storeId: fixture.storeId,
      deviceId: fixture.deviceId,
    });
  });

  it('ctx.op() is pure — building a draft appends nothing', async () => {
    const fixture = await ready(22);
    const ctx = fixture.runtime.createContext(fixture.ownerId);

    const draft = ctx.op({
      type: 'notes.note_created',
      entityType: 'note',
      entityId: ctx.newId(),
      payload: { title: 't', body: 'b' },
    });

    expect(draft.schemaVersion, 'defaults to 1 until task 11 lands the operation registry').toBe(1);
    expect(appendedOps(fixture), 'ctx.op() must not append').toEqual([]);
  });
});

describe('determinism (testing-guide T-6)', () => {
  it('the whole runtime is constructible from a FakeClock + seeded IdSource and is byte-stable per seed', async () => {
    const run = async (seed: number): Promise<SignedOperation[]> => {
      const fixture = await ready(seed);
      const command = makeCommandSpy(fixture.log, { extraOps: 2 });
      const ctx = fixture.runtime.createContext(fixture.ownerId);
      await fixture.runtime.execute(command, { title: 'stable', body: 'body' }, ctx);
      fixture.clock.advance(1_234);
      await fixture.runtime.execute(command, { title: 'second', body: 'body2' }, ctx);
      return appendedOps(fixture);
    };

    const a = await run(99);
    const b = await run(99);

    expect(a, 'a non-trivial op run is the point (T-14b)').toHaveLength(6);
    // Byte-stable: ids, hashes and signatures all reproduce. Anything reading a real clock or a
    // real CSPRNG breaks this line, which is exactly what it is for.
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(a[0]!.hash).not.toBe(a[1]!.hash);
  });

  it('different seeds produce different ops (the determinism assertion is not vacuous)', async () => {
    const fixture99 = await ready(99);
    const fixture100 = await ready(100);
    const c99 = makeCommandSpy(fixture99.log);
    const c100 = makeCommandSpy(fixture100.log);

    await fixture99.runtime.execute(
      c99,
      { title: 'stable', body: 'body' },
      fixture99.runtime.createContext(fixture99.ownerId),
    );
    await fixture100.runtime.execute(
      c100,
      { title: 'stable', body: 'body' },
      fixture100.runtime.createContext(fixture100.ownerId),
    );

    expect(appendedOps(fixture100)[0]?.hash).not.toBe(appendedOps(fixture99)[0]?.hash);
  });
});

describe('ctx provenance (04 §5.2)', () => {
  it('refuses a hand-rolled ctx — a foreign ctx cannot walk a handler past the check', async () => {
    const fixture = await ready(23);
    const command = makeCommandSpy(fixture.log);

    // The shape of a real ctx, with a no-op requirePermission and a borrowed userId — exactly what
    // an attacker or a careless caller would build if `execute` trusted its ctx argument.
    const forged = {
      tenantId: fixture.tenantId,
      storeId: fixture.storeId,
      userId: fixture.ownerId,
      deviceId: fixture.deviceId,
      op: (draft: unknown) => draft,
      newId: () => fixture.newId(),
      requirePermission: () => Promise.resolve(),
      query: () => Promise.resolve(undefined),
    };

    const error = await fixture.runtime
      .execute(command, { title: 't', body: 'b' }, forged as never)
      .catch((e: unknown) => e);

    expectDomainError(error, 'PERMISSION_DENIED');
    expect(command.invocations, 'handler must never run for a foreign ctx').toEqual([]);
    expect(appendedOps(fixture)).toEqual([]);
  });

  it('accepts a ctx this runtime minted (the refusal above is not blanket)', async () => {
    const fixture = await ready(24);
    const command = makeCommandSpy(fixture.log);

    await expect(
      fixture.runtime.execute(
        command,
        { title: 't', body: 'b' },
        fixture.runtime.createContext(fixture.ownerId),
      ),
    ).resolves.toBeDefined();
    expect(command.invocations).toHaveLength(1);
  });

  it("refuses another runtime's ctx", async () => {
    const a = await ready(25);
    const b = await ready(26);
    const command = makeCommandSpy(a.log);

    const error = await a.runtime
      .execute(command, { title: 't', body: 'b' }, b.runtime.createContext(b.ownerId))
      .catch((e: unknown) => e);

    expectDomainError(error, 'PERMISSION_DENIED');
    expect(command.invocations).toEqual([]);
  });
});
