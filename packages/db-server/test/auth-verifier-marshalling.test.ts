// `readVerifier` against the driver PRODUCTION ACTUALLY USES for verifiers server-side (task 56).
//
// WHY THIS FILE EXISTS IN db-server AND NOT IN packages/core, WHERE readVerifier LIVES
// -------------------------------------------------------------------------------------
// `readVerifier` (packages/core/src/auth/repo.ts) reads `user_pin_verifiers`: `params` is `jsonb`
// and `as_of_timestamp`/`as_of_seq` are `bigint` server-side (10-db §9.5; migration 0004). The real
// `pg` driver hands back `jsonb` PARSED and `int8` as a STRING — the two shapes the client SQLite
// driver never produces. readVerifier's raw `sql<>` asserted the CLIENT shapes (`params: string`,
// `asOf*: number`), so on real Postgres:
//
//   - `JSON.parse(<already-parsed object>)` throws `SyntaxError: "[object Object]" is not valid JSON`
//     — the LOUD bug (jsonb class). readVerifier cannot return at all.
//   - once that is fixed, `as_of_seq` arrives as a STRING, and `compareCanonicalOrder` does
//     `a.seq < b.seq` — so `"10" < "9"` is `true` and the "newest verifier" decision INVERTS past
//     seq 9 (int8 class). This is silent: it picks a plausible, superseded verifier, and picking a
//     verifier is an AUTHENTICATION decision (api/02-auth §5.3 greatest-`asOf` merge), not a display
//     bug. This is the same three-class defect task 48 fixed in `RawOpRow`, one surface over.
//
// Every EXISTING lane is blind to both by construction (testing-guide T-8, T-14f):
//
//   lane                       driver           int8 → | jsonb →
//   -------------------------  ---------------  -------|------------
//   @bolusi/core auth tests    better-sqlite3   number | TEXT string   ← JSON.parse works, no invert
//   applier-conformance (T-8)  PGlite           number | parsed        ← catches jsonb, blind to int8
//   production (server) + rls  real `pg`        STRING | parsed        ← only this one reproduces both
//
// So this test lives where the real driver is: `pnpm test:rls` (= `tsc -b && vitest run --project
// db-server`, task 55) runs THIS project against an attributed Postgres 16 through `pg`. There is no
// way to write the int8 leg in packages/core, whose devDependencies are better-sqlite3 and PGlite —
// `pg` is boundary-locked to this package (08 §3.3). A core-only version would pass with the fix
// reverted: the bug's alibi (task 48). The int8 alibi (green on a number-returning driver) is proven
// separately by packages/core/test/auth/verifier-marshalling.test.ts on better-sqlite3.
import { chooseEffectiveVerifier, readVerifier } from '@bolusi/core';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { seedTenant, timestampMs, uuid, type TenantFixture } from './helpers/fixtures.js';
import { createTestDb, ENGINE, type TestDb } from './helpers/test-db.js';

let testDb: TestDb;
let tenant: TenantFixture;

/** A `{ mKiB, t, p }` params object as `writeVerifier` stores it (repo.ts). */
const OBJECT_PARAMS = { mKiB: 32768, t: 3, p: 1 } as const;

/** Insert a user (FK for the verifier row) under the seeded tenant. */
async function seedUser(userId: string): Promise<void> {
  await testDb.db
    .insertInto('users')
    .values({
      id: userId,
      tenantId: tenant.tenantId,
      name: `u-${userId}`,
      createdAt: BigInt(timestampMs()),
    })
    .execute();
}

/**
 * Insert a `user_pin_verifiers` row through the OWNER handle (RLS-bypassed — a fixture's job).
 *
 * `params` is written via `JSON.stringify` exactly as `seedOperation` writes the op-log `jsonb`
 * columns: a JSON *text* parameter into a `jsonb` column, so the point of the read-back is what the
 * DRIVER does on the way OUT (parses it), not on the way in.
 */
async function seedVerifier(opts: {
  userId: string;
  params?: unknown;
  asOfTimestamp: bigint;
  asOfDeviceId: string;
  asOfSeq: bigint;
  hash?: string;
}): Promise<void> {
  await seedUser(opts.userId);
  await testDb.db
    .insertInto('userPinVerifiers')
    .values({
      userId: opts.userId,
      tenantId: tenant.tenantId,
      algo: 'argon2id',
      salt: 'c2FsdHNhbHRzYWx0MTY=',
      params: JSON.stringify(opts.params ?? OBJECT_PARAMS),
      hash: opts.hash ?? 'aGFzaGhhc2hoYXNo',
      asOfTimestamp: opts.asOfTimestamp,
      asOfDeviceId: opts.asOfDeviceId,
      asOfSeq: opts.asOfSeq,
    })
    .execute();
}

beforeAll(async () => {
  testDb = await createTestDb();
  tenant = await seedTenant(testDb.db);
}, 120_000);

afterAll(async () => {
  await testDb?.close();
});

describe('lane coverage (T-14 — a guard must assert its own coverage)', () => {
  test('reports which engine and driver produced these results', () => {
    // Numbers from this file mean different things per lane: on a number-returning driver the
    // ordering passes whether or not the int8 fix is present. Make the lane explicit.
    expect(['pglite', 'postgres']).toContain(ENGINE);
  });

  test('this lane marshals int8 as a STRING and jsonb as an OBJECT', async () => {
    // THE LOAD-BEARING PRECONDITION. The ordering-inversion below only proves something if
    // `as_of_seq` genuinely arrives as a string (that string is the whole mechanism of `"10" <
    // "9"`), and the jsonb reproduction only proves something if `params` genuinely arrives parsed.
    // If a future pg release, a pool-level `setTypeParser`, or a driver swap started handing back
    // numbers/text, both would go green for the WRONG reason and this file would silently stop
    // covering anything (exactly as T-8 did). So assert the preconditions rather than assume them.
    const userId = uuid();
    await seedVerifier({
      userId,
      asOfTimestamp: BigInt(timestampMs()),
      asOfDeviceId: uuid(),
      asOfSeq: 3n,
    });

    const r = await sql<{ asOfSeq: unknown; asOfTimestamp: unknown; params: unknown }>`
      SELECT as_of_seq AS "asOfSeq", as_of_timestamp AS "asOfTimestamp", params
      FROM user_pin_verifiers WHERE user_id = ${userId}
    `.execute(testDb.db);

    expect(typeof r.rows[0]?.asOfSeq).toBe(ENGINE === 'postgres' ? 'string' : 'number');
    expect(typeof r.rows[0]?.asOfTimestamp).toBe(ENGINE === 'postgres' ? 'string' : 'number');
    expect(typeof r.rows[0]?.params).toBe('object');
  });
});

describe('jsonb params (the LOUD bug — masks the int8 one until fixed)', () => {
  test('readVerifier reconstructs the verifier from a parsed jsonb params column', async () => {
    // Before the fix this THREW on real pg: `JSON.parse(<object>)` → `SyntaxError`. That throw is
    // why the int8 inversion below cannot even be observed on unfixed code — readVerifier never
    // returns. Fixed: `jsonColumnToObject` accepts the parsed object AND the client's TEXT string.
    const userId = uuid();
    const asOfDeviceId = uuid();
    await seedVerifier({ userId, asOfTimestamp: BigInt(timestampMs()), asOfDeviceId, asOfSeq: 5n });

    const v = await readVerifier(testDb.db, userId);
    expect(v).not.toBeNull();
    expect(v?.algorithm).toBe('argon2id');
    expect(v?.mKiB).toBe(32768);
    expect(v?.t).toBe(3);
    expect(v?.p).toBe(1);
  });
});

describe('int8 as_of_seq inverts the "newest verifier" decision (the SILENT bug)', () => {
  // Two verifiers that differ ONLY in `as_of_seq` (9 vs 10) at the SAME timestamp and device — so
  // `seq` is the sole tie-break and the string compare `"10" < "9"` is what decides it. Both are
  // read back through readVerifier, so on real pg BOTH `asOf.seq` are strings: that is the only way
  // to reach the string-vs-string lexicographic compare. In the live merge one operand is usually a
  // number (a bundle/fresh DTO), which is a subtler equal-timestamp bug; two DB reads is the
  // decisive, load-bearing case, and it is exactly what a server that orders two stored verifiers
  // (api/02-auth §6.5 — task 13/28's surface) would do.
  let newer: string; // seq 10 — the genuinely newest
  let older: string; // seq 9
  let asOfDeviceId: string;
  let asOfTimestamp: bigint;

  beforeAll(async () => {
    newer = uuid();
    older = uuid();
    asOfDeviceId = uuid();
    asOfTimestamp = BigInt(timestampMs());
    await seedVerifier({
      userId: newer,
      asOfTimestamp,
      asOfDeviceId,
      asOfSeq: 10n,
      hash: 'bmV3ZXJoYXNo',
    });
    await seedVerifier({
      userId: older,
      asOfTimestamp,
      asOfDeviceId,
      asOfSeq: 9n,
      hash: 'b2xkZXJoYXNo',
    });
  }, 120_000);

  test('readVerifier returns asOf.seq as a NUMBER, not the driver string', async () => {
    // The type-lie made concrete: the raw `sql<>` claimed `asOfSeq: number`, tsc believed it, and
    // on real pg the value is a string. `10` (number), never `"10"`.
    const v = await readVerifier(testDb.db, newer);
    expect(v?.asOf.seq).toBe(10);
    expect(typeof v?.asOf.seq).toBe('number');
    expect(typeof v?.asOf.timestamp).toBe('number');
  });

  test('the newest verifier (seq 10) is selected — not the superseded seq 9', async () => {
    // THE REGRESSION. With `as_of_seq` a string, `compareCanonicalOrder` does `"10" < "9"` → true,
    // so `chooseEffectiveVerifier` picks the SUPERSEDED seq-9 verifier. Removing the int8
    // normalisation in readVerifier turns this red on `pnpm test:rls` and ONLY there.
    const vNewer = await readVerifier(testDb.db, newer);
    const vOlder = await readVerifier(testDb.db, older);

    // Both argument orders, so a fix that just "returns the first argument" cannot pass.
    expect(chooseEffectiveVerifier(vNewer, vOlder)?.asOf.seq).toBe(10);
    expect(chooseEffectiveVerifier(vOlder, vNewer)?.asOf.seq).toBe(10);
    // And it is the newer row's material, not merely a numerically-larger seq synthesised somewhere.
    expect(chooseEffectiveVerifier(vOlder, vNewer)?.hashB64).toBe(vNewer?.hashB64);
  });
});

// ── §2.5 adversarial tests — an AUTH surface ships these BEFORE review ─────────────────────────────
// Every deny carries a POSITIVE CONTROL (the legitimate value IS read / IS selected), or a fix that
// rejects everything is indistinguishable from one that works (T-14b).
describe('adversarial: a corrupt/tampered verifier row cannot silently win or silently narrow', () => {
  test('tampered as_of_seq beyond 2^53 REFUSES (fail-closed) — it cannot silently round and invert', async () => {
    // A local row tampered to a huge `as_of_seq` would, under a plain `Number()`, round to 2^53 and
    // could win the greatest-`asOf` merge. `int8ToNumber` throws instead — the tampered verifier
    // becomes UNREADABLE rather than a silently-rounded winner (int8.ts; task 46 one magnitude up).
    const userId = uuid();
    await seedVerifier({
      userId,
      asOfTimestamp: BigInt(timestampMs()),
      asOfDeviceId: uuid(),
      asOfSeq: 9_007_199_254_740_993n, // 2^53 + 1
    });
    await expect(readVerifier(testDb.db, userId)).rejects.toThrow(/exceeds/);
  });

  test('POSITIVE CONTROL — an in-range as_of_seq reads back as the EXACT number', async () => {
    // Guards the guard: without this, "it throws" could just mean "big numbers throw" and the deny
    // above would pass for a fix that refused every verifier near the boundary.
    const userId = uuid();
    await seedVerifier({
      userId,
      asOfTimestamp: BigInt(timestampMs()),
      asOfDeviceId: uuid(),
      asOfSeq: 9_007_199_254_740_991n, // 2^53 − 1 — the largest exact JS integer
    });
    const v = await readVerifier(testDb.db, userId);
    expect(v?.asOf.seq).toBe(9_007_199_254_740_991);
  });

  test('a params blob that is NOT an object REFUSES (fail-closed) — no silent undefined KDF params', async () => {
    // A `jsonb` params tampered to a scalar would, under `JSON.parse`, either throw or yield a value
    // whose `.mKiB`/`.t`/`.p` are `undefined` — silently handing the verify path junk KDF params.
    // `jsonColumnToObject` refuses anything that is not an object.
    const userId = uuid();
    await seedVerifier({
      userId,
      params: 5, // JSON.stringify(5) → jsonb number 5 → a scalar, not an object
      asOfTimestamp: BigInt(timestampMs()),
      asOfDeviceId: uuid(),
      asOfSeq: 2n,
    });
    await expect(readVerifier(testDb.db, userId)).rejects.toThrow();
  });

  test('POSITIVE CONTROL — a well-formed object params reads back its fields', async () => {
    const userId = uuid();
    await seedVerifier({
      userId,
      params: { mKiB: 19456, t: 2, p: 1 },
      asOfTimestamp: BigInt(timestampMs()),
      asOfDeviceId: uuid(),
      asOfSeq: 2n,
    });
    const v = await readVerifier(testDb.db, userId);
    expect(v?.mKiB).toBe(19456);
    expect(v?.t).toBe(2);
  });

  test('readVerifier is scoped to its user — another user’s verifier is never returned', async () => {
    // The `WHERE user_id = ${userId}` isolation. An auth read that cross-reads is a control-plane
    // leak; both users carry DISTINCT material so a swap would be visible.
    const userX = uuid();
    const userY = uuid();
    const at = BigInt(timestampMs());
    await seedVerifier({
      userId: userX,
      asOfTimestamp: at,
      asOfDeviceId: uuid(),
      asOfSeq: 1n,
      hash: 'eF9oYXNo',
    });
    await seedVerifier({
      userId: userY,
      asOfTimestamp: at,
      asOfDeviceId: uuid(),
      asOfSeq: 1n,
      hash: 'eV9oYXNo',
    });

    const vX = await readVerifier(testDb.db, userX);
    const vY = await readVerifier(testDb.db, userY);
    expect(vX?.hashB64).toBe('eF9oYXNo');
    expect(vY?.hashB64).toBe('eV9oYXNo');
    expect(vX?.hashB64).not.toBe(vY?.hashB64);
  });

  test('equal asOf is a stable no-inversion, and the strictly-newer verifier still wins', async () => {
    // Two verifiers with an IDENTICAL (timestamp, deviceId, seq) triple compare equal (0), so the
    // merge is stable — no phantom "newer". POSITIVE CONTROL: raise the seq by one and it must win,
    // proving the equal branch is genuine equality, not a fix that calls everything equal.
    const a = uuid();
    const b = uuid();
    const dev = uuid();
    const at = BigInt(timestampMs());
    await seedVerifier({
      userId: a,
      asOfTimestamp: at,
      asOfDeviceId: dev,
      asOfSeq: 7n,
      hash: 'YV9oYXNo',
    });
    await seedVerifier({
      userId: b,
      asOfTimestamp: at,
      asOfDeviceId: dev,
      asOfSeq: 7n,
      hash: 'Yl9oYXNo',
    });
    const va = await readVerifier(testDb.db, a);
    const vb = await readVerifier(testDb.db, b);
    // Equal triples ⇒ `compareVerifierAsOf` returns 0 ⇒ `chooseEffectiveVerifier` keeps the first.
    expect(chooseEffectiveVerifier(va, vb)?.hashB64).toBe(va?.hashB64);

    const c = uuid();
    await seedVerifier({
      userId: c,
      asOfTimestamp: at,
      asOfDeviceId: dev,
      asOfSeq: 8n,
      hash: 'Y19oYXNo',
    });
    const vc = await readVerifier(testDb.db, c);
    expect(chooseEffectiveVerifier(va, vc)?.hashB64).toBe(vc?.hashB64);
    expect(chooseEffectiveVerifier(vc, va)?.hashB64).toBe(vc?.hashB64);
  });
});
