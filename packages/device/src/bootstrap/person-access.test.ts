// The signed-in person's reads beyond the device (least-privilege sync): when the PIN goes to the
// server, how long it is kept, what a read says meanwhile, and that it all ends with the person.
// The store itself (temp tables, the fold, nothing on disk) is proven in core least-privilege.test.
import { DeviceReads, InvalidationBus, SyncTransportError } from '@bolusi/core';
import type { PersonSessionRequest, PullResponse } from '@bolusi/schemas';
import { describe, expect, test } from 'vitest';

import { createPersonAccess, type PersonStoreLike } from './person-access.js';
import type { PersonTransportPort } from './transport.js';

const COSTS = 'inventory.cost_read';
const SESSION_TTL = 8 * 60 * 60 * 1000;
const REPAIR = 'repair.read';

const registry = {
  types: () => ['inventory.cost_set', 'repair.ticket_opened'],
  readPermissionFor: (type: string) => (type.startsWith('inventory.') ? COSTS : REPAIR),
};

interface FakeStore extends PersonStoreLike {
  closed: boolean;
  pulls: number;
}

function harness(readSet: readonly string[] | null = [REPAIR]) {
  const opened: FakeStore[] = [];
  const opens: PersonSessionRequest[] = [];
  const ended: string[] = [];
  let online = true;
  let openFails: string | null = null;
  let pullFails: string | null = null;
  let serverReads: readonly string[] = [COSTS];
  let pinPending = false;
  let pinsSent = 0;
  let pinsStuck = false;
  let now = 0;
  let serverPin: string | null = null;
  let unpushedWork = false;
  let onSendPins: (() => Promise<unknown>) | null = null;
  const offline = (): SyncTransportError =>
    new SyncTransportError('offline', { code: null, status: null });
  const transport: PersonTransportPort = {
    open(request) {
      opens.push(request);
      if (!online) return Promise.reject(offline());
      if (serverPin !== null && request.pin !== serverPin) {
        return Promise.reject(
          new SyncTransportError('no', { code: 'AUTH_INVALID_CREDENTIALS', status: 401 }),
        );
      }
      if (openFails !== null) {
        return Promise.reject(new SyncTransportError('no', { code: openFails, status: 401 }));
      }
      return Promise.resolve({
        token: `bps_${opens.length}`,
        expiresAt: now + SESSION_TTL,
        readSet: serverReads.length === 0 ? [] : [COSTS],
      });
    },
    pull(): Promise<PullResponse> {
      return Promise.reject(new Error('the fake store pulls through its own port'));
    },
    end(token) {
      ended.push(token);
      return Promise.resolve();
    },
    async sendPendingPins() {
      pinsSent += 1;
      await onSendPins?.();
      if (!pinsStuck) pinPending = false;
    },
  };
  const deviceReads = new DeviceReads(registry, readSet);
  const access = createPersonAccess({
    db: {
      db: {},
      transaction: (fn: () => Promise<unknown>) => fn(),
      inTransaction: false,
    } as never,
    registry: { projections: {}, operations: registry } as never,
    invalidation: new InvalidationBus(),
    deviceReads,
    crypto: {} as never,
    clock: { now: () => now },
    knowsOp: () => true,
    pinPending: () => Promise.resolve(pinPending),
    unpushed: () => Promise.resolve(unpushedWork),
    openStore(reads) {
      const store: FakeStore = {
        reads: [...reads].sort(),
        tables: reads.length === 0 ? [] : ['part_costs'],
        closed: false,
        pulls: 0,
        async pull() {
          store.pulls += 1;
          if (!online) throw offline();
          if (pullFails !== null) {
            throw new SyncTransportError('no', { code: pullFails, status: 401 });
          }
          const same = [...serverReads].sort().join() === store.reads.join();
          return same ? { kind: 'current' } : { kind: 'reopen', reads: serverReads };
        },
        applyAppended: () => Promise.resolve(),
        refuse: () => Promise.resolve(),
        async close() {
          store.closed = true;
        },
      };
      opened.push(store);
      return Promise.resolve(store);
    },
  });
  access.bindTransport(transport);
  return {
    access,
    deviceReads,
    opened,
    opens,
    ended,
    goOffline: () => (online = false),
    goOnline: () => (online = true),
    failOpen: (code: string | null) => (openFails = code),
    failPull: (code: string | null) => (pullFails = code),
    serverGrants: (reads: readonly string[]) => (serverReads = reads),
    pinChangeQueued: (queued: boolean) => (pinPending = queued),
    pinsStuck: (stuck: boolean) => (pinsStuck = stuck),
    pinsSent: () => pinsSent,
    advance: (ms: number) => (now += ms),
    serverKnowsPin: (pin: string) => (serverPin = pin),
    workUnpushed: (value: boolean) => (unpushedWork = value),
    onSendPins: (fn: () => Promise<unknown>) => (onSendPins = fn),
  };
}

/** Grants as the device's directory holds them. */
const holding =
  (...reads: string[]) =>
  (read: string): boolean =>
    reads.includes(read);

const owner = { userId: 'owner-1', pin: '246810', mayRead: holding(COSTS, REPAIR) };

describe('a person who may read more than the device', () => {
  test('the server checks their PIN once, and their reads come down into a store', async () => {
    const h = harness();
    expect(h.access.heldReads()).toEqual([COSTS]);
    expect(h.access.readHere(COSTS)).toBe(false);

    await h.access.begin(owner);
    await h.access.sync();

    expect(h.opens).toEqual([{ userId: 'owner-1', pin: '246810' }]);
    expect(h.access.status()).toBe('open');
    expect(h.access.readHere(COSTS)).toBe(true);
    expect(h.access.readHere(REPAIR)).toBe(true);
    // A permission no synced data is read with is never "not here".
    expect(h.access.readHere('repair.intake')).toBe(true);

    const pulls = h.opened[0]?.pulls ?? 0;
    await h.access.sync();
    expect(h.opens).toHaveLength(1);
    expect(h.opened[0]?.pulls).toBe(pulls + 1);
  });

  test('offline at sign-in, the PIN waits in memory and goes once the connection is back', async () => {
    const h = harness();
    h.goOffline();
    await h.access.begin(owner);
    await h.access.sync();

    expect(h.access.status()).toBe('waiting');
    expect(h.access.readHere(COSTS)).toBe(false);

    h.goOnline();
    await h.access.sync();
    expect(h.access.status()).toBe('open');
    expect(h.access.readHere(COSTS)).toBe(true);
    // Checked once: after that only the session token is used.
    const sent = h.opens.length;
    await h.access.sync();
    expect(h.opens).toHaveLength(sent);
  });

  test('a PIN just changed here reaches the server before it is checked there', async () => {
    const h = harness();
    h.pinChangeQueued(true);
    await h.access.begin(owner);
    await h.access.sync();
    expect(h.pinsSent()).toBe(1);
    expect(h.opens).toEqual([{ userId: 'owner-1', pin: '246810' }]);
    expect(h.access.status()).toBe('open');
  });

  test('a PIN change that cannot be sent yet holds the check back, so it is not refused', async () => {
    const h = harness();
    h.pinChangeQueued(true);
    h.pinsStuck(true);
    await h.access.begin(owner);
    await h.access.sync();
    expect(h.opens).toEqual([]);
    expect(h.access.status()).toBe('waiting');

    h.pinsStuck(false);
    await h.access.sync();
    expect(h.access.status()).toBe('open');
  });

  test('a PIN the server does not accept is not sent again', async () => {
    const h = harness();
    h.failOpen('AUTH_INVALID_CREDENTIALS');
    await h.access.begin(owner);
    await h.access.sync();
    await h.access.sync();

    expect(h.access.status()).toBe('refused');
    expect(h.opens).toHaveLength(1);
    expect(h.access.readHere(COSTS)).toBe(false);
  });

  test('a session the server ended drops the store', async () => {
    const h = harness();
    await h.access.begin(owner);
    await h.access.sync();
    h.failPull('PERSON_SESSION_INVALID');
    await h.access.sync();

    expect(h.access.status()).toBe('ended');
    expect(h.opened[0]?.closed).toBe(true);
    expect(h.access.readHere(COSTS)).toBe(false);
  });

  test('a role edit that changes what they may read starts the store over', async () => {
    const h = harness();
    await h.access.begin(owner);
    await h.access.sync();
    h.serverGrants([]);
    await h.access.sync();

    expect(h.opened[0]?.closed).toBe(true);
    expect(h.opened[1]?.reads).toEqual([]);
    expect(h.access.readHere(COSTS)).toBe(false);
  });

  test('signing out drops the store and ends the session on the server', async () => {
    const h = harness();
    await h.access.begin(owner);
    await h.access.sync();
    await h.access.end();

    expect(h.access.status()).toBe('none');
    expect(h.access.userId()).toBeNull();
    expect(h.opened[0]?.closed).toBe(true);
    expect(h.ended).toEqual(['bps_1']);
    expect(h.access.readHere(COSTS)).toBe(false);
  });

  test('the next person starts from nothing: the last one’s store is gone first', async () => {
    const h = harness();
    await h.access.begin(owner);
    await h.access.sync();
    await h.access.begin({ userId: 'staff-1', pin: '135790', mayRead: holding(REPAIR) });

    expect(h.opened[0]?.closed).toBe(true);
    expect(h.access.status()).toBe('none');
    expect(h.access.readHere(COSTS)).toBe(false);
  });
});

describe('what a person may read is only "here" once it is all here', () => {
  test('a store that has not pulled to the end yet still says not here', async () => {
    const h = harness();
    h.goOffline();
    // The PIN check gets through, the first page does not.
    h.access.bindTransport({
      open: () => Promise.resolve({ token: 'bps_x', expiresAt: 0, readSet: [COSTS] }),
      pull: () => Promise.reject(new Error('unused')),
      end: () => Promise.resolve(),
      sendPendingPins: () => Promise.resolve(),
    });
    await h.access.begin(owner);
    await h.access.sync();
    expect(h.access.status()).toBe('open');
    expect(h.access.readHere(COSTS)).toBe(false);

    h.goOnline();
    await h.access.sync();
    expect(h.access.readHere(COSTS)).toBe(true);
  });

  test('the device gaining a read closes the store, which opens again with what is still extra', async () => {
    const h = harness();
    await h.access.begin({
      userId: 'owner-1',
      pin: '246810',
      mayRead: holding(COSTS, REPAIR, 'purchasing.read'),
    });
    h.serverGrants([COSTS, 'purchasing.read']);
    h.failOpen(null);
    await h.access.sync();
    await h.access.beforeDeviceGrows([COSTS]);
    expect(h.opened[0]?.closed).toBe(true);

    h.serverGrants(['purchasing.read']);
    await h.access.sync();
    expect(h.opened.at(-1)?.reads).toEqual(['purchasing.read']);
    expect(h.access.readHere('purchasing.read')).toBe(true);
  });
});

describe('a screen opened right after sign-in', () => {
  test('waits for the store coming down, rather than saying it needs internet', async () => {
    const h = harness();
    await h.access.begin(owner);
    // No sync awaited: the sign-in started one, and the screen asks while it runs.
    expect(h.access.readHere(COSTS)).toBe(false);
    await expect(h.access.whenHere(COSTS)).resolves.toBe(true);
  });

  test('offline, it says so at once', async () => {
    const h = harness();
    h.goOffline();
    await h.access.begin(owner);
    await h.access.sync();
    await expect(h.access.whenHere(COSTS)).resolves.toBe(false);
  });
});

describe('quick sign-ins', () => {
  test('a slower earlier sign-in never takes over from a later one', async () => {
    const h = harness();
    await h.access.begin(owner);
    await h.access.sync();
    const first = h.access.begin({ userId: 'owner-2', pin: '111111', mayRead: holding(COSTS) });
    const second = h.access.begin({ userId: 'owner-3', pin: '222222', mayRead: holding(COSTS) });
    await Promise.all([first, second]);
    expect(h.access.userId()).toBe('owner-3');
  });
});

describe('a person who may read no more than the device', () => {
  test('nothing is sent to the server and nothing is opened', async () => {
    const h = harness();
    await h.access.begin({ userId: 'staff-1', pin: '135790', mayRead: holding(REPAIR) });
    await h.access.sync();

    expect(h.opens).toEqual([]);
    expect(h.opened).toEqual([]);
    expect(h.access.status()).toBe('none');
  });
});

describe('what the device holds itself can change under a signed-in person', () => {
  test('on a new device the PIN waits for its first pull, and goes only if something is extra', async () => {
    const h = harness(null);
    await h.access.begin(owner);
    await h.access.sync();
    expect(h.opens).toEqual([]);
    expect(h.access.status()).toBe('waiting');

    h.deviceReads.set([REPAIR]);
    await h.access.sync();
    expect(h.opens).toEqual([{ userId: 'owner-1', pin: '246810' }]);
    expect(h.access.readHere(COSTS)).toBe(true);
  });

  test('on a new device that turns out to hold it all, the PIN never leaves', async () => {
    const h = harness(null);
    await h.access.begin(owner);
    h.deviceReads.set([REPAIR, COSTS]);
    await h.access.sync();
    expect(h.opens).toEqual([]);
    expect(h.access.status()).toBe('none');
  });

  test('a device that comes to hold less opens the extra without asking for the PIN again', async () => {
    const h = harness([REPAIR, COSTS]);
    await h.access.begin(owner);
    await h.access.sync();
    expect(h.opens).toEqual([]);
    expect(h.access.status()).toBe('none');

    // The owner just added the store's first staff person, who may not see costs.
    h.deviceReads.set([REPAIR]);
    await h.access.sync();
    expect(h.opens).toEqual([{ userId: 'owner-1', pin: '246810' }]);
    expect(h.access.status()).toBe('open');
    expect(h.access.readHere(COSTS)).toBe(true);
  });

  test('signing out forgets a PIN that never had to leave the device', async () => {
    const h = harness([REPAIR, COSTS]);
    await h.access.begin(owner);
    await h.access.sync();
    await h.access.end();
    h.deviceReads.set([REPAIR]);
    await h.access.sync();
    expect(h.opens).toEqual([]);
  });
});

describe('proving the signed-in person to the server on an online call', () => {
  const staff = { userId: 'staff-1', pin: '135790', mayRead: holding(REPAIR) };

  test('a person with nothing extra to read gets a session opened with the PIN in memory', async () => {
    const h = harness();
    h.serverGrants([]);
    await h.access.begin(staff);
    await h.access.sync();
    expect(h.opens).toEqual([]);

    expect(await h.access.sessionFor('staff-1')).toBe('bps_1');
    expect(h.opens).toEqual([{ userId: 'staff-1', pin: '135790' }]);
    // Kept while they stay: the next call sends the same session.
    expect(await h.access.sessionFor('staff-1')).toBe('bps_1');
    expect(h.opens).toHaveLength(1);
    expect(h.opened).toEqual([]);
  });

  test('a person whose reads are already open sends that session', async () => {
    const h = harness();
    await h.access.begin(owner);
    await h.access.sync();
    expect(await h.access.sessionFor('owner-1')).toBe('bps_1');
    expect(h.opens).toHaveLength(1);
  });

  test('nobody else is ever proven: another user, nobody signed in, or after sign-out', async () => {
    const h = harness();
    expect(await h.access.sessionFor('owner-1')).toBeNull();
    await h.access.begin(staff);
    await h.access.sync();
    expect(await h.access.sessionFor('owner-1')).toBeNull();
    expect(h.opens).toEqual([]);

    expect(await h.access.sessionFor('staff-1')).toBe('bps_1');
    await h.access.end();
    expect(h.ended).toEqual(['bps_1']);
    expect(await h.access.sessionFor('staff-1')).toBeNull();
  });

  test('offline or a PIN the server refuses gives no proof, and a later call tries again', async () => {
    const h = harness();
    h.serverGrants([]);
    await h.access.begin(staff);
    await h.access.sync();
    h.goOffline();
    expect(await h.access.sessionFor('staff-1')).toBeNull();
    h.goOnline();
    h.failOpen('AUTH_INVALID_CREDENTIALS');
    expect(await h.access.sessionFor('staff-1')).toBeNull();
    h.failOpen(null);
    expect(await h.access.sessionFor('staff-1')).toBe('bps_3');
  });

  test('a session the server no longer takes is opened again', async () => {
    const h = harness();
    h.serverGrants([]);
    await h.access.begin(staff);
    await h.access.sync();
    expect(await h.access.sessionFor('staff-1')).toBe('bps_1');
    h.advance(SESSION_TTL - 60_000);
    expect(await h.access.sessionFor('staff-1')).toBe('bps_2');
    expect(h.ended).toEqual(['bps_1']);
  });

  test('a PIN change sent while the reads open uses one session, not two', async () => {
    const h = harness();
    h.pinChangeQueued(true);
    const sendPins = h.access;
    await sendPins.begin(owner);
    // The pending PIN goes through the upload, which asks for the session first.
    h.onSendPins(() => sendPins.sessionFor('owner-1'));
    await h.access.sync();
    expect(h.opens).toHaveLength(1);
    expect(h.access.status()).toBe('open');
    expect(h.access.readHere(COSTS)).toBe(true);
  });

  test('after a PIN change here, a session opens with the new PIN once the server has it', async () => {
    const h = harness();
    h.serverGrants([]);
    h.serverKnowsPin('135790');
    await h.access.begin(staff);
    await h.access.sync();
    h.access.pinChanged('staff-1', '975310');
    // Before the change reaches the server, the old PIN still proves them (the change's own upload).
    expect(await h.access.sessionFor('staff-1')).toBe('bps_1');

    h.serverKnowsPin('975310');
    h.advance(SESSION_TTL);
    expect(await h.access.sessionFor('staff-1')).not.toBeNull();
    expect(h.opens.map((o) => o.pin)).toEqual(['135790', '135790', '975310']);
    // From then on only the new PIN is sent.
    h.advance(SESSION_TTL);
    await h.access.sessionFor('staff-1');
    expect(h.opens.at(-1)?.pin).toBe('975310');
    expect(h.opens).toHaveLength(4);
  });

  test('a PIN change for someone else, or nobody signed in, is ignored', async () => {
    const h = harness();
    h.access.pinChanged('staff-1', '975310');
    await h.access.begin(staff);
    h.access.pinChanged('owner-1', '000000');
    h.serverGrants([]);
    await h.access.sync();
    await h.access.sessionFor('staff-1');
    expect(h.opens.map((o) => o.pin)).toEqual(['135790']);
  });
});

describe('a lock right after a PIN change here', () => {
  test('the change still goes up, proven by the session of the person who left', async () => {
    const h = harness();
    await h.access.begin(owner);
    await h.access.sync();
    h.pinChangeQueued(true);
    const proofs: (string | null)[] = [];
    h.onSendPins(async () => {
      proofs.push(await h.access.sessionFor('owner-1'));
    });
    await h.access.end();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.pinsSent()).toBe(1);
    expect(proofs).toEqual(['bps_1']);
    // Ended once the change is up, and never handed out after.
    expect(h.ended).toEqual(['bps_1']);
    expect(await h.access.sessionFor('owner-1')).toBeNull();
  });

  test('with nothing pending, the session ends at once', async () => {
    const h = harness();
    await h.access.begin(owner);
    await h.access.sync();
    await h.access.end();
    expect(h.pinsSent()).toBe(0);
    expect(h.ended).toEqual(['bps_1']);
  });
});

describe('an owner’s or manager’s decisions on a shared device', () => {
  const manager = { userId: 'mgr-1', pin: '112233', mayRead: holding(REPAIR), mayDecide: true };

  test('someone who decides is proven at sign-in, even with nothing extra to read', async () => {
    const h = harness();
    h.serverGrants([]);
    await h.access.begin(manager);
    await h.access.sync();

    expect(h.opens).toEqual([{ userId: 'mgr-1', pin: '112233' }]);
    expect(h.access.canProve('mgr-1')).toBe(true);
    expect(h.access.canProve('owner-1')).toBe(false);
    expect(h.access.proofs(['mgr-1', 'cashier-1'])).toEqual(['bps_1']);
    // A push carries only its own authors' sessions.
    expect(h.access.proofs(['cashier-1'])).toEqual([]);
    expect(h.opened).toEqual([]);
  });

  test('someone who does not decide sends no PIN', async () => {
    const h = harness();
    h.serverGrants([]);
    await h.access.begin({ ...manager, mayDecide: false });
    await h.access.sync();
    expect(h.opens).toEqual([]);
    expect(h.access.canProve('mgr-1')).toBe(false);
  });

  test('a lock with a decision not yet pushed keeps the session for that push, then ends it', async () => {
    const h = harness();
    h.serverGrants([]);
    await h.access.begin(manager);
    await h.access.sync();
    h.workUnpushed(true);
    await h.access.end();

    expect(h.access.proofs(['mgr-1'])).toEqual(['bps_1']);
    expect(h.access.canProve('mgr-1')).toBe(true);
    expect(h.ended).toEqual([]);

    await h.access.pushed();
    expect(h.ended).toEqual([]);
    h.workUnpushed(false);
    await h.access.pushed();
    expect(h.ended).toEqual(['bps_1']);
    expect(h.access.proofs(['mgr-1'])).toEqual([]);
    expect(h.access.canProve('mgr-1')).toBe(false);
  });

  test('an expired session proves nobody, even with a store open', async () => {
    const h = harness();
    h.serverGrants([COSTS]);
    await h.access.begin({ ...manager, mayRead: holding(COSTS, REPAIR) });
    await h.access.sync();
    expect(h.access.canProve('mgr-1')).toBe(true);
    h.advance(SESSION_TTL - 60_000);
    expect(h.access.canProve('mgr-1')).toBe(false);
    expect(h.access.proofs(['mgr-1'])).toEqual([]);
    // The PIN left memory when the store opened, so the device refuses the decision itself
    // rather than send a token the server would refuse.
    expect(await h.access.sessionFor('mgr-1')).toBeNull();
  });

  test('a left session that expired is not sent', async () => {
    const h = harness();
    h.serverGrants([]);
    await h.access.begin(manager);
    await h.access.sync();
    h.workUnpushed(true);
    await h.access.end();
    h.advance(SESSION_TTL - 60_000);
    expect(h.access.canProve('mgr-1')).toBe(false);
    expect(h.access.proofs(['mgr-1'])).toEqual([]);
  });

  test('a left session is never kept past ten minutes, sent or not', async () => {
    const h = harness();
    h.serverGrants([]);
    await h.access.begin(manager);
    await h.access.sync();
    h.workUnpushed(true);
    await h.access.end();
    h.advance(10 * 60 * 1000 + 1);
    await h.access.pushed();
    expect(h.ended).toEqual(['bps_1']);
  });
});
