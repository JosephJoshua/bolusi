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
import { MONEY_PERMISSION } from '@bolusi/modules/money';
import { REPAIR_PERMISSION } from '@bolusi/modules/repair';
import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import type { AppSessionController } from '@bolusi/device/bootstrap/session';

import { actingSession, actingStaffAdmin, readForActing } from '../src/core/acting.js';
import { heldPermissions } from '../src/core/permissions.js';
import { nodeCryptoPort } from '../src/core/crypto.js';
import { openNodeSqliteDriver } from '../src/core/sqlite-driver.js';
import { logUnhandledRejections } from '../src/core/unhandled.js';
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

/**
 * Two ends of an in-memory port, delivering asynchronously like a real one. Like a real one, `send`
 * clones at once and throws for a value that cannot be cloned.
 */
function pair(): [Channel, Channel] {
  const listeners: [Set<(m: unknown) => void>, Set<(m: unknown) => void>] = [new Set(), new Set()];
  const end = (mine: 0 | 1): Channel => ({
    send: (message) => {
      const copy = structuredClone(message);
      queueMicrotask(() => {
        for (const listener of listeners[mine === 0 ? 1 : 0]) listener(copy);
      });
    },
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

  it('still answers a call whose error or value cannot cross the port', async () => {
    const [core, window] = pair();
    serve(core, {
      badError: () => {
        throw Object.assign(new Error('save failed'), { details: { retry: () => undefined } });
      },
      badValue: () => ({ retry: () => undefined }),
    });
    const client = connect(window, reviveCoreError);

    const failed = await client.call('badError').catch((error: unknown) => error);
    expect((failed as Error).message).toBe('save failed');
    await expect(client.call('badValue')).rejects.toThrow();
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

describe('who a window call may act as', () => {
  const sessionAs = (
    userId: string | null,
    flags: { locked?: boolean; canManageStaff?: boolean } = {},
  ): AppSessionController =>
    ({
      snapshot: () => ({
        session: userId === null ? null : { userId },
        locked: flags.locked ?? false,
        canManageStaff: flags.canManageStaff ?? false,
      }),
    }) as unknown as AppSessionController;

  const code = (run: () => unknown): string | undefined => {
    try {
      run();
      return undefined;
    } catch (error) {
      return error instanceof DomainError ? error.code : (error as StaffAdminError).reason;
    }
  };

  it('is the person signed in and unlocked, never anyone else', () => {
    expect(code(() => actingSession(sessionAs('u-1'), 'u-1'))).toBeUndefined();
    expect(code(() => actingSession(sessionAs('u-1'), 'u-2'))).toBe('NOT_AUTHENTICATED');
    expect(code(() => actingSession(sessionAs('u-1', { locked: true }), 'u-1'))).toBe(
      'NOT_AUTHENTICATED',
    );
    expect(code(() => actingSession(sessionAs(null), 'u-1'))).toBe('NOT_AUTHENTICATED');
    expect(code(() => actingSession(null, 'u-1'))).toBe('NOT_AUTHENTICATED');
  });

  it('keeps a slow read only if its person is still signed in when it lands', async () => {
    let now: AppSessionController | null = sessionAs('u-a');
    const slowRead = (switchTo: AppSessionController | null) => (userId: string) => {
      // The person switches (or the PC locks) while the identity read is still running.
      now = switchTo;
      return Promise.resolve(`identity of ${userId}`);
    };

    expect(await readForActing(() => now, 'u-a', slowRead(sessionAs('u-a')))).toBe(
      'identity of u-a',
    );
    expect(await readForActing(() => now, 'u-a', slowRead(sessionAs('u-b')))).toBeNull();
    expect(
      await readForActing(() => now, 'u-a', slowRead(sessionAs('u-a', { locked: true }))),
    ).toBeNull();
    expect(await readForActing(() => now, 'u-a', slowRead(null))).toBeNull();
  });

  it('manages staff only with the permission to add staff', () => {
    expect(code(() => actingStaffAdmin(sessionAs('u-1'), 'u-1'))).toBe('denied');
    expect(
      code(() => actingStaffAdmin(sessionAs('u-1', { canManageStaff: true }), 'u-1')),
    ).toBeUndefined();
    expect(code(() => actingStaffAdmin(sessionAs('u-1', { canManageStaff: true }), 'u-2'))).toBe(
      'NOT_AUTHENTICATED',
    );
  });
});

describe('the permissions the window is told about', () => {
  it("are every module's the person holds, money's for Kas as much as repair's", () => {
    const granted = new Set([
      REPAIR_PERMISSION.read,
      MONEY_PERMISSION.read,
      MONEY_PERMISSION.countCash,
      'not.a.module.permission',
    ]);
    expect(heldPermissions((permission) => granted.has(permission)).sort()).toEqual(
      [REPAIR_PERMISSION.read, MONEY_PERMISSION.read, MONEY_PERMISSION.countCash].sort(),
    );
    expect(heldPermissions(() => true)).toEqual(
      expect.arrayContaining([
        ...Object.values(MONEY_PERMISSION),
        ...Object.values(REPAIR_PERMISSION),
      ]),
    );
  });
});

describe('a rejection nobody handles in the core', () => {
  it('is logged, and the core keeps running', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const source = new EventEmitter();
    logUnhandledRejections(source);
    // Node ends the process when no listener takes an unhandled rejection; this one is taken.
    expect(source.listenerCount('unhandledRejection')).toBe(1);
    source.emit('unhandledRejection', new Error('identity read failed'));
    expect(warn).toHaveBeenCalledWith('[bolusi] unhandled rejection in the core', {
      error: 'identity read failed',
    });
    warn.mockRestore();
  });
});
