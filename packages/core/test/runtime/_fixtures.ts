// Command-runtime fixtures (testing-guide T-6 determinism, T-7 fakes only at I/O boundaries).
//
// EVERYTHING REAL EXCEPT THE I/O. The evaluator is the REAL `PermissionEvaluator` over the REAL
// registry assembled from the REAL v0 manifests (test/authz/_fixtures.ts — one fixture set, not a
// second copy); crypto is real noble; the append path, chaining, signing and JCS are real. Faked:
// the clock (FakeClock), the id source (seeded PRNG), the store (in-memory, modelling the
// operations table's write invariants), the location port, the query executor, and the sync
// scheduler. That is exactly T-7's line — a mocked evaluator would make every permission
// assertion in this suite a test of the mock.
//
// WHY THE IDENTITIES ARE UUIDs AND THE AUTHZ FIXTURE'S ARE NOT. `zSignedCore` types `tenantId`,
// `userId`, `deviceId` and `storeId` as UUIDs (05 §2.1), so an op signed for `user-staff` would
// fail parse at completion. The authz suite never builds an op, so its readable ids are fine
// there. Here the ROLES and the REGISTRY are reused verbatim from that fixture; only the
// principals are re-minted as UUIDs.
import {
  createUuidV7Generator,
  DomainError,
  PermissionEvaluator,
  assemblePermissionRegistry,
  type ClockPort,
  type CommandRuntimeOptions,
  type CryptoPort,
  type DirectoryGrant,
  type DirectoryRole,
  type DirectorySnapshot,
  type DirectorySource,
  type IdSource,
  type LocationPort,
  type OpAppendStore,
  type OperationRegistry,
  type OpAppendTx,
  type OpDraftInput,
  type PermissionQuery,
  type PermissionRegistry,
  type PermissionResult,
  type QueryExecutorPort,
  type QueryHandle,
  type SigningKeyPort,
  type SyncSchedulerPort,
} from '../../src/index.js';
import { CommandRuntime, type CommandDefinition } from '../../src/index.js';
// Internal path on purpose: the brand symbol is deliberately NOT on the package surface
// (runtime/index.ts), and `ctx-brand.test.ts` asserts that absence.
import { CTX_RUNTIME_BRAND } from '../../src/runtime/ctx.js';
import type { Location, SignedOperation } from '@bolusi/schemas';
import { mulberry32, noblePort, randomBytes as prngBytes, type Prng } from '@bolusi/test-support';

import {
  MAIN_OWNER_IDS,
  ROLE_MAIN_OWNER,
  ROLE_STAFF,
  STAFF_IDS,
  V0_MODULES,
  role,
} from '../authz/_fixtures.js';
import { InMemoryOpStore, makeFakeClock, type FakeClock } from '../oplog/_fixtures.js';

export { InMemoryOpStore, makeFakeClock, type FakeClock };

/**
 * The 04 §3 operation registry for the op types these fixtures emit.
 *
 * `ctx.op()` resolves an op's `schemaVersion` from here (task 11 removed the `?? 1` default task 10
 * had left as a stopgap), so a runtime cannot mint a draft for a type nothing declares. Kept as an
 * explicit port rather than a `registerModules` call: this is task 10's suite, and the real
 * registry's own behaviour is pinned by the module suite (test/module/). The versions match the
 * `notes` fixture manifest (test/projection/notes-fixture.ts).
 */
const FIXTURE_OP_SCHEMA_VERSIONS = new Map<string, number>([
  ['notes.note_created', 1],
  ['notes.note_body_edited', 1],
  ['notes.note_archived', 1],
]);

export const fixtureOperations: OperationRegistry = {
  schemaVersionFor: (type) => FIXTURE_OP_SCHEMA_VERSIONS.get(type),
  // Every fixture op is store-scoped (01 §6's default) and declares no conflict — this fixture
  // exercises the RUNTIME's sequence, not the conflict rules. Keyed off the same map as the
  // version so an undeclared type answers `undefined` from both, which is what the runtime's
  // fail-closed path reads.
  scopeFor: (type) => (FIXTURE_OP_SCHEMA_VERSIONS.has(type) ? 'store' : undefined),
  conflictFor: () => undefined,
  types: () => [...FIXTURE_OP_SCHEMA_VERSIONS.keys()].sort(),
  get size() {
    return FIXTURE_OP_SCHEMA_VERSIONS.size;
  },
};

/** Records the ORDER of the runtime's observable steps — the sequence assertions read this. */
export class EventLog {
  readonly events: string[] = [];

  record(event: string): void {
    this.events.push(event);
  }

  /** Index of the first occurrence, or -1. */
  indexOf(event: string): number {
    return this.events.indexOf(event);
  }

  count(event: string): number {
    return this.events.filter((e) => e === event).length;
  }

  clear(): void {
    this.events.length = 0;
  }
}

/**
 * The REAL evaluator, wrapped so the suite can see WHEN it was consulted.
 *
 * It is a spy on the boundary, not a replacement: `hasPermission` delegates to the real
 * `PermissionEvaluator` and returns its verdict untouched. That is what makes "the check ran
 * before the handler" an assertion about the real control rather than about a stub.
 */
export class ObservedEvaluator extends PermissionEvaluator {
  readonly checks: { userId: string; permissionId: string }[] = [];
  readonly #log: EventLog;

  constructor(registry: PermissionRegistry, source: DirectorySource, log: EventLog) {
    super(registry, source);
    this.#log = log;
  }

  override hasPermission(query: PermissionQuery): PermissionResult {
    this.checks.push({ userId: query.userId, permissionId: query.permissionId });
    this.#log.record('permission-check');
    return super.hasPermission(query);
  }
}

/** A location port whose calls are counted — "never retried or polled" is an assertion, not a hope. */
export class CountingLocationPort implements LocationPort {
  calls = 0;
  constructor(private fix: Location | null) {}

  getBestFix(): Location | null {
    this.calls += 1;
    return this.fix;
  }

  set(fix: Location | null): void {
    this.fix = fix;
  }
}

export class RecordingScheduler implements SyncSchedulerPort {
  calls = 0;
  constructor(private readonly log?: EventLog) {}

  schedule(): void {
    this.calls += 1;
    this.log?.record('schedule-sync');
  }
}

/** The query seam. Task 11 lands the real executor; this records the routing (04 §5.2). */
export class RecordingQueryExecutor implements QueryExecutorPort {
  readonly calls: { permission: string; input: unknown; identity: unknown }[] = [];
  #results = new Map<string, unknown>();

  stub(permission: string, result: unknown): void {
    this.#results.set(permission, result);
  }

  execute<TInput, TOutput>(
    query: QueryHandle<TInput, TOutput>,
    input: TInput,
    identity: unknown,
  ): Promise<TOutput> {
    this.calls.push({ permission: query.permission, input, identity });
    return Promise.resolve(this.#results.get(query.permission) as TOutput);
  }
}

/**
 * Wraps a store so `insertOp` can be made to fail — the "append itself fails after the handler
 * ran" leg of the atomicity contract (04 §5.1).
 *
 * A wrapper rather than a stub: the REAL `InMemoryOpStore` still runs the transaction and the
 * rollback, so the test measures the append path's atomicity, not a fake's.
 */
export class FaultInjectingStore implements OpAppendStore {
  constructor(
    private readonly inner: OpAppendStore,
    private readonly fault: () => Error | null,
  ) {}

  transaction<T>(fn: (tx: OpAppendTx) => Promise<T>): Promise<T> {
    return this.inner.transaction((tx) =>
      fn({
        readChainHead: (deviceId) => tx.readChainHead(deviceId),
        hasOp: (id) => tx.hasOp(id),
        insertOp: (row) => {
          const error = this.fault();
          return error === null ? tx.insertOp(row) : Promise.reject(error);
        },
      }),
    );
  }
}

export const TEST_LOCATION: Location = { lat: -2.533, lng: 140.717, accuracyMeters: 12.5 };

export interface RuntimeFixture {
  readonly runtime: CommandRuntime;
  readonly clock: FakeClock;
  readonly prng: Prng;
  readonly newId: IdSource;
  readonly crypto: CryptoPort;
  readonly store: InMemoryOpStore;
  readonly evaluator: ObservedEvaluator;
  readonly location: CountingLocationPort;
  readonly scheduler: RecordingScheduler;
  readonly queries: RecordingQueryExecutor;
  readonly log: EventLog;
  /** Ops handed to the projection seam, in apply order. */
  readonly projected: SignedOperation[];
  readonly tenantId: string;
  readonly storeId: string;
  /** Holds every v0 permission (main_owner, tenant-wide grant). */
  readonly ownerId: string;
  /** Holds the §12 `staff` set: notes.*, auth.pin_change, platform.set_locale. */
  readonly staffId: string;
  /** Exists and is active, holds nothing (the literal 04 §8 case). */
  readonly zeroGrantId: string;
  readonly deviceId: string;
  /** Re-load the directory into the evaluator (the §6 bootstrap `prime`). */
  prime(): Promise<void>;
  /** Repeats currently suppressed for `(user, permission, target)` — task 09's throttle counter. */
  denialSuppressed(target: string, permissionId: string, userId?: string): number;
  /**
   * This runtime's brand object, for driving `isOwnContext` directly.
   *
   * READ OFF A GENUINELY-MINTED CTX rather than exposed by the runtime: the brand is a `#private`
   * field and must stay that way — an accessor would hand out the one thing that makes a forged
   * ctx impossible. Deriving it from a real ctx is also honest about the threat model, since it is
   * exactly what an attacker who already holds a real ctx could do (and it still gains them
   * nothing: they cannot mint that object themselves).
   */
  readonly runtimeBrand: object;
  /** Append the device's genesis op so later commands are not the chain's first (05 §9.5). */
  enroll(): Promise<void>;
  setSnapshot(next: DirectorySnapshot): void;
}

export interface FixtureOptions {
  readonly startMs?: number;
  readonly location?: Location | null;
  /** Override the §7 denial-throttle window. */
  readonly denialThrottleWindowMs?: number;
  /** Replace the projection seam (e.g. to make it throw — the atomicity suite). */
  readonly applyProjection?: CommandRuntimeOptions['applyProjection'];
  /** Return an Error to fail the next `insertOp`, or null to let it through. */
  readonly insertFault?: () => Error | null;
  /**
   * Replace the 04 §3 operation registry (default: `fixtureOperations`, the `notes.*` types).
   *
   * Exists so a suite can drive the runtime against a REAL module's registry —
   * `registerModules([platformModule]).operations` — rather than this file's hand-built map. That
   * matters for anything the registry ANSWERS rather than merely gates: `ctx.op()` resolves both
   * `schemaVersion` AND the 01 §6 envelope scope from it, so a test of tenant-scoping must read
   * the real declaration or it is testing this fixture's opinion of it (T-13: interrogate the
   * oracle). Additive — every existing caller keeps `fixtureOperations`.
   */
  readonly operations?: OperationRegistry;
}

/** Build a fully-seeded runtime. Two calls with the same seed reproduce bit-for-bit (T-6). */
export function makeRuntimeFixture(seed: number, options: FixtureOptions = {}): RuntimeFixture {
  const startMs = options.startMs ?? 1_726_000_000_000;
  const prng = mulberry32(seed);
  const crypto = noblePort;
  const clock = makeFakeClock(startMs);
  const log = new EventLog();

  // Stable identity ids, minted before the clock moves.
  const identityGen = createUuidV7Generator({
    now: () => startMs,
    randomBytes: (n) => prngBytes(prng, n),
  });
  const tenantId = identityGen();
  const storeId = identityGen();
  const ownerId = identityGen();
  const staffId = identityGen();
  const zeroGrantId = identityGen();
  const deviceId = identityGen();

  const keypair = crypto.ed25519Keygen(prngBytes(prng, 32));
  const newId: IdSource = createUuidV7Generator({
    now: () => clock.now(),
    randomBytes: (n) => prngBytes(prng, n),
  });

  // The v0 directory (02 §10/§12 shapes, from the authz fixture) over UUID principals.
  let snapshot: DirectorySnapshot = {
    tenantId,
    users: new Map<string, { status: string }>([
      [ownerId, { status: 'active' }],
      [staffId, { status: 'active' }],
      [zeroGrantId, { status: 'active' }],
    ]),
    roles: new Map<string, DirectoryRole>([
      [ROLE_MAIN_OWNER, role('tenant', MAIN_OWNER_IDS)],
      [ROLE_STAFF, role('store', STAFF_IDS)],
    ]),
    grantsByUser: new Map<string, readonly DirectoryGrant[]>([
      [ownerId, [{ roleId: ROLE_MAIN_OWNER, storeId: null }]],
      [staffId, [{ roleId: ROLE_STAFF, storeId }]],
      [zeroGrantId, []],
    ]),
  };

  const source: DirectorySource = { load: () => Promise.resolve(snapshot) };
  const registry = assemblePermissionRegistry(V0_MODULES);
  const evaluator = new ObservedEvaluator(registry, source, log);

  const store = new InMemoryOpStore();
  // The runtime writes through the (optionally faulty) wrapper; assertions read the real store.
  const appendStore: OpAppendStore =
    options.insertFault === undefined ? store : new FaultInjectingStore(store, options.insertFault);
  const location = new CountingLocationPort(
    options.location === undefined ? TEST_LOCATION : options.location,
  );
  const scheduler = new RecordingScheduler(log);
  const queries = new RecordingQueryExecutor();
  const projected: SignedOperation[] = [];

  const clockPort: ClockPort = { now: () => clock.now() };
  const signingKey: SigningKeyPort = { getSigningKey: () => keypair.secretKey };

  const runtime = new CommandRuntime({
    device: { tenantId, storeId, deviceId },
    evaluator,
    operations: options.operations ?? fixtureOperations,
    store: appendStore,
    crypto,
    clock: clockPort,
    idSource: newId,
    location,
    signingKey,
    queryExecutor: queries,
    applyProjection:
      options.applyProjection ??
      ((op) => {
        log.record('project');
        projected.push(op);
      }),
    syncScheduler: scheduler,
    ...(options.denialThrottleWindowMs !== undefined
      ? { denialThrottleWindowMs: options.denialThrottleWindowMs }
      : {}),
  });

  return {
    runtime,
    clock,
    prng,
    newId,
    crypto,
    store,
    evaluator,
    location,
    scheduler,
    queries,
    log,
    projected,
    tenantId,
    storeId,
    ownerId,
    staffId,
    zeroGrantId,
    deviceId,
    prime: () => evaluator.prime(),
    denialSuppressed: (target, permissionId, userId = staffId) =>
      runtime.denialEmitter.suppressedCount(userId, permissionId, target),
    runtimeBrand: runtime.createContext(ownerId)[CTX_RUNTIME_BRAND].runtime,
    async enroll() {
      await runtime.emitRuntimeOp({
        type: 'auth.device_enrolled',
        entityType: 'device',
        entityId: deviceId,
        payload: { enrolledDeviceId: deviceId },
        userId: ownerId,
      });
      log.clear();
      scheduler.calls = 0;
      location.calls = 0;
      projected.length = 0;
    },
    setSnapshot(next: DirectorySnapshot) {
      snapshot = next;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Command fixtures
// ---------------------------------------------------------------------------------------------

/**
 * A minimal strict parser with Zod's shape (`parse` or throw).
 *
 * @bolusi/core may not import zod (08 §3.3), and `InputParser` is structural precisely so a real
 * Zod schema drops in at the module layer. This fixture reproduces the two behaviours the runtime
 * contracts on — reject an unknown key, reject a wrong type — so step 1's mapping to
 * VALIDATION_FAILED is exercised without a dependency the package may not have.
 */
export class StrictParseError extends Error {
  readonly issues: ParseIssue[];
  constructor(issues: ParseIssue[]) {
    super('strict parse failed');
    this.issues = issues;
  }
}

/**
 * A Zod issue, in Zod's OWN shape — deliberately (testing-guide T-13, interrogate the oracle).
 *
 * This fixture is the reference the runtime's `VALIDATION_FAILED` mapping is tested against, so
 * where it disagrees with Zod the test is measuring fiction. It disagreed once already: an
 * unrecognized key was put in `path`, when Zod reports `{ code: 'unrecognized_keys', path: [],
 * keys: [...] }`. That difference matters — `path` is copied into the error `details`, so the fake
 * made an attacker-chosen KEY look like it would land in logs, and a faithful fake shows it does
 * not. Keep this shape aligned with Zod.
 */
export interface ParseIssue {
  readonly path: string[];
  readonly code: string;
  readonly message: string;
  /** Present on `unrecognized_keys` only — where Zod puts the offending key names. */
  readonly keys?: string[];
}

export interface NoteInput {
  readonly title: string;
  readonly body: string;
}

/** `z.object({title: z.string().min(1), body: z.string()}).strict()` in behaviour (04 §5). */
export const noteInputParser = {
  parse(raw: unknown): NoteInput {
    if (typeof raw !== 'object' || raw === null) {
      throw new StrictParseError([{ path: [], code: 'invalid_type', message: 'expected object' }]);
    }
    const value = raw as Record<string, unknown>;
    const issues: ParseIssue[] = [];
    const unknown = Object.keys(value).filter((key) => key !== 'title' && key !== 'body');
    if (unknown.length > 0) {
      // Zod's shape: the offending keys ride `keys`, and `path` stays at the object's root.
      issues.push({
        path: [],
        code: 'unrecognized_keys',
        message: `unrecognized key(s) ${unknown.join(', ')}`,
        keys: unknown,
      });
    }
    if (typeof value.title !== 'string' || value.title.length < 1) {
      issues.push({ path: ['title'], code: 'invalid_type', message: 'expected non-empty string' });
    }
    if (typeof value.body !== 'string') {
      issues.push({ path: ['body'], code: 'invalid_type', message: 'expected string' });
    }
    if (issues.length > 0) throw new StrictParseError(issues);
    return { title: value.title as string, body: value.body as string };
  },
};

export interface CommandSpyOptions {
  readonly name?: string;
  readonly permission?: string;
  /** Extra drafts beyond the first — for the shared-timestamp assertion. */
  readonly extraOps?: number;
  /** Called inside the handler, after the invocation is recorded. */
  readonly onHandler?: (input: NoteInput, ctx: Parameters<NoteHandler>[1]) => Promise<void> | void;
}

type NoteHandler = CommandDefinition<NoteInput, { noteId: string }>['handler'];

export interface CommandSpy extends CommandDefinition<NoteInput, { noteId: string }> {
  readonly invocations: NoteInput[];
}

/** The 04 §5 `createNote` command, instrumented so the suite can see if the handler ran. */
export function makeCommandSpy(log: EventLog, options: CommandSpyOptions = {}): CommandSpy {
  const invocations: NoteInput[] = [];
  return {
    name: options.name ?? 'createNote',
    permission: options.permission ?? 'notes.create',
    input: noteInputParser,
    invocations,
    async handler(input, ctx) {
      invocations.push(input);
      log.record('handler');
      await options.onHandler?.(input, ctx);
      const noteId = ctx.newId();
      const ops: OpDraftInput[] = [
        { type: 'notes.note_created', entityType: 'note', entityId: noteId, payload: { ...input } },
      ];
      for (let i = 0; i < (options.extraOps ?? 0); i += 1) {
        ops.push({
          // The type the `notes` projection fixture registers an applier for, so the same command
          // drives the real engine in the L2 integration suite.
          type: 'notes.note_body_edited',
          entityType: 'note',
          entityId: noteId,
          payload: { body: `${input.body}-${i}` },
        });
      }
      return { ops: ops.map((draft) => ctx.op(draft)), result: { noteId } };
    },
  };
}

/** Assert `error` is a DomainError carrying `code`, and return it. */
export function expectDomainError(error: unknown, code: string): DomainError {
  if (!(error instanceof DomainError)) {
    throw new Error(`expected DomainError, got ${String(error)}`);
  }
  if (error.code !== code) {
    throw new Error(`expected DomainError(${code}), got DomainError(${error.code})`);
  }
  return error;
}
