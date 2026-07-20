// The `readVerifier` ordering on the CLIENT driver — and why this lane is the int8 bug's ALIBI.
//
// `readVerifier` (repo.ts) decides which PIN verifier is newest by canonical `asOf` (§5.3), and
// `as_of_seq` is `bigint` server-side. On the real `pg` driver that arrives as a STRING, so
// `"10" < "9"` inverts the decision — proven RED on real PG16 in
// packages/db-server/test/auth-verifier-marshalling.test.ts.
//
// This file runs the SAME decision on better-sqlite3 (the client SQLite mirror: `as_of_seq` is
// INTEGER, handed back as a JS NUMBER; `params` is TEXT, a JSON string). Two consequences the task
// requires this file to nail down (task 48; testing-guide T-8, T-14f):
//
//   1. The client path is CORRECT today — readVerifier already returns numbers here, so the merge
//      picks the newest verifier. That is why the bug is latent (client-only until the server reads
//      verifiers through core).
//   2. This lane is the int8 bug's ALIBI: because the driver hands back a number, removing the
//      `int8ToNumber` seam in readVerifier is INVISIBLE here — this file stays GREEN with the fix
//      reverted. If a "falsification" of the int8 seam ever turns THIS file red, it tested the wrong
//      thing: the int8 class can only be falsified on the real `pg` lane (task 46/48/56). A
//      core-only guard that went red without the seam would be lying about what it covers.
import { CamelCasePlugin, Kysely } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createClientDialect,
  runClientMigrations,
  type ClientDatabase,
  type DbDriver,
} from '@bolusi/db-client';

import {
  chooseEffectiveVerifier,
  readVerifier,
  writeVerifier,
  type PinVerifier,
} from '../../src/index.js';
import { openMemoryDriver } from '../projection/better-sqlite3-driver.js';

const NIL = '00000000-0000-0000-0000-000000000000';
const SHARED_TS = 1_726_000_000_000;

/** A structurally-valid verifier at a given canonical `seq`. No real crypto — this tests ORDERING. */
function verifierAtSeq(seq: number, hashB64: string): PinVerifier {
  return {
    algorithm: 'argon2id',
    saltB64: 'c2FsdHNhbHRzYWx0MTY=',
    mKiB: 32768,
    t: 3,
    p: 1,
    hashB64,
    // Same timestamp and device on both, so `seq` is the sole tie-break — exactly the shape that
    // makes `"10" < "9"` the deciding comparison on the string-returning driver.
    asOf: { timestamp: SHARED_TS, deviceId: NIL, seq },
  };
}

let open: { db: Kysely<ClientDatabase>; driver: DbDriver } | null = null;

async function openClientDb(): Promise<{ db: Kysely<ClientDatabase>; driver: DbDriver }> {
  const driver = openMemoryDriver();
  await runClientMigrations(driver, { now: () => 1 });
  const db = new Kysely<ClientDatabase>({
    dialect: createClientDialect(driver),
    plugins: [new CamelCasePlugin({ underscoreBetweenUppercaseLetters: true })],
  });
  open = { db, driver };
  return open;
}

afterEach(async () => {
  if (open !== null) {
    await open.db.destroy();
    await open.driver.close();
    open = null;
  }
}, 30_000);

describe('readVerifier on the client driver (the int8 alibi lane — stays GREEN with the seam removed)', () => {
  it('returns asOf.seq as a number and reconstructs the params object', async () => {
    const { db } = await openClientDb();
    const userId = 'user-a';
    await writeVerifier(db, userId, verifierAtSeq(10, 'aGFzaA=='));

    const v = await readVerifier(db, userId);
    expect(v?.asOf.seq).toBe(10);
    expect(typeof v?.asOf.seq).toBe('number');
    expect(v?.mKiB).toBe(32768);
    expect(v?.t).toBe(3);
    expect(v?.p).toBe(1);
  });

  it('selects the newest verifier (seq 10 over seq 9) — the client merge is correct', async () => {
    const { db } = await openClientDb();
    await writeVerifier(db, 'user-newer', verifierAtSeq(10, 'bmV3ZXJoYXNo'));
    await writeVerifier(db, 'user-older', verifierAtSeq(9, 'b2xkZXJoYXNo'));

    const vNewer = await readVerifier(db, 'user-newer');
    const vOlder = await readVerifier(db, 'user-older');

    // Both argument orders, so a "return the first argument" fix cannot pass. On a string-returning
    // driver these two lines pick seq 9; here they must pick 10 — and they do so with OR without the
    // int8 seam, because better-sqlite3 already hands back a number (that is the alibi).
    expect(chooseEffectiveVerifier(vNewer, vOlder)?.asOf.seq).toBe(10);
    expect(chooseEffectiveVerifier(vOlder, vNewer)?.asOf.seq).toBe(10);
    expect(chooseEffectiveVerifier(vOlder, vNewer)?.hashB64).toBe(vNewer?.hashB64);
  });
});
