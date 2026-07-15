// The client append path (04-module-contract §5.1 steps 4–6; 05-operation-log §1, §4,
// §5, §9.5). Chain-continuity property test, the duplicate-id no-op, append/projection
// atomicity, and genesis-op shape. Crypto is real (@noble); clock/rng/id/store are
// injected, so every case is reproducible from its seed (T-6) — the seed is printed in
// each assertion message.
import {
  appendLocalOps,
  bytesToHex,
  canonicalizeJcs,
  GenesisRuleError,
  utf8ToBytes,
  verifyOp,
  type AppendContext,
  type JsonValue,
  type OpDraft,
  type ProjectionApply,
} from '@bolusi/core';
import { GENESIS_PREVIOUS_HASH, type SignedOperation } from '@bolusi/schemas';
import { randomInt } from '@bolusi/test-support';
import { describe, expect, it } from 'vitest';

import { appendCommand, makeFixture, type Fixture } from './_fixtures.js';

function coreOf(op: SignedOperation): Record<string, unknown> {
  const core: Record<string, unknown> = { ...op };
  delete core['hash'];
  delete core['signature'];
  return core;
}

/** Append a single command against `f`, with the given context and a no-op projection. */
async function append(
  f: Fixture,
  drafts: readonly OpDraft[],
  context: AppendContext = f.context,
): Promise<void> {
  await appendLocalOps({
    store: f.store,
    drafts,
    context,
    crypto: f.crypto,
    newId: f.newId,
    now: () => f.clock.now(),
    location: null,
    applyProjection: () => undefined,
  });
}

describe('appendLocalOps — chain-continuity property test (05 §4)', () => {
  // Property-varied length; one case ≥ 200. Each builds a genesis op then N−1 ops, with a
  // mid-chain userId change (the chain spans users — a PIN switch does not break it, 05 §4).
  const cases: ReadonlyArray<readonly [seed: number, n: number]> = [
    [101, 200],
    [102, 217],
    [103, 233],
    [104, 251],
  ];

  it.each(cases)('seed %i builds an unbroken %i-op device chain', async (seed, n) => {
    const f = makeFixture(seed);
    const msg = `seed=${seed}`;
    const userB = f.newId();
    const midpoint = randomInt(f.prng, 40, n - 40);

    await append(f, [f.genesisDraft()]); // seq 1
    for (let i = 2; i <= n; i += 1) {
      f.clock.advance(randomInt(f.prng, 1, 600_000)); // vary timestamp 1ms..10min
      const context: AppendContext = i < midpoint ? f.context : { ...f.context, userId: userB };
      await append(f, [f.noteDraft()], context);
    }

    const rows = f.store.forDevice(f.deviceId);
    expect(rows.length, msg).toBe(n);

    const seenUsers = new Set<string>();
    for (let i = 0; i < rows.length; i += 1) {
      const op = rows[i]!.op;
      const jcs = rows[i]!.signedCoreJcs;

      // seq is exactly 1..N, no gaps.
      expect(op.seq, `${msg} seq@${i}`).toBe(i + 1);

      // previousHash links (genesis = 64 zeros; otherwise = prior op's hash).
      if (i === 0) {
        expect(op.previousHash, `${msg} genesis previousHash`).toBe(GENESIS_PREVIOUS_HASH);
        expect(op.seq).toBe(1);
      } else {
        expect(op.previousHash, `${msg} link@${i}`).toBe(rows[i - 1]!.op.hash);
      }

      // hash === SHA-256(JCS(core)) recomputed INDEPENDENTLY (T-13).
      const independentJcs = canonicalizeJcs(coreOf(op) as JsonValue);
      expect(bytesToHex(f.crypto.sha256(utf8ToBytes(independentJcs))), `${msg} hash@${i}`).toBe(
        op.hash,
      );

      // signature verifies against the device pubkey.
      expect(verifyOp(op, f.publicKey, f.crypto), `${msg} sig@${i}`).toBe(true);

      // signed_core_jcs is the verbatim preimage AND a parse∘canonicalize fixpoint (10-db §2.1).
      expect(jcs, `${msg} jcs@${i}`).toBe(independentJcs);
      expect(canonicalizeJcs(JSON.parse(jcs) as JsonValue), `${msg} fixpoint@${i}`).toBe(jcs);

      seenUsers.add(op.userId);
    }

    // The chain genuinely spanned two users.
    expect(seenUsers.size, `${msg} chain spans users`).toBe(2);
  });
});

describe('appendLocalOps — duplicate-id no-op (05 §5)', () => {
  it('ignores an append of a duplicate operation id', async () => {
    const f = makeFixture(301);
    await append(f, [f.genesisDraft()]);
    const existing = f.store.forDevice(f.deviceId)[0]!.op;

    const headBefore = f.store.forDevice(f.deviceId).map((r) => r.op.hash);
    const countBefore = f.store.count();

    // Force the id source to return an id that already exists locally.
    let applied = 0;
    const { result } = await appendCommand(f, [f.noteDraft()], {
      newId: () => existing.id,
      applyProjection: () => {
        applied += 1;
      },
    });

    expect(result.ops).toEqual([{ status: 'duplicate', id: existing.id }]);
    expect(applied, 'projection apply must not run for a duplicate').toBe(0);
    expect(f.store.count(), 'no new row inserted').toBe(countBefore);
    expect(
      f.store.forDevice(f.deviceId).map((r) => r.op.hash),
      'chain head unchanged',
    ).toEqual(headBefore);
  });

  it('appends a fresh op but skips the duplicate within the same command', async () => {
    const f = makeFixture(302);
    await append(f, [f.genesisDraft()]);
    const existing = f.store.forDevice(f.deviceId)[0]!.op;

    // First draft gets a colliding id, second gets a fresh one.
    const ids = [existing.id, f.newId()];
    let call = 0;
    const { result } = await appendCommand(f, [f.noteDraft(), f.noteDraft()], {
      newId: () => ids[call++]!,
    });

    expect(result.ops[0]).toEqual({ status: 'duplicate', id: existing.id });
    expect(result.ops[1]!.status).toBe('appended');
    // The fresh op continues the chain from the unchanged head (genesis seq 1 → next seq 2).
    expect((result.ops[1] as { seq: number }).seq).toBe(2);
    expect(f.store.count()).toBe(2);
  });
});

describe('appendLocalOps — atomicity (04 §5.1: append is atomic with projection)', () => {
  it('rolls back the whole command when the projection seam throws, and a retry reuses the seq', async () => {
    const f = makeFixture(401);
    await append(f, [f.genesisDraft()]); // chain head at seq 1
    const countAfterGenesis = f.store.count();
    const headAfterGenesis = f.store.forDevice(f.deviceId).at(-1)!.op.hash;

    const draft = f.noteDraft();
    const boom: ProjectionApply = () => {
      throw new Error('projection blew up');
    };

    await expect(
      appendLocalOps({
        store: f.store,
        drafts: [draft],
        context: f.context,
        crypto: f.crypto,
        newId: f.newId,
        now: () => f.clock.now(),
        location: null,
        applyProjection: boom,
      }),
    ).rejects.toThrow('projection blew up');

    // Rolled back: no op row, chain head unchanged.
    expect(f.store.count(), 'no row after rollback').toBe(countAfterGenesis);
    expect(f.store.forDevice(f.deviceId).at(-1)!.op.hash, 'head unchanged').toBe(headAfterGenesis);

    // Retry with the same draft succeeds and takes the SAME seq the failed attempt would have.
    const { result } = await appendCommand(f, [draft]);
    expect(result.ops[0]!.status).toBe('appended');
    expect((result.ops[0] as { seq: number }).seq).toBe(2);
    expect(f.store.count()).toBe(countAfterGenesis + 1);
  });
});

describe('appendLocalOps — genesis-op shape (05 §9.5)', () => {
  it('accepts a valid genesis op as the first append (seq 1, 64-zero previousHash, entityId=deviceId)', async () => {
    const f = makeFixture(501);
    const { result } = await appendCommand(f, [f.genesisDraft()]);
    const op = (result.ops[0] as { op: SignedOperation }).op;
    expect(op.seq).toBe(1);
    expect(op.previousHash).toBe(GENESIS_PREVIOUS_HASH);
    expect(op.entityId).toBe(f.deviceId);
    expect(op.type).toBe('auth.device_enrolled');
    expect(f.store.count()).toBe(1);
  });

  it('rejects a non-genesis first op and inserts nothing', async () => {
    const f = makeFixture(502);
    await expect(append(f, [f.noteDraft()])).rejects.toBeInstanceOf(GenesisRuleError);
    expect(f.store.count(), 'nothing inserted on a rejected genesis').toBe(0);
  });

  it('rejects a second auth.device_enrolled on a non-empty chain and inserts nothing', async () => {
    const f = makeFixture(503);
    await append(f, [f.genesisDraft()]);
    const countAfterGenesis = f.store.count();
    await expect(append(f, [f.genesisDraft()])).rejects.toBeInstanceOf(GenesisRuleError);
    expect(f.store.count()).toBe(countAfterGenesis);
  });
});

describe('appendLocalOps — determinism (T-6)', () => {
  it('reproduces the same chain (ids + hashes) from the same seed', async () => {
    const build = async (): Promise<string[]> => {
      const f = makeFixture(601);
      await append(f, [f.genesisDraft()]);
      for (let i = 0; i < 5; i += 1) {
        f.clock.advance(1000);
        await append(f, [f.noteDraft()]);
      }
      return f.store.forDevice(f.deviceId).map((r) => `${r.op.id}:${r.op.hash}`);
    };
    expect(await build()).toEqual(await build());
  });
});
