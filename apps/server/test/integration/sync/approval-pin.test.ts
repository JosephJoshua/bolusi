// Approval PINs (owner decision 2026-11-25): an owner's or manager's decision on a shared device is
// proven by a decision session, which the server opens only on the person's approval PIN, checked
// against a verifier no device holds. Setting one takes more than being signed in, so someone who
// learned a sign-in PIN cannot make it. Real Postgres, real routes.
import { createHash } from 'node:crypto';

import { buildPinVerifier, FLOOR_KDF_PARAMS, utf8ToBytes } from '@bolusi/core';
import { buildPinVerifierRow } from '@bolusi/db-server';
import { PERSON_SESSION_HEADER, type DecisionSessionResponse } from '@bolusi/schemas';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { personOfSession } from '../../../src/auth/person-sessions.js';
import { createPasswordVerifier } from '../../../src/crypto/index.js';
import { serverCryptoPort } from '../../../src/oplog/index.js';
import { makeSyncHarness, type SeededDevice, type SyncHarness } from './helpers.js';

let h: SyncHarness;
beforeEach(async () => {
  h = await makeSyncHarness();
});
afterEach(async () => {
  await h.close();
});

const SIGN_IN_PIN = '482915';
const APPROVAL = '730264';
const NIL_DEVICE = '00000000-0000-0000-0000-000000000000';
const URL = 'http://srv.test';

async function setSignInPin(tenantId: string, userId: string): Promise<void> {
  const verifier = await buildPinVerifier(
    serverCryptoPort,
    utf8ToBytes(SIGN_IN_PIN),
    FLOOR_KDF_PARAMS,
    new Uint8Array(16).fill(7),
    { timestamp: 1, deviceId: NIL_DEVICE, seq: 0 },
  );
  await h.db
    .insertInto('userPinVerifiers')
    .values(buildPinVerifierRow(verifier, { userId, tenantId }))
    .execute();
}

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

/** Signed in on `dev` with the sign-in PIN: the session control-plane calls are proven by. */
async function signIn(dev: SeededDevice, userId: string): Promise<string> {
  const res = await h.app.request(`${URL}/v1/sync/person-session`, {
    method: 'POST',
    headers: { Authorization: dev.auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, pin: SIGN_IN_PIN }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

function actingHeaders(dev: SeededDevice, userId: string, session: string | null) {
  return {
    Authorization: dev.auth,
    'Content-Type': 'application/json',
    'X-Acting-User': userId,
    ...(session === null ? {} : { [PERSON_SESSION_HEADER]: session }),
  };
}

async function setApproval(
  dev: SeededDevice,
  userId: string,
  session: string | null,
  body: Record<string, unknown>,
  target = userId,
): Promise<Response> {
  return h.app.request(`${URL}/v1/users/${target}/approval-pin`, {
    method: 'PUT',
    headers: actingHeaders(dev, userId, session),
    body: JSON.stringify(body),
  });
}

async function clearApproval(
  dev: SeededDevice,
  userId: string,
  session: string,
  target: string,
  pin: string,
): Promise<Response> {
  return h.app.request(`${URL}/v1/users/${target}/approval-pin/clear`, {
    method: 'POST',
    headers: actingHeaders(dev, userId, session),
    body: JSON.stringify({ pin }),
  });
}

async function decide(dev: SeededDevice, userId: string, approvalPin: string): Promise<Response> {
  return h.app.request(`${URL}/v1/sync/decision-session`, {
    method: 'POST',
    headers: { Authorization: dev.auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, approvalPin }),
  });
}

/** Whether `token` proves a decision of its person on `dev` (oplog/steps/decision.ts). */
async function provesDecision(dev: SeededDevice, token: string): Promise<string | null> {
  const row = await h.db
    .selectFrom('personSessions')
    .select('createdAt')
    .where('tokenHash', '=', createHash('sha256').update(token).digest('hex'))
    .executeTakeFirst();
  return personOfSession(h.db as never, {
    token,
    device: { deviceId: dev.world.deviceId, storeId: dev.world.storeId },
    // Just after it opened, by the server's clock.
    now: Number(row?.createdAt ?? 0) + 1,
    decision: true,
  });
}

/** A shared counter with an owner (who has a password) and a staff member, both with sign-in PINs. */
async function world() {
  const counter = await h.seedDevice(9301);
  const { tenantId, storeId, userId: owner } = counter.world;
  const staff = `${storeId.slice(0, 24)}57aff0000000`;
  await setSignInPin(tenantId, owner);
  await setSignInPin(tenantId, staff);
  await h.db
    .updateTable('users')
    .set({ passwordVerifier: await createPasswordVerifier('rahasia-pemilik') })
    .where('id', '=', owner)
    .execute();
  return { counter, owner, staff, tenantId, storeId };
}

/** The owner's approval PIN, set with their password. */
async function ownerApproval(w: Awaited<ReturnType<typeof world>>): Promise<string> {
  const session = await signIn(w.counter, w.owner);
  const res = await setApproval(w.counter, w.owner, session, {
    pin: APPROVAL,
    proof: { kind: 'password', password: 'rahasia-pemilik' },
  });
  expect(res.status).toBe(200);
  return session;
}

describe('an approval PIN opens a decision session; a sign-in PIN does not', () => {
  test('none set yet says so, and a sign-in session proves no decision', async () => {
    const w = await world();
    expect(await errorCode(await decide(w.counter, w.owner, APPROVAL))).toBe(
      'APPROVAL_PIN_NOT_SET',
    );
    const signedIn = await signIn(w.counter, w.owner);
    expect(await provesDecision(w.counter, signedIn)).toBeNull();
  });

  test('the right approval PIN opens one that proves the decision, on that device', async () => {
    const w = await world();
    await ownerApproval(w);
    const res = await decide(w.counter, w.owner, APPROVAL);
    expect(res.status).toBe(200);
    const opened = (await res.json()) as DecisionSessionResponse;
    expect(await provesDecision(w.counter, opened.token)).toBe(w.owner);
    const other = await h.seedDeviceIn(w.tenantId, w.storeId, 9302);
    expect(await provesDecision(other, opened.token)).toBeNull();
  });

  test('a wrong one, or the sign-in PIN, opens nothing; five wrong ones lock it everywhere', async () => {
    const w = await world();
    await ownerApproval(w);
    expect(await errorCode(await decide(w.counter, w.owner, SIGN_IN_PIN))).toBe(
      'AUTH_INVALID_CREDENTIALS',
    );
    const other = await h.seedDeviceIn(w.tenantId, w.storeId, 9303);
    for (let i = 0; i < 4; i += 1) {
      expect((await decide(i % 2 === 0 ? other : w.counter, w.owner, '000000')).status).toBe(401);
    }
    // The budget is the person's, not a device's: a second device does not get five more.
    expect((await decide(other, w.owner, APPROVAL)).status).toBe(429);
  });
  test('someone who does not work at this store, in any tenant, answers like a wrong PIN', async () => {
    const w = await world();
    const elsewhere = await h.seedDevice(9305);
    expect(await errorCode(await decide(w.counter, elsewhere.world.userId, APPROVAL))).toBe(
      'AUTH_INVALID_CREDENTIALS',
    );
  });
});

describe('setting one takes more than being signed in', () => {
  test('a signed-in person with no proof cannot set it, even their first', async () => {
    const w = await world();
    const session = await signIn(w.counter, w.staff);
    expect(await errorCode(await setApproval(w.counter, w.staff, session, { pin: APPROVAL }))).toBe(
      'PERMISSION_DENIED',
    );
    expect(await errorCode(await decide(w.counter, w.staff, APPROVAL))).toBe(
      'APPROVAL_PIN_NOT_SET',
    );
  });

  test('a wrong password sets nothing', async () => {
    const w = await world();
    const session = await signIn(w.counter, w.owner);
    const res = await setApproval(w.counter, w.owner, session, {
      pin: APPROVAL,
      proof: { kind: 'password', password: 'salah' },
    });
    expect(await errorCode(res)).toBe('AUTH_INVALID_CREDENTIALS');
  });

  test('one easy to guess, or the sign-in PIN itself, is refused and nothing is set', async () => {
    const w = await world();
    const session = await signIn(w.counter, w.owner);
    for (const pin of ['123456', SIGN_IN_PIN]) {
      const res = await setApproval(w.counter, w.owner, session, {
        pin,
        proof: { kind: 'password', password: 'rahasia-pemilik' },
      });
      expect(await errorCode(res)).toBe('APPROVAL_PIN_WEAK');
    }
    expect(await errorCode(await decide(w.counter, w.owner, SIGN_IN_PIN))).toBe(
      'APPROVAL_PIN_NOT_SET',
    );
  });

  test('an owner confirms a manager’s with their own approval PIN, there and then', async () => {
    const w = await world();
    await ownerApproval(w);
    const session = await signIn(w.counter, w.staff);
    const wrong = await setApproval(w.counter, w.staff, session, {
      pin: '551203',
      proof: { kind: 'owner', userId: w.owner, pin: '000000' },
    });
    expect(await errorCode(wrong)).toBe('AUTH_INVALID_CREDENTIALS');
    const res = await setApproval(w.counter, w.staff, session, {
      pin: '551203',
      proof: { kind: 'owner', userId: w.owner, pin: APPROVAL },
    });
    expect(res.status).toBe(200);
    const row = await h.db
      .selectFrom('userApprovalPins')
      .select('setBy')
      .where('userId', '=', w.staff)
      .executeTakeFirstOrThrow();
    expect(row.setBy).toBe(w.owner);
    expect((await decide(w.counter, w.staff, '551203')).status).toBe(200);
  });

  test('only someone with owner powers over them confirms it', async () => {
    const w = await world();
    // The staff member gets an approval PIN, then tries to confirm the owner's with it.
    await ownerApproval(w);
    const staffSession = await signIn(w.counter, w.staff);
    await setApproval(w.counter, w.staff, staffSession, {
      pin: '551203',
      proof: { kind: 'owner', userId: w.owner, pin: APPROVAL },
    });
    const ownerSession = await signIn(w.counter, w.owner);
    const res = await setApproval(w.counter, w.owner, ownerSession, {
      pin: '112358',
      proof: { kind: 'owner', userId: w.staff, pin: '551203' },
    });
    expect(await errorCode(res)).toBe('PERMISSION_DENIED');
  });

  test('on the person’s own phone the phone is the proof', async () => {
    const w = await world();
    const phone = await h.seedDeviceIn(w.tenantId, w.storeId, 9304);
    await h.db
      .updateTable('devices')
      .set({ personalUserId: w.staff })
      .where('id', '=', phone.world.deviceId)
      .execute();
    expect((await setApproval(phone, w.staff, null, { pin: APPROVAL })).status).toBe(200);
  });

  test('nobody sets another person’s', async () => {
    const w = await world();
    const session = await ownerApproval(w);
    const res = await setApproval(
      w.counter,
      w.owner,
      session,
      { pin: '551203', proof: { kind: 'current', pin: APPROVAL } },
      w.staff,
    );
    expect(await errorCode(res)).toBe('PERMISSION_DENIED');
  });

  test('changing it ends the decisions the old one proved', async () => {
    const w = await world();
    const session = await ownerApproval(w);
    const old = (
      (await (await decide(w.counter, w.owner, APPROVAL)).json()) as DecisionSessionResponse
    ).token;
    const res = await setApproval(w.counter, w.owner, session, {
      pin: '998877',
      proof: { kind: 'current', pin: APPROVAL },
    });
    expect(res.status).toBe(200);
    expect(await provesDecision(w.counter, old)).toBeNull();
    expect((await decide(w.counter, w.owner, '998877')).status).toBe(200);
  });
});

describe('a forgotten one is cleared by an owner, proven by their own', () => {
  test('the owner clears the manager’s, who then sets one again with the owner', async () => {
    const w = await world();
    const ownerSession = await ownerApproval(w);
    const staffSession = await signIn(w.counter, w.staff);
    await setApproval(w.counter, w.staff, staffSession, {
      pin: '551203',
      proof: { kind: 'owner', userId: w.owner, pin: APPROVAL },
    });
    expect(
      await errorCode(await clearApproval(w.counter, w.owner, ownerSession, w.staff, '000000')),
    ).toBe('AUTH_INVALID_CREDENTIALS');
    expect((await clearApproval(w.counter, w.owner, ownerSession, w.staff, APPROVAL)).status).toBe(
      200,
    );
    expect(await errorCode(await decide(w.counter, w.staff, '551203'))).toBe(
      'APPROVAL_PIN_NOT_SET',
    );
  });

  test('staff cannot clear an owner’s', async () => {
    const w = await world();
    await ownerApproval(w);
    const staffSession = await signIn(w.counter, w.staff);
    const res = await clearApproval(w.counter, w.staff, staffSession, w.owner, '000000');
    expect(await errorCode(res)).toBe('PERMISSION_DENIED');
    expect((await decide(w.counter, w.owner, APPROVAL)).status).toBe(200);
  });
});
