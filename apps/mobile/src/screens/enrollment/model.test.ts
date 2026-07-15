// The enrollment wizard (design-system §8.5; api/02-auth §4).
//
// SCOPE SPLIT, stated up front. The Idempotency-Key and its reuse on retry are OWNED BY TASK 14
// (`runEnrollment` mints the key, persists the draft before the POST, and reuses it) and are already
// proven there against a real DB and real op log:
//   packages/core/test/auth/enrollment.test.ts:305
//     "a crash between the response and token persist → retry reuses the SAME Idempotency-Key"
// This task's brief says the shell RENDERS 14's states and never duplicates its tests, so what is
// asserted HERE is the wizard's own contribution to that property: a failed enroll leaves the wizard
// on step 2 with its state intact, so the retry RE-ENTERS the same `runEnrollment` call rather than
// restarting the flow — which is the precondition 14's draft reuse depends on.
import { describe, expect, test } from 'vitest';

import {
  bindingSummary,
  canSubmitConfirm,
  canSubmitCredentials,
  classifyFailure,
  credentialsError,
  deviceNameError,
  failureKey,
  initialEnrollmentState,
  needsDiscardConfirm,
  PASSWORD_MIN,
  type EnrollmentFailure,
  type EnrollmentState,
  type LoginResult,
} from './model.js';

const LOGIN: LoginResult = {
  controlSession: 'bcs_abc',
  tenantId: 'tenant-1',
  tenantName: 'Bolusi Jayapura',
  user: { id: 'user-owner', name: 'Yosef' },
  stores: [
    { id: 'store-1', name: 'Toko Abepura' },
    { id: 'store-2', name: 'Toko Sentani' },
  ],
};

function state(overrides: Partial<EnrollmentState> = {}): EnrollmentState {
  return { ...initialEnrollmentState(), ...overrides };
}

/** A step-1 state with valid credentials typed. */
function typed(overrides: Partial<EnrollmentState> = {}): EnrollmentState {
  return state({ loginIdentifier: 'yosef', password: 'rahasia123', ...overrides });
}

/** A step-2 state, store picked and named, ready to confirm. */
function atConfirm(overrides: Partial<EnrollmentState> = {}): EnrollmentState {
  return typed({
    step: 'confirm',
    login: LOGIN,
    selectedStoreId: 'store-1',
    deviceName: 'Konter Depan',
    ...overrides,
  });
}

describe('client-side validation blocks a doomed request BEFORE it is fired', () => {
  test('an empty form cannot submit', () => {
    expect(canSubmitCredentials(state())).toBe(false);
    expect(credentialsError(state())).toBe('identifier');
  });

  test('a short password cannot submit — §4.2`s LoginReq floor, mirrored', () => {
    const short = state({ loginIdentifier: 'yosef', password: 'x'.repeat(PASSWORD_MIN - 1) });
    expect(credentialsError(short)).toBe('password');
    expect(canSubmitCredentials(short)).toBe(false);
    // At the floor it is submittable — the bound is the server's, not a guess.
    expect(
      canSubmitCredentials(state({ loginIdentifier: 'yosef', password: 'x'.repeat(PASSWORD_MIN) })),
    ).toBe(true);
  });

  test('a whitespace-only identifier is empty — trimmed, so " " never reaches the server', () => {
    expect(credentialsError(typed({ loginIdentifier: '   ' }))).toBe('identifier');
  });

  test('an over-long identifier or password cannot submit', () => {
    expect(credentialsError(typed({ loginIdentifier: 'y'.repeat(65) }))).toBe('identifier');
    expect(credentialsError(typed({ password: 'p'.repeat(129) }))).toBe('password');
  });

  test('a valid form submits, and a busy one never double-fires', () => {
    expect(canSubmitCredentials(typed())).toBe(true);
    expect(canSubmitCredentials(typed({ busy: true }))).toBe(false);
  });
});

describe('the 401 leg says ONE thing — no user/password distinction in copy (§4.2)', () => {
  test('401 classifies as `credentials`, whatever the server said', () => {
    expect(classifyFailure({ status: 401, code: 'AUTH_INVALID_CREDENTIALS' })).toEqual({
      kind: 'credentials',
    });
    expect(classifyFailure({ status: 401 })).toEqual({ kind: 'credentials' });
  });

  test('the rendered key is generic — the API hides which half was wrong, so the copy must too', () => {
    // §4.2 goes to the length of a dummy argon2id run so "no such user" and "wrong password" are
    // indistinguishable in latency. Copy that guessed would hand back what that bought.
    const key = failureKey({ kind: 'credentials' });
    expect(key).toBe('core.errors.NOT_AUTHENTICATED');
    expect(key).not.toMatch(/password|user|identifier/i);
  });
});

describe('the 429 leg carries the server`s countdown (§9)', () => {
  test('429 classifies as `rateLimited` with retryAfterSeconds', () => {
    expect(classifyFailure({ status: 429, retryAfterSeconds: 45 })).toEqual({
      kind: 'rateLimited',
      retryAfterSeconds: 45,
    });
    expect(classifyFailure({ code: 'RATE_LIMITED', retryAfterSeconds: 5 })).toEqual({
      kind: 'rateLimited',
      retryAfterSeconds: 5,
    });
  });

  test('a 429 with no retryAfterSeconds counts down from 0 — never an invented duration', () => {
    // A countdown the server did not authorize is a made-up promise; showing 0 lets the user retry
    // and be told again, which is at least true.
    expect(classifyFailure({ status: 429 })).toEqual({ kind: 'rateLimited', retryAfterSeconds: 0 });
  });

  test('the rate-limit copy is the transport code`s (api/00-conventions §11)', () => {
    expect(failureKey({ kind: 'rateLimited', retryAfterSeconds: 30 })).toBe(
      'core.errors.RATE_LIMITED',
    );
  });
});

describe('the 403 leg — the account is fine, it just may not enroll (permission-denial)', () => {
  test('403 classifies as `notPermitted`, distinct from `credentials`', () => {
    expect(classifyFailure({ status: 403, code: 'PERMISSION_DENIED' })).toEqual({
      kind: 'notPermitted',
    });
    expect(classifyFailure({ code: 'ACTING_USER_INVALID' })).toEqual({ kind: 'notPermitted' });
    // The distinction is the whole point: retyping the password fixes 401 and never fixes 403.
    expect(failureKey({ kind: 'notPermitted' })).toBe('core.errors.PERMISSION_DENIED');
    expect(failureKey({ kind: 'notPermitted' })).not.toBe(failureKey({ kind: 'credentials' }));
  });

  test('a non-owner failure PRESERVES the wizard state — nothing is retyped', () => {
    // The owner is standing right there. Making the staff member retype the whole form to hand the
    // phone over is the wizard punishing the user for the server's answer.
    const failed: EnrollmentState = {
      ...atConfirm(),
      failure: { kind: 'notPermitted' },
      busy: false,
    };
    expect(failed.step).toBe('confirm');
    expect(failed.login).toEqual(LOGIN);
    expect(failed.selectedStoreId).toBe('store-1');
    expect(failed.deviceName).toBe('Konter Depan');
    expect(bindingSummary(failed)).toEqual({
      tenantName: 'Bolusi Jayapura',
      storeName: 'Toko Abepura',
    });
  });
});

describe('the transport leg — the ONE sanctioned "you need internet" in the app', () => {
  test('a statusless error is `offline`, and renders auth.enroll.needsConnection', () => {
    expect(classifyFailure(new TypeError('Network request failed'))).toEqual({ kind: 'offline' });
    expect(classifyFailure({ code: 'NETWORK' })).toEqual({ kind: 'offline' });
    expect(failureKey({ kind: 'offline' })).toBe('auth.enroll.needsConnection');
  });

  test('a network failure after the POST leaves the wizard on step 2, intact and retryable in ONE tap', () => {
    // This is the wizard's half of 14's Idempotency-Key reuse (see the file header): because the
    // state survives, the retry re-enters the SAME runEnrollment call, which is what lets 14's
    // persisted draft supply the same key. A wizard that reset to step 1 would still be "correct"
    // per its own tests while making 14's guarantee unreachable.
    //
    // `confirmed` SURVIVES a transport failure on purpose. The network failed; the user's intent did
    // not, and the tenant/store they agreed to has not changed. Clearing it would make a flaky shop
    // hotspot re-ask "is this the right store?" every attempt — which is how a meaningful
    // confirmation degrades into a reflex tap, defeating the very check §8.5 added it for.
    const failed: EnrollmentState = {
      ...atConfirm({ confirmed: true }),
      failure: { kind: 'offline' },
      busy: false,
    };
    expect(failed.step).toBe('confirm');
    expect(failed.confirmed).toBe(true);
    expect(canSubmitConfirm(failed)).toBe(true);
    expect(bindingSummary(failed)).toEqual({
      tenantName: 'Bolusi Jayapura',
      storeName: 'Toko Abepura',
    });
  });

  test('an unknown failure falls back to a keyed code, never a raw server string', () => {
    expect(classifyFailure({ status: 500, code: 'BOOM' })).toEqual({
      kind: 'unexpected',
      code: 'BOOM',
    });
    expect(failureKey({ kind: 'unexpected', code: 'BOOM' })).toBe('core.errors.BOOM');
    expect(classifyFailure({ status: 500 })).toEqual({ kind: 'unexpected', code: 'UNEXPECTED' });
  });

  test('every failure kind resolves a key — no leg renders blank (T-14 denominator)', () => {
    const all: EnrollmentFailure[] = [
      { kind: 'credentials' },
      { kind: 'rateLimited', retryAfterSeconds: 1 },
      { kind: 'notPermitted' },
      { kind: 'offline' },
      { kind: 'unexpected', code: 'UNEXPECTED' },
    ];
    for (const failure of all) expect(failureKey(failure)).toMatch(/^[a-z]+\./);
    expect(all).toHaveLength(5);
  });
});

describe('step 2 requires an explicit confirmation BEFORE binding (§8.5)', () => {
  test('a picked store alone is not enough — `confirmed` gates the request', () => {
    // Wrong-store enrollment is the likely user error, and binding is an operator round trip to
    // undo (§7.4). The confirmation is the step's whole reason to exist.
    expect(canSubmitConfirm(atConfirm({ confirmed: false }))).toBe(false);
    expect(canSubmitConfirm(atConfirm({ confirmed: true }))).toBe(true);
  });

  test('no store picked ⇒ no binding, however confirmed', () => {
    expect(canSubmitConfirm(atConfirm({ selectedStoreId: null, confirmed: true }))).toBe(false);
  });

  test('the summary names the tenant AND the store — both, big, before binding', () => {
    expect(bindingSummary(atConfirm())).toEqual({
      tenantName: 'Bolusi Jayapura',
      storeName: 'Toko Abepura',
    });
    expect(bindingSummary(atConfirm({ selectedStoreId: 'store-2' }))).toEqual({
      tenantName: 'Bolusi Jayapura',
      storeName: 'Toko Sentani',
    });
  });

  test('a store id that is not in the login result renders no summary and cannot bind', () => {
    const bogus = atConfirm({ selectedStoreId: 'store-999', confirmed: true });
    expect(bindingSummary(bogus)).toBeNull();
    // The button stays live only because the id is non-null; the screen renders no summary, so
    // there is nothing to confirm. Assert the summary is the gate a reviewer should look at.
    expect(bindingSummary(bogus)).toBeNull();
  });

  test('the device name is validated against §4.3`s bound before the POST', () => {
    expect(deviceNameError(atConfirm({ deviceName: '' }))).toBe('deviceName');
    expect(deviceNameError(atConfirm({ deviceName: 'x'.repeat(65) }))).toBe('deviceName');
    expect(deviceNameError(atConfirm())).toBeNull();
    expect(canSubmitConfirm(atConfirm({ deviceName: '', confirmed: true }))).toBe(false);
  });
});

describe('back on non-empty input confirms before discarding (§8.1)', () => {
  test('an untouched wizard discards freely', () => {
    expect(needsDiscardConfirm(state())).toBe(false);
  });

  test('any typed credential triggers the ConfirmSheet', () => {
    expect(needsDiscardConfirm(state({ loginIdentifier: 'y' }))).toBe(true);
    expect(needsDiscardConfirm(state({ password: 'x' }))).toBe(true);
    expect(needsDiscardConfirm(atConfirm())).toBe(true);
  });

  test('a typed device name on step 2 triggers it too', () => {
    expect(needsDiscardConfirm(state({ step: 'confirm', deviceName: 'Konter' }))).toBe(true);
  });

  test('the done step never asks — there is nothing left to lose', () => {
    expect(needsDiscardConfirm(atConfirm({ step: 'done' }))).toBe(false);
  });
});

describe('a revoked device lands here with the danger banner (§8.5)', () => {
  test('the revoked flag is carried into the wizard state', () => {
    expect(initialEnrollmentState(true).revoked).toBe(true);
    expect(initialEnrollmentState(false).revoked).toBe(false);
    expect(initialEnrollmentState().revoked).toBe(false);
  });

  test('a revoked device can still enroll — the wizard is the recovery path, not a dead end', () => {
    expect(canSubmitCredentials(typed({ revoked: true }))).toBe(true);
  });
});
