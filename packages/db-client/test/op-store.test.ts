// Adversarial tests for the PRODUCTION client op store (CLAUDE.md §2.5 — the crown-jewel surface:
// op signing, the per-device hash chain, genesis rules, and append/projection atomicity).
//
// This is the store `runEnrollment`'s genesis append runs through on a real device. It is proven
// here against a REAL migrated client DB (better-sqlite3 behind the real dialect) + REAL noble
// crypto + core's REAL `appendLocalOps`/`completeDraft`/chain path — everything but the JSI driver,
// which is SEC-DEV-06's on-device leg (task 27a). The assertions are the ones a §2.5 surface owes:
//
//   • a genesis op is signed with the device key and chains from seq 1 (previousHash = 64 zeros);
//   • the signature is BOUND to that key — a different key does not verify it;
//   • a tampered op fails verification (the signature covers the whole core, 05 §3);
//   • the genesis cannot run twice — a second seq-1 append is refused and NOTHING is inserted;
//   • a non-genesis first op is refused, and nothing is inserted;
//   • the append is ATOMIC — an applier throw rolls the op row back (04 §5.1 steps 5–6);
//   • a real second op chains from the genesis and the whole chain verifies.
//
// FALSIFIED (§2.11), reported not asserted: breaking `crypto.sign` turns the genesis-verifies test
// RED; forcing `nextChainPosition` to seq 0 turns the chain test RED; making the store swallow the
// applier throw turns the atomicity test RED. Each was broken, observed red, and reverted.
import {
  appendLocalOps,
  bytesToBase64,
  createUuidV7Generator,
  GenesisRuleError,
  verifyChain,
  verifyOp,
  type AppendContext,
  type OpDraft,
} from '@bolusi/core';
import { GENESIS_PREVIOUS_HASH, type SignedOperation } from '@bolusi/schemas';
import { mulberry32, noblePort, randomBytes as prngBytes } from '@bolusi/test-support';
import { sql } from 'kysely';
import { afterEach, beforeEach, expect, test } from 'vitest';

import { closeClientDb, openClientDb, type ClientDb } from '../src/connection.js';
import { runClientMigrations } from '../src/migrations/runner.js';
import { createClientOpStore } from '../src/op-store.js';
import { openBetterSqlite3Driver, testAead } from './better-sqlite3-adapter.js';

const KEY = 'a'.repeat(64);
const T = 1_726_000_000_000;
const GENESIS_TYPE = 'auth.device_enrolled';

let db: ClientDb;
let store: ReturnType<typeof createClientOpStore>;

// A seeded device identity — deterministic per seed (T-6): keypair, ids and clock are all derived
// from one PRNG, so the whole test reproduces byte-for-byte with no real RNG or wall clock.
const prng = mulberry32(0x92);
const keypair = noblePort.ed25519Keygen(prngBytes(prng, 32));
const ids = createUuidV7Generator({ now: () => T, randomBytes: (n) => prngBytes(prng, n) });
const tenantId = ids();
const storeId = ids();
const userId = ids();
const deviceId = ids();

const context: AppendContext = {
  tenantId,
  storeId,
  userId,
  deviceId,
  secretKey: keypair.secretKey,
};

function genesisDraft(): OpDraft {
  return {
    type: GENESIS_TYPE,
    entityType: 'device',
    entityId: deviceId,
    schemaVersion: 1,
    payload: { storeId, deviceName: 'Kasir 1', devicePublicKeyB64: '' },
    source: 'system',
  };
}

/** A plain non-genesis draft (a fake note edit) — for the chaining + non-genesis-first tests. */
function noteDraft(entityId: string): OpDraft {
  return {
    type: 'notes.note_created',
    entityType: 'note',
    entityId,
    schemaVersion: 1,
    payload: { title: 'Stock', body: 'Twelve crates' },
  };
}

interface AppendOverrides {
  readonly drafts?: readonly OpDraft[];
  readonly applyProjection?: (op: SignedOperation) => void;
  readonly newId?: () => string;
}

/** Run one command's worth of drafts through the production store + the real append path. */
function append(overrides: AppendOverrides = {}) {
  return appendLocalOps({
    store,
    drafts: overrides.drafts ?? [genesisDraft()],
    context,
    crypto: noblePort,
    newId: overrides.newId ?? ids,
    now: () => T,
    location: null,
    applyProjection: overrides.applyProjection ?? (() => undefined),
  });
}

/**
 * Every op row for the device, ascending by seq, reconstructed into a `SignedOperation`. Read via
 * the TYPED query builder (not raw `SELECT *`): the client Kysely runs CamelCasePlugin, so a raw
 * `sql` result comes back camelCased and a snake_case column lookup would silently be `undefined` —
 * which would corrupt the reconstructed core and make every `verifyOp` here vacuously false.
 */
async function readChain(): Promise<SignedOperation[]> {
  const rows = await db.db
    .selectFrom('operations')
    .selectAll()
    .where('deviceId', '=', deviceId)
    .orderBy('seq', 'asc')
    .execute();
  return rows.map((r) => ({
    id: r.id as string,
    tenantId: r.tenantId,
    storeId: r.storeId,
    userId: r.userId,
    deviceId: r.deviceId,
    seq: r.seq,
    type: r.type,
    entityType: r.entityType,
    entityId: r.entityId,
    schemaVersion: r.schemaVersion,
    payload: JSON.parse(r.payload) as Record<string, unknown>,
    timestamp: r.timestampMs,
    location: r.location === null ? null : (JSON.parse(r.location) as SignedOperation['location']),
    source: r.source as SignedOperation['source'],
    agentInitiated: r.agentInitiated === 1,
    agentConversationId: r.agentConversationId,
    previousHash: r.previousHash,
    hash: r.hash,
    signature: r.signature,
  }));
}

async function opCount(): Promise<number> {
  const rows = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM operations`.execute(db.db);
  return Number(rows.rows[0]?.n ?? 0);
}

beforeEach(async () => {
  db = await openClientDb({
    driverFactory: openBetterSqlite3Driver,
    keyStore: { getDatabaseEncryptionKey: () => Promise.resolve(KEY) },
    aead: testAead,
    location: ':memory:',
  });
  await runClientMigrations(db.driver, { now: () => 1 });
  store = createClientOpStore(db);
});

afterEach(async () => {
  await closeClientDb();
});

test('genesis: signed with the device key and chains from seq 1', async () => {
  const { ops } = await append();

  expect(ops).toHaveLength(1);
  const first = ops[0];
  if (first?.status !== 'appended') throw new Error('genesis was not appended');
  expect(first.seq).toBe(1);
  expect(first.op.previousHash).toBe(GENESIS_PREVIOUS_HASH);
  expect(first.op.type).toBe(GENESIS_TYPE);
  expect(first.op.entityId).toBe(deviceId);

  // The signature is REAL: it verifies against the device public key over the recomputed digest.
  expect(verifyOp(first.op, keypair.publicKey, noblePort)).toBe(true);

  // …and it is BOUND to that key — a different device's key does not verify it.
  const other = noblePort.ed25519Keygen(prngBytes(prng, 32));
  expect(verifyOp(first.op, other.publicKey, noblePort)).toBe(false);

  // The PERSISTED bytes round-trip: the row read back verifies too (the store didn't mangle them).
  const [persisted] = await readChain();
  expect(persisted).toBeDefined();
  expect(verifyOp(persisted as SignedOperation, keypair.publicKey, noblePort)).toBe(true);
});

test('a tampered op fails verification (the signature covers the whole core)', async () => {
  const { ops } = await append();
  const first = ops[0];
  if (first?.status !== 'appended') throw new Error('genesis was not appended');
  const op = first.op;

  // Baseline: the untouched op verifies.
  expect(verifyOp(op, keypair.publicKey, noblePort)).toBe(true);

  // Mutate the payload → the recomputed hash no longer matches the claimed hash → rejected.
  expect(verifyOp({ ...op, payload: { evil: true } }, keypair.publicKey, noblePort)).toBe(false);
  // Rewrite the claimed hash to a plausible-looking value → rejected.
  expect(verifyOp({ ...op, hash: 'f'.repeat(64) }, keypair.publicKey, noblePort)).toBe(false);
  // A VALID Ed25519 signature by the right key but over a DIFFERENT message → rejected. This is the
  // sharp one: it proves verification checks the signature against THIS op's digest, not merely
  // "is a well-formed signature by the device key".
  const wrongMessage = noblePort.sha256(new Uint8Array([1, 2, 3]));
  const wrongSig = bytesToBase64(noblePort.sign(wrongMessage, keypair.secretKey));
  expect(verifyOp({ ...op, signature: wrongSig }, keypair.publicKey, noblePort)).toBe(false);
});

test('the genesis cannot run twice — a second seq-1 append inserts nothing', async () => {
  await append();
  expect(await opCount()).toBe(1);

  // A resumed/duplicate enrollment must not write a second genesis (05 §9.5). The store's
  // transaction rolls the whole thing back — the count stays 1, the chain head unmoved.
  await expect(append({ newId: () => ids() })).rejects.toBeInstanceOf(GenesisRuleError);
  await expect(append({ newId: () => ids() })).rejects.toMatchObject({
    code: 'GENESIS_ON_NON_EMPTY_CHAIN',
  });
  expect(await opCount()).toBe(1);
});

test('a non-genesis first op is refused and nothing is inserted', async () => {
  await expect(append({ drafts: [noteDraft(ids())] })).rejects.toMatchObject({
    code: 'NON_GENESIS_FIRST_OP',
  });
  expect(await opCount()).toBe(0);
});

test('the append is atomic: an applier throw rolls the op row back', async () => {
  await expect(
    append({
      applyProjection: () => {
        throw new Error('projection blew up inside the append transaction');
      },
    }),
  ).rejects.toThrow('projection blew up');

  // Steps 5–6 are ONE transaction: the throw rolled the insert back, so the device is still
  // genesis-less. A leftover op row here would be the silent corruption this atomicity exists to
  // prevent (an op the projection never folded).
  expect(await opCount()).toBe(0);
});

test('a real second op chains from the genesis and the whole chain verifies', async () => {
  await append(); // genesis, seq 1
  const noteId = ids();
  const { ops } = await append({ drafts: [noteDraft(noteId)] });
  const second = ops[0];
  if (second?.status !== 'appended') throw new Error('second op was not appended');

  const genesis = (await readChain())[0] as SignedOperation;
  expect(second.seq).toBe(2);
  expect(second.op.previousHash).toBe(genesis.hash);

  const chain = await readChain();
  expect(chain).toHaveLength(2);
  expect(verifyChain(chain, keypair.publicKey, noblePort).ok).toBe(true);

  // Falsify the chaining locally: a broken link is CAUGHT (this is what proves the check above is
  // load-bearing rather than vacuously green on an already-ok chain).
  const spliced: SignedOperation[] = [
    chain[0] as SignedOperation,
    { ...(chain[1] as SignedOperation), previousHash: 'b'.repeat(64) },
  ];
  expect(verifyChain(spliced, keypair.publicKey, noblePort).ok).toBe(false);
});
