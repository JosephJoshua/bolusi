// Append and projection are ONE transaction (04-module-contract §5.1 steps 5–6).
//
// The property: a throw anywhere inside the transaction leaves NOTHING behind — no op row, no
// projection write, no chain advance, no consumed `seq`. And the device keeps working afterwards:
// the next command takes the seq the failed one would have used. A rollback that leaked a `seq`
// would put a permanent gap in the device chain, which the server reads as CHAIN_GAP (05 §7) —
// i.e. one failed projection would halt the device's sync forever.
import { describe, expect, it } from 'vitest';

import type { SignedOperation } from '@bolusi/schemas';

import { makeCommandSpy, makeRuntimeFixture, type RuntimeFixture } from './_fixtures.js';

function businessOps(fixture: RuntimeFixture): SignedOperation[] {
  return fixture.store
    .forDevice(fixture.deviceId)
    .map((row) => row.op)
    .filter((op) => !op.type.startsWith('auth.'));
}

async function ready(seed: number, options?: Parameters<typeof makeRuntimeFixture>[1]) {
  const fixture = makeRuntimeFixture(seed, options);
  await fixture.prime();
  await fixture.enroll();
  return fixture;
}

describe('an applier that throws rolls the whole command back (04 §5.1)', () => {
  it('leaves no op, no chain advance, and no projection row — and the next command reuses the seq', async () => {
    let failNext = false;
    const applied: string[] = [];
    const fixture = await ready(1, {
      applyProjection: (op) => {
        if (failNext) throw new Error('applier exploded mid-apply');
        applied.push(op.id);
      },
    });
    // Enrollment projects too — arm the fault only once the device has a chain to roll back to.
    failNext = true;
    applied.length = 0;

    // Fixture assertion FIRST (T-14b): the genesis op proves the store works at all, so "nothing
    // was appended" below means the rollback worked, not that the fixture is inert.
    const genesisSeq = fixture.store.forDevice(fixture.deviceId).at(-1)?.op.seq;
    expect(genesisSeq, 'the device is enrolled — chain head exists').toBe(1);

    const command = makeCommandSpy(fixture.log);
    const ctx = fixture.runtime.createContext(fixture.ownerId);

    await expect(fixture.runtime.execute(command, { title: 't', body: 'b' }, ctx)).rejects.toThrow(
      'applier exploded mid-apply',
    );

    expect(
      command.invocations,
      'the handler DID run — the failure is downstream of it',
    ).toHaveLength(1);
    expect(businessOps(fixture), 'op absent from the local log').toEqual([]);
    expect(fixture.store.forDevice(fixture.deviceId), 'chain head unchanged').toHaveLength(1);
    expect(applied, 'no projection row survived').toEqual([]);
    expect(fixture.scheduler.calls, 'a rolled-back command schedules no sync').toBe(0);

    // The freed seq is reusable — the chain has no permanent gap.
    failNext = false;
    await fixture.runtime.execute(command, { title: 'second', body: 'try' }, ctx);

    const ops = businessOps(fixture);
    expect(ops).toHaveLength(1);
    expect(
      ops[0]!.seq,
      'the next command takes seq 2 — the seq the failed one would have used',
    ).toBe(2);
    expect(ops[0]!.previousHash, 'and chains off the genesis op, not off a ghost').toBe(
      fixture.store.forDevice(fixture.deviceId)[0]!.op.hash,
    );
  });

  it('rolls back EVERY op of a multi-op command when the applier throws on the second', async () => {
    let seen = 0;
    let armed = false;
    const fixture = await ready(2, {
      applyProjection: () => {
        if (!armed) return;
        seen += 1;
        if (seen === 2) throw new Error('second apply failed');
      },
    });
    armed = true;
    const command = makeCommandSpy(fixture.log, { extraOps: 2 });

    await expect(
      fixture.runtime.execute(
        command,
        { title: 't', body: 'b' },
        fixture.runtime.createContext(fixture.ownerId),
      ),
    ).rejects.toThrow('second apply failed');

    // The first op was already inserted when the second's apply threw — atomicity means it goes
    // too. A partial command is not a smaller command; it is a corrupt one.
    expect(businessOps(fixture), 'the already-inserted first op must roll back as well').toEqual(
      [],
    );
    expect(fixture.store.forDevice(fixture.deviceId)).toHaveLength(1);
  });

  it('an append failure after the handler ran rolls back identically', async () => {
    // The "append itself fails after the handler ran" leg — the insert breaks, not the applier.
    let broken = false;
    const fixture = await ready(3, {
      insertFault: () => (broken ? new Error('disk full') : null),
    });
    const command = makeCommandSpy(fixture.log);
    const ctx = fixture.runtime.createContext(fixture.ownerId);
    // Enrollment must succeed first, so the fault is armed only now.
    broken = true;

    await expect(fixture.runtime.execute(command, { title: 't', body: 'b' }, ctx)).rejects.toThrow(
      'disk full',
    );

    expect(command.invocations, 'the handler ran before the append failed').toHaveLength(1);
    expect(businessOps(fixture)).toEqual([]);
    expect(fixture.projected, 'the projection seam is never reached if the insert failed').toEqual(
      [],
    );
    expect(fixture.scheduler.calls).toBe(0);

    // POSITIVE CONTROL: the same command succeeds once the store works, on the freed seq.
    broken = false;
    await fixture.runtime.execute(command, { title: 't', body: 'b' }, ctx);
    expect(businessOps(fixture)).toHaveLength(1);
    expect(businessOps(fixture)[0]!.seq).toBe(2);
  });

  it('a handler that throws appends nothing and never reaches the store', async () => {
    const fixture = await ready(4);
    const command = makeCommandSpy(fixture.log, {
      onHandler: () => {
        throw new Error('precondition failed');
      },
    });

    await expect(
      fixture.runtime.execute(
        command,
        { title: 't', body: 'b' },
        fixture.runtime.createContext(fixture.ownerId),
      ),
    ).rejects.toThrow('precondition failed');

    expect(businessOps(fixture)).toEqual([]);
    expect(fixture.location.calls, 'step 4 is never reached').toBe(0);
    expect(fixture.scheduler.calls).toBe(0);
  });

  it('POSITIVE CONTROL — with a working applier the command commits and projects (T-14b)', async () => {
    const fixture = await ready(5);
    const command = makeCommandSpy(fixture.log, { extraOps: 1 });

    await fixture.runtime.execute(
      command,
      { title: 't', body: 'b' },
      fixture.runtime.createContext(fixture.ownerId),
    );

    expect(businessOps(fixture)).toHaveLength(2);
    expect(fixture.projected).toHaveLength(2);
    expect(fixture.scheduler.calls).toBe(1);
  });
});
