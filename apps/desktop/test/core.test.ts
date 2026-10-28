// @vitest-environment node
// The offline core's own parts on the PC: the database driver, the crypto, and the line between the
// window and the core. Each is checked against the same suites and vectors the phone's are.
import {
  bytesToHex,
  DomainError,
  hexToBytes,
  RuleRefusal,
  StaffAdminError,
  utf8ToBytes,
} from '@bolusi/core';
import {
  argon2idVectors,
  DRIVER_CONFORMANCE_CASES,
  ed25519Vectors,
  runDriverConformance,
  sha256Vectors,
} from '@bolusi/test-support';
import { describe, expect, it } from 'vitest';

import { nodeCryptoPort } from '../src/core/crypto.js';
import { openNodeSqliteDriver } from '../src/core/sqlite-driver.js';
import { connect, serve, type Channel } from '../src/main/rpc.js';
import { reviveCoreError } from '../src/renderer/core-client.js';

describe('node:sqlite driver', () => {
  it('passes every case of the driver conformance suite', async () => {
    const results = await runDriverConformance(() =>
      openNodeSqliteDriver({ name: 'conformance.db', location: ':memory:' }),
    );
    expect(results.filter((result) => !result.passed)).toEqual([]);
    expect(results.map((result) => result.case)).toEqual(
      DRIVER_CONFORMANCE_CASES.map((testCase) => testCase.name),
    );
  });
});

describe('PC crypto', () => {
  it.each(sha256Vectors)('reproduces the $name digest', ({ messageUtf8, digestHex }) => {
    expect(bytesToHex(nodeCryptoPort.sha256(utf8ToBytes(messageUtf8)))).toBe(digestHex);
  });

  it.each(ed25519Vectors)('signs and verifies $name byte for byte', (vector) => {
    const seed = hexToBytes(vector.seedHex);
    const message = hexToBytes(vector.messageHex);
    expect(bytesToHex(nodeCryptoPort.ed25519GetPublicKey(seed))).toBe(vector.publicKeyHex);
    const signature = nodeCryptoPort.sign(message, seed);
    expect(bytesToHex(signature)).toBe(vector.signatureHex);
    expect(nodeCryptoPort.verify(signature, message, hexToBytes(vector.publicKeyHex))).toBe(true);
    expect(
      nodeCryptoPort.verify(signature, utf8ToBytes('x'), hexToBytes(vector.publicKeyHex)),
    ).toBe(false);
  });

  it('says no, rather than throwing, to a malformed public key', () => {
    expect(nodeCryptoPort.verify(new Uint8Array(64), new Uint8Array(1), new Uint8Array(31))).toBe(
      false,
    );
  });

  it.each(argon2idVectors)('derives the $name Argon2id tag', async (vector) => {
    const tag = await nodeCryptoPort.kdf(
      hexToBytes(vector.passwordHex),
      hexToBytes(vector.saltHex),
      {
        memoryCost: vector.memoryCost,
        timeCost: vector.timeCost,
        parallelism: vector.parallelism,
        outputLength: vector.outputLength,
        ...(vector.secretHex === '' ? {} : { secret: hexToBytes(vector.secretHex) }),
        ...(vector.associatedDataHex === ''
          ? {}
          : { associatedData: hexToBytes(vector.associatedDataHex) }),
      },
    );
    expect(bytesToHex(tag)).toBe(vector.tagHex);
  });
});

/** Two ends of an in-memory port, delivering asynchronously like a real one. */
function pair(): [Channel, Channel] {
  const listeners: [Set<(m: unknown) => void>, Set<(m: unknown) => void>] = [new Set(), new Set()];
  const end = (mine: 0 | 1): Channel => ({
    send: (message) =>
      queueMicrotask(() => {
        for (const listener of listeners[mine === 0 ? 1 : 0]) listener(structuredClone(message));
      }),
    listen(onMessage) {
      listeners[mine].add(onMessage);
      return () => listeners[mine].delete(onMessage);
    },
  });
  return [end(0), end(1)];
}

describe('window to core calls', () => {
  it('answers calls, pushes events and refuses unknown calls', async () => {
    const [core, window] = pair();
    const server = serve(core, { add: (a: number, b: number) => a + b });
    const client = connect(window, reviveCoreError);
    expect(await client.call('add', 2, 3)).toBe(5);
    await expect(client.call('toString')).rejects.toThrow('no such call: toString');

    const seen: unknown[] = [];
    client.on('state', (payload) => seen.push(payload));
    server.emit('state', { phase: 'ready' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toEqual([{ phase: 'ready' }]);
  });

  it('brings a domain error and a rule refusal back as their own classes', async () => {
    const [core, window] = pair();
    serve(core, {
      locked: () => {
        throw new DomainError('NOT_AUTHENTICATED');
      },
      refused: () => {
        throw new RuleRefusal('VALIDATION_FAILED', 'repair.price_needs_owner', { field: 'price' });
      },
      plain: () => {
        throw new TypeError('boom');
      },
      lastOwner: () => {
        throw new StaffAdminError('lastOwner');
      },
      forged: () => {
        throw Object.assign(new Error('x'), { name: 'StaffAdminError', reason: 'whatever' });
      },
    });
    const client = connect(window, reviveCoreError);

    const locked = await client.call('locked').catch((error: unknown) => error);
    expect(locked).toBeInstanceOf(DomainError);
    expect((locked as DomainError).code).toBe('NOT_AUTHENTICATED');

    const refused = await client.call('refused').catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(RuleRefusal);
    expect((refused as RuleRefusal).refusal).toBe('repair.price_needs_owner');

    const plain = await client.call('plain').catch((error: unknown) => error);
    expect(plain).not.toBeInstanceOf(DomainError);
    expect((plain as Error).name).toBe('TypeError');
    expect((plain as Error).message).toBe('boom');

    const lastOwner = await client.call('lastOwner').catch((error: unknown) => error);
    expect(lastOwner).toBeInstanceOf(StaffAdminError);
    expect((lastOwner as StaffAdminError).reason).toBe('lastOwner');
    const forged = await client.call('forged').catch((error: unknown) => error);
    expect((forged as StaffAdminError).reason).toBe('unexpected');
  });
});
