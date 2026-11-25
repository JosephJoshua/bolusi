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
import { sql } from 'kysely';
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
  /** Whether the person has changes here not yet pushed; reads the outbox unless a test passes one. */
  readonly unpushed?: (userId: string) => Promise<boolean>;
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
    /**
     * They hold an owner's or manager's decision and this device is shared: their session is opened
     * at sign-in even with nothing extra to read, so a cancel or refund is proven at once.
     */
    readonly mayDecide?: boolean;
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
  /**
   * A person session for `userId`, the signed-in person, which the server opened after checking their
   * PIN itself: what a shared device sends to act as them on an online call (server
   * auth/acting-user.ts). Opened on demand with the PIN kept in memory; null when someone else is
   * signed in, the PIN is gone, or the server could not be reached or refused it.
   */
  sessionFor(userId: string): Promise<string | null>;
  /** The signed-in person changed their own PIN here: sessions opened from now on can use it. */
  pinChanged(userId: string, newPin: string): void;
  /**
   * The live person sessions a push of these authors' changes carries: the signed-in person's and
   * those of people who just left with work still unsent. The server takes a decision from a shared
   * device only with its author's (server oplog/steps/decision.ts).
   */
  proofs(authors: readonly string[]): readonly string[];
  /** A sync cycle finished: sessions kept only for what has now been sent are ended. */
  pushed(): Promise<void>;
  /** Whether a session proves `userId` right now (signed in here, or just left with work unsent). */
  canProve(userId: string): boolean;
  status(): PersonAccessStatus;
  /** The signed-in person this access is for, or null. */
  userId(): string | null;
  subscribe(listener: () => void): () => void;
}

interface Person {
  readonly userId: string;
  readonly mayRead: (permissionId: string) => boolean;
  readonly mayDecide: boolean;
  /** Kept in memory until the server has checked it, or until they leave if it never needs to. */
  pin: string | null;
  /** A PIN they changed to here: the server takes it once the change reaches it. */
  nextPin: string | null;
  token: string | null;
  /** When the server stops taking `token` (its clock, so read with a margin). */
  tokenExpiresAt: number;
  /** A session being opened for an online call (`sessionFor`), which later calls wait for. */
  opening: Promise<string | null> | null;
  store: PersonStoreLike | null;
  /** The store pulled to the end at least once: its reads are here. */
  complete: boolean;
  /** Reads to open the store with again, after it closed for the device's own pull. */
  reopen: readonly string[] | null;
  status: PersonAccessStatus;
}

/** The longest a left person's session is kept for their unsent work (`leaving` below). */
const LEAVING_MAX_MS = 10 * 60 * 1000;

interface Leaving {
  readonly userId: string;
  readonly token: string;
  readonly since: number;
  readonly expiresAt: number;
}

/** Opened again this long before the server's expiry, so a device clock a little behind still works. */
const SESSION_EXPIRY_MARGIN_MS = 5 * 60 * 1000;

export function createPersonAccess(deps: PersonAccessDeps): PersonAccess {
  /** Whether a session expiring then still works now, with the margin for a clock behind. */
  const live = (expiresAt: number): boolean =>
    expiresAt - SESSION_EXPIRY_MARGIN_MS > deps.clock.now();
  let transport: PersonTransportPort | null = null;
  let person: Person | null = null;
  /**
   * Sessions of people who just left, kept only until what they did here reaches the server with
   * them: a decision still waiting to be pushed (the server takes it only with their session, server
   * oplog/steps/decision.ts) and a PIN change still waiting to be sent (the next sign-in, with the
   * new PIN, cannot prove it while the server still knows the old one). A lock right after a cancel
   * or a PIN change must not strand either. Never past LEAVING_MAX_MS.
   */
  const leaving: Leaving[] = [];
  const finishLeaving = (entry: Leaving): void => {
    const at = leaving.indexOf(entry);
    if (at === -1) return;
    leaving.splice(at, 1);
    void transport?.end(entry.token).catch(() => undefined);
  };
  const settleLeaving = async (): Promise<void> => {
    for (const entry of [...leaving]) {
      const overdue = deps.clock.now() - entry.since > LEAVING_MAX_MS;
      const waiting =
        !overdue &&
        ((await unpushed(entry.userId).catch(() => false)) ||
          (await pinPending(entry.userId).catch(() => false)));
      if (!waiting) finishLeaving(entry);
    }
  };
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
  const unpushed =
    deps.unpushed ??
    (async (userId: string) => {
      const rows = await sql`
        SELECT 1 FROM operations WHERE sync_status = 'local' AND user_id = ${userId} LIMIT 1
      `.execute(deps.db.db);
      return rows.rows.length > 0;
    });

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

  /**
   * Open a session with the PIN in memory. After a PIN change here the server knows the old one
   * until the change reaches it, and the new one from then on: the old is tried first, then the new.
   */
  const openSession = async (
    target: Person,
    port: PersonTransportPort,
    pin: string,
  ): ReturnType<PersonTransportPort['open']> => {
    try {
      return await port.open({ userId: target.userId, pin });
    } catch (error) {
      const next = target.nextPin;
      if (
        next === null ||
        !(error instanceof SyncTransportError) ||
        error.code !== 'AUTH_INVALID_CREDENTIALS'
      ) {
        throw error;
      }
      const opened = await port.open({ userId: target.userId, pin: next });
      if (target.pin !== null) target.pin = next;
      target.nextPin = null;
      return opened;
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
      // Sending it may itself have opened the session (`sessionFor` proves the upload).
      if (person !== target || target.pin === null || target.token !== null) return;
      const opened = await openSession(target, port, target.pin);
      target.pin = null;
      target.nextPin = null;
      if (person !== target || target.token !== null) {
        void port.end(opened.token).catch(() => undefined);
        return;
      }
      target.token = opened.token;
      target.tokenExpiresAt = opened.expiresAt;
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
        // Nothing beyond the device: the PIN does not leave it. It stays in memory while they are
        // signed in, so if the device comes to hold less (the store's first staff person was just
        // added) their extra opens without asking for it again.
        setStatus(target, 'none');
        // Someone who decides here is proven now, while the connection is up.
        if (target.mayDecide) await access.sessionFor(target.userId);
        return;
      }
      if (target.pin === null) {
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

    async begin({ userId, pin, mayRead, mayDecide = false }) {
      const mine = (generation += 1);
      await access.end();
      if (mine !== generation) return;
      person = {
        userId,
        mayRead,
        mayDecide,
        pin,
        nextPin: null,
        token: null,
        tokenExpiresAt: 0,
        opening: null,
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
      const token = target.token;
      target.token = null;
      await drop(target);
      notify();
      const port = transport;
      if (token === null || port === null) return;
      const entry: Leaving = {
        userId: target.userId,
        token,
        since: deps.clock.now(),
        expiresAt: target.tokenExpiresAt,
      };
      leaving.push(entry);
      if (await pinPending(target.userId).catch(() => false)) {
        // Sent now, proven by this session; the queue keeps it if the send fails.
        await port.sendPendingPins().catch(() => undefined);
      }
      await settleLeaving();
    },

    proofs(authors) {
      const wanted = new Set(authors);
      const tokens = new Set<string>();
      for (const entry of leaving) {
        if (wanted.has(entry.userId) && live(entry.expiresAt)) tokens.add(entry.token);
      }
      if (person?.token != null && wanted.has(person.userId) && live(person.tokenExpiresAt)) {
        tokens.add(person.token);
      }
      return [...tokens];
    },

    async pushed() {
      await settleLeaving();
    },

    canProve(userId) {
      if (leaving.some((entry) => entry.userId === userId && live(entry.expiresAt))) return true;
      return (
        person !== null &&
        person.userId === userId &&
        person.token !== null &&
        live(person.tokenExpiresAt)
      );
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

    async sessionFor(userId) {
      const target = person;
      const port = transport;
      const left = leaving.find((entry) => entry.userId === userId && live(entry.expiresAt));
      if (left !== undefined && (target === null || target.token === null)) return left.token;
      if (target === null || target.userId !== userId || port === null) return null;
      if (target.token !== null) {
        // An expired token proves nobody: it is opened again while the PIN is still in memory. A
        // store's pull reads the token each time, so it carries on with the new one.
        if (live(target.tokenExpiresAt)) return target.token;
        void port.end(target.token).catch(() => undefined);
        target.token = null;
      }
      if (target.pin === null) return null;
      // One open at a time: a decision made right after sign-in waits for the one under way.
      if (target.opening !== null) return target.opening;
      const pin = target.pin;
      const opening = (async () => {
        try {
          // The sign-in PIN in memory is the one the server knows until a change made here
          // reaches it, and that upload is itself proven by this session, so it opens first.
          return await openSession(target, port, pin);
        } catch {
          return null;
        }
      })();
      target.opening = opening.then((result) => result?.token ?? null);
      const opened = await opening;
      target.opening = null;
      if (opened === null) return null;
      if (person !== target || target.token !== null) {
        void port.end(opened.token).catch(() => undefined);
        return person === target ? target.token : null;
      }
      // The PIN stays in memory, as when nothing extra was asked for, so an extra that appears
      // later still opens; the token now proves them.
      target.token = opened.token;
      target.tokenExpiresAt = opened.expiresAt;
      if (opened.readSet.length > 0 && target.store === null) {
        target.reopen = opened.readSet;
        setStatus(target, 'open');
        void access.sync();
      }
      return opened.token;
    },

    pinChanged(userId, newPin) {
      if (person === null || person.userId !== userId) return;
      if (person.pin === null) {
        // Already checked: the next check is a sign-in, with whatever PIN they type.
        return;
      }
      person.nextPin = newPin;
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
