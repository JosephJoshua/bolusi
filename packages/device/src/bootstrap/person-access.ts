// What a signed-in person may read here beyond the device (least-privilege sync, owner decisions
// 2026-10-31 and 2026-11-01). A device holds on disk only what its people may read; when someone
// signs in who may read more, such as an owner on the store's counter PC, the server checks their
// PIN, and their extra is pulled into an in-memory store for as long as they stay signed in
// (core `PersonStore`). The rule is the same for every person and every role: the extra is what the
// person may read minus what the device holds, and for most people it is empty, so nothing happens.
//
// Offline at sign-in, the extra cannot come down. The PIN is kept in memory until the server has
// checked it, and the next sync (connectivity back, a poke, the periodic cycle) tries again; reads
// of the extra say "Perlu internet" meanwhile (`NOT_ON_DEVICE`). Once checked, only the session
// token is kept, and it ends with the person: sign-out, switching person, idle lock or app close.
import {
  AppUpdateRequiredError,
  dropPersonStoreTables,
  hasPendingVerifier,
  PersonStore,
  SyncTransportError,
  type ClockPort,
  type CryptoPort,
  type DeviceReads,
  type InvalidationBus,
  type ModuleRegistry,
} from '@bolusi/core';
import type { ClientDb } from '@bolusi/db-client';
import type { SignedOperation } from '@bolusi/schemas';

import { consoleDiagnostics } from '../ports/diagnostics.js';
import type { PersonTransportPort } from './transport.js';

/**
 * Where a person's extra stands. `none`: nobody signed in, or nothing beyond the device. `waiting`:
 * not checked by the server yet (offline, or a check in flight). `open`: pulled, or pulling.
 * `refused`: the server did not accept the PIN (changed on another device); signing in again fixes
 * it. `ended`: the server ended the session (expired, or the person left the store).
 */
export type PersonAccessStatus = 'none' | 'waiting' | 'open' | 'refused' | 'ended';

export interface PersonAccessDeps {
  readonly db: ClientDb;
  readonly registry: Pick<ModuleRegistry<never>, 'projections' | 'operations'>;
  readonly invalidation: InvalidationBus;
  readonly deviceReads: DeviceReads;
  readonly crypto: CryptoPort;
  readonly clock: ClockPort;
  readonly knowsOp: (op: Pick<SignedOperation, 'type' | 'schemaVersion'>) => boolean;
  /** Whether a PIN change for the person made here has not reached the server yet. */
  readonly pinPending?: (userId: string) => Promise<boolean>;
  /** Opens the store; core's `PersonStore.open` unless a test passes another. */
  readonly openStore?: (reads: readonly string[]) => Promise<PersonStoreLike>;
}

/** The parts of core's `PersonStore` this controller drives. */
export type PersonStoreLike = Pick<
  PersonStore<never>,
  'reads' | 'tables' | 'pull' | 'applyAppended' | 'refuse' | 'close'
>;

export interface PersonAccess {
  /** The person legs, bound once the sync client exists (it knows the server and device token). */
  bindTransport(port: PersonTransportPort | null): void;
  /** The reads some op type is read with that the device does not hold. */
  heldReads(): readonly string[];
  /**
   * A person signed in with `pin`; `mayRead` says which reads their grants on this device hold.
   * Their extra is what they may read of `heldReads()`, worked out once the device knows its own
   * read set (a new device has not pulled yet). Empty, nothing goes to the server.
   */
  begin(person: {
    readonly userId: string;
    readonly pin: string;
    readonly mayRead: (permissionId: string) => boolean;
  }): Promise<void>;
  /** The person left: drop their store and end their session (best effort). */
  end(): Promise<void>;
  /** Check the PIN if still waiting, then pull the person's store until current. */
  sync(): Promise<void>;
  /**
   * Whether a read's data is here: the device's own, or the signed-in person's store once it has
   * pulled to the end (before that a list would look complete while it is not).
   */
  readHere(permissionId: string): boolean;
  /**
   * `readHere`, after waiting for a pull of the person's store that is under way: a screen opened
   * just after sign-in waits for it rather than saying "Perlu internet" while online.
   */
  whenHere(permissionId: string): Promise<boolean>;
  /**
   * The device is about to hold `added` itself (inside its pull's transaction): a store holding any
   * of them closes first, so the device's folds reach its own tables, and opens again after.
   */
  beforeDeviceGrows(added: readonly string[]): Promise<void>;
  /** Fold one of this device's own new changes into the person's store (inside the append). */
  applyAppended(op: SignedOperation): Promise<void>;
  /** A change the server refused: take it back out of the person's store too. */
  refuse(op: Pick<SignedOperation, 'id' | 'type' | 'entityType' | 'entityId'>): Promise<void>;
  status(): PersonAccessStatus;
  /** The signed-in person this access is for, or null. */
  userId(): string | null;
  subscribe(listener: () => void): () => void;
}

interface Person {
  readonly userId: string;
  readonly mayRead: (permissionId: string) => boolean;
  /** Kept only until the server has checked it. */
  pin: string | null;
  token: string | null;
  store: PersonStoreLike | null;
  /** The store pulled to the end at least once: its reads are here. */
  complete: boolean;
  /** Reads to open the store with again, after it closed for the device's own pull. */
  reopen: readonly string[] | null;
  status: PersonAccessStatus;
}

export function createPersonAccess(deps: PersonAccessDeps): PersonAccess {
  let transport: PersonTransportPort | null = null;
  let person: Person | null = null;
  let running: Promise<void> | null = null;
  let again = false;
  /** Bumped by every sign-in, so a slower earlier one never overwrites a later one. */
  let generation = 0;
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of listeners) listener();
  };
  const setStatus = (target: Person, status: PersonAccessStatus): void => {
    if (target.status === status) return;
    target.status = status;
    if (person === target) notify();
  };

  const pinPending =
    deps.pinPending ?? ((userId: string) => hasPendingVerifier(deps.db.db, userId));

  const storeDeps = {
    db: deps.db.db as never,
    transaction: <T>(fn: () => Promise<T>) => deps.db.transaction(() => fn()),
    crypto: deps.crypto,
    clock: deps.clock,
    projections: deps.registry.projections,
    operations: deps.registry.operations,
    invalidation: deps.invalidation,
    knowsOp: deps.knowsOp,
    deviceHolds: (read: string) => deps.deviceReads.holdsRead(read),
  };

  /** Open a store for `reads`, unless the person left meanwhile, in which case it is dropped. */
  const openStore = async (target: Person, reads: readonly string[]): Promise<void> => {
    const store = await (
      deps.openStore ?? ((wanted) => PersonStore.open<never>(storeDeps, wanted))
    )(reads);
    if (person !== target) {
      await store.close();
      return;
    }
    target.store = store;
    target.complete = false;
  };

  const drop = async (target: Person): Promise<void> => {
    const { store, token } = target;
    target.store = null;
    target.complete = false;
    target.reopen = null;
    target.token = null;
    target.pin = null;
    await store?.close();
    if (token !== null && transport !== null) {
      void transport.end(token).catch(() => undefined);
    }
  };

  const once = async (target: Person, port: PersonTransportPort): Promise<void> => {
    if (target.token === null) {
      if (target.pin === null) return;
      // A PIN just changed here must reach the server before the server can check it.
      if (await pinPending(target.userId)) {
        await port.sendPendingPins();
        if (await pinPending(target.userId)) return;
      }
      if (person !== target || target.pin === null) return;
      const opened = await port.open({ userId: target.userId, pin: target.pin });
      target.pin = null;
      if (person !== target) {
        void port.end(opened.token).catch(() => undefined);
        return;
      }
      target.token = opened.token;
      await openStore(target, opened.readSet);
      setStatus(target, 'open');
    }
    if (target.store === null && target.reopen !== null) {
      const reads = target.reopen;
      target.reopen = null;
      await openStore(target, reads);
    }
    for (;;) {
      const store = target.store;
      const token = target.token;
      if (store === null || token === null || person !== target) return;
      const outcome = await store.pull({ pull: (request) => port.pull(token, request) });
      if (target.store !== store) return;
      if (outcome.kind === 'current') {
        if (!target.complete) {
          target.complete = true;
          // Screens that said "Perlu internet" read the store now.
          if (store.tables.length > 0) deps.invalidation.emit(new Set(store.tables));
          notify();
        }
        return;
      }
      // What the person may read here changed (a role edit): start the store over.
      target.store = null;
      await store.close();
      if (person !== target) return;
      await openStore(target, outcome.reads);
    }
  };

  const run = async (): Promise<void> => {
    const target = person;
    const port = transport;
    if (
      target === null ||
      port === null ||
      target.status === 'refused' ||
      target.status === 'ended' ||
      // A new device: what it holds itself comes with its first pull, which syncs this again.
      !deps.deviceReads.known()
    )
      return;
    if (target.token === null) {
      const extra = deps.deviceReads.heldReads().filter(target.mayRead);
      if (extra.length === 0) {
        // Nothing beyond the device: the PIN never leaves it.
        target.pin = null;
        setStatus(target, 'none');
        return;
      }
      if (target.pin === null) {
        // Signed in when nothing was beyond the device, and now something is (the store's staff
        // changed, or the device's first pull came after): their PIN again opens it.
        setStatus(target, 'ended');
        return;
      }
    }
    try {
      await once(target, port);
    } catch (error) {
      // A fetch that never reached the server rejects with a TypeError: offline, tried again.
      if (error instanceof TypeError) return;
      if (!(error instanceof SyncTransportError) && !(error instanceof AppUpdateRequiredError)) {
        consoleDiagnostics.warn('person sync failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      if (error instanceof SyncTransportError && error.code === 'AUTH_INVALID_CREDENTIALS') {
        // The server's verifier differs from this device's (the PIN changed elsewhere and has
        // not come down yet). Not retried with the same PIN: signing in again does it.
        target.pin = null;
        setStatus(target, 'refused');
      } else if (error instanceof SyncTransportError && error.code === 'PERSON_SESSION_INVALID') {
        await drop(target);
        setStatus(target, 'ended');
      }
      // Anything else (offline, a timeout, a rate limit, a newer app): tried again next sync.
    }
  };

  const access: PersonAccess = {
    bindTransport(port) {
      transport = port;
    },

    heldReads: () => deps.deviceReads.heldReads(),

    async begin({ userId, pin, mayRead }) {
      const mine = (generation += 1);
      await access.end();
      if (mine !== generation) return;
      person = {
        userId,
        mayRead,
        pin,
        token: null,
        store: null,
        complete: false,
        reopen: null,
        status: 'waiting',
      };
      notify();
      void access.sync();
    },

    async end() {
      const target = person;
      if (target === null) return;
      person = null;
      await drop(target);
      notify();
    },

    sync() {
      if (running !== null) {
        again = true;
        return running;
      }
      // Cleared in the same turn the loop ends: a sync asked for after that starts a new run.
      running = (async () => {
        try {
          do {
            again = false;
            await run();
          } while (again);
        } finally {
          running = null;
        }
      })();
      return running;
    },

    readHere(permissionId) {
      if (deps.deviceReads.holdsRead(permissionId)) return true;
      const store = person?.complete === true ? person.store : null;
      return store?.reads.includes(permissionId) ?? false;
    },

    async whenHere(permissionId) {
      // A sync pulls to the end or fails (offline), so at most two rounds: the one running when
      // asked, and the one it started again for a request that came in meanwhile. Never from
      // inside a transaction, which the pull would wait behind.
      for (let round = 0; round < 2 && !access.readHere(permissionId); round += 1) {
        const pending = running;
        if (pending === null || person === null || deps.db.inTransaction) break;
        await pending;
      }
      return access.readHere(permissionId);
    },

    async beforeDeviceGrows(added) {
      const target = person;
      const store = target?.store ?? null;
      const touched = store?.reads.some((read) => added.includes(read)) ?? false;
      // No store, or one still opening: tables left by a batch that rolled back may still shadow
      // the device's (an opening one leaves the device's reads out itself, `deviceHolds`).
      if (store === null) {
        await dropPersonStoreTables(deps.db.db);
        if (target !== null && target.reopen !== null) {
          target.reopen = target.reopen.filter((read) => !added.includes(read));
        }
        return;
      }
      if (target === null || !touched) return;
      target.store = null;
      target.complete = false;
      target.reopen = store.reads.filter((read) => !added.includes(read));
      await store.close({ withinTransaction: true });
      notify();
      // After the device's transaction: the store opens again with what is still extra.
      setTimeout(() => void access.sync(), 0);
    },

    async applyAppended(op) {
      await person?.store?.applyAppended(op);
    },

    async refuse(op) {
      await person?.store?.refuse(op);
    },

    status: () => person?.status ?? 'none',
    userId: () => person?.userId ?? null,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return access;
}
