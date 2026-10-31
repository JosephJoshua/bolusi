/**
 * The Device Enrollment wizard (design-system §8.5/§3.10; api/02-auth §4).
 *
 * ── WHAT THIS MOMENT IS ─────────────────────────────────────────────────────────────────────────
 * One-time, high-stakes, probably supervised, and the ONLY flow in this offline-first app that
 * genuinely requires a connection (§4.1: "Preconditions: … and online"). Either it works, or the
 * device is a brick. Nobody here can read a stack trace, and the person holding the phone may be the
 * shop owner doing this once, ever.
 *
 * So the design question is not "what does success look like" — it is WHAT DOES FAILURE LOOK LIKE TO
 * SOMEONE WHO CANNOT DEBUG IT. Every failure leg is therefore sorted into exactly one of three
 * buckets, because those are the only three actions a human can take:
 *
 *   fixable BY YOU     → `credentials`  : you typed something wrong. Try again. (401)
 *   fixable BY WAITING → `rateLimited`  : too many tries. Here is the countdown. (429)
 *   fixable BY SOMEONE ELSE → `notPermitted` : this account may not enroll devices. Get the owner. (403)
 *   fixable BY A CONNECTION → `offline`  : this one step needs internet. (transport)
 *
 * A single "enrollment failed" error would collapse all four, and the user would try the only thing
 * they know — retype the password — which fixes exactly one of them and burns the rate limit on
 * another. The buckets ARE the design.
 *
 * ── THE ONE PLACE "NO CONNECTION" IS ALLOWED TO BLOCK ───────────────────────────────────────────
 * design-system §4 rule 2 says no flow may fail because of the network, and that rule is absolute
 * for COMMANDS. Enrollment is not a command: there is no local device identity to write yet, so
 * there is nothing to be optimistic with. The catalog anticipates this exactly once —
 * `auth.enroll.needsConnection` ("Belum ada internet. Sambungkan dulu, lalu coba lagi.") — and this is its
 * only use in v0. Saying it here is honest; saying it anywhere else would be the lie §4 forbids.
 *
 * ── AND WHY STEP 2 EXISTS AT ALL ────────────────────────────────────────────────────────────────
 * §8.5: "wrong-store enrollment is the likely user error — make it visible". An owner with three
 * stores sees three near-identical names on a 5-inch screen in the sun. Binding is irreversible in
 * practice (§7.4: re-enrollment means a fresh keypair and a fresh deviceId — an operator round
 * trip). So the confirmation is not a checkbox on the login screen; it is a whole step where the
 * store is picked from a list that shows which one is chosen, and whose ONE primary button names
 * that store ("Daftarkan ke Toko Utama"). Pressing it is the agreement. A separate "Ya, lanjutkan"
 * toggle above a "Masuk" button used to stand in for this, and read as two competing actions
 * (first Android QA run).
 */

import type { HeldPhone } from '@bolusi/core';

/** api/02-auth §4.2's `LoginReq` bounds. Mirrored client-side so a bad field never leaves the device. */
export const LOGIN_IDENTIFIER_MAX = 64;
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

/** §4.3's `EnrollReq` bound. */
export const DEVICE_NAME_MAX = 64;

/** The three steps, counted "1 dari 3" in the step header (§3.10). */
export type EnrollmentStep = 'credentials' | 'confirm' | 'done';

/** A store the logged-in owner may bind this device to (§4.2 `LoginRes.stores`). */
export interface StoreChoice {
  readonly id: string;
  readonly name: string;
  /** Who a phone here may be set up for as their own: the signed-in owner first, then staff with a
   *  PIN. Empty from an older server, which only sets up shared phones. */
  readonly people?: readonly { readonly id: string; readonly name: string }[];
}

/** What `POST /v1/auth/login` returns (§4.2), trimmed to what the wizard renders. */
export interface LoginResult {
  readonly controlSession: string;
  readonly tenantId: string;
  readonly tenantName: string;
  readonly user: { readonly id: string; readonly name: string };
  readonly stores: readonly StoreChoice[];
}

/**
 * A failure the wizard can render. Each maps to ONE action a human can take — see the header.
 * `code` keys the catalog; nothing here ever renders a raw server string.
 */
export type EnrollmentFailure =
  /** 401 — one generic message. Never "wrong password" vs "no such user": §4.2 makes them
   *  indistinguishable on purpose (no user enumeration), and copy that guessed would leak what the
   *  API deliberately hides. */
  | { readonly kind: 'credentials' }
  /** 429 — with §9's `retryAfterSeconds`, rendered as a countdown. */
  | { readonly kind: 'rateLimited'; readonly retryAfterSeconds: number }
  /** 403 — the account exists and the password was right; it just may not enroll devices. */
  | { readonly kind: 'notPermitted' }
  /** This phone holds another store's data, and this account may not enrol into that store. */
  | { readonly kind: 'otherStore' }
  /** Transport — the only sanctioned "you need internet" in the app. */
  | { readonly kind: 'offline' }
  /** Anything else, keyed by DomainError code (07-i18n §4.2). */
  | { readonly kind: 'unexpected'; readonly code: string };

/** The label key each failure renders. Keys only. */
export function failureKey(failure: EnrollmentFailure): string {
  switch (failure.kind) {
    case 'credentials':
      return 'auth.enroll.wrongCredentials';
    case 'rateLimited':
      return 'core.errors.RATE_LIMITED';
    case 'notPermitted':
      return 'auth.enroll.notOwner';
    case 'otherStore':
      return 'auth.enroll.otherStore';
    case 'offline':
      return 'auth.enroll.needsConnection';
    case 'unexpected':
      return `core.errors.${failure.code}`;
  }
}

/** The wizard's whole state. Plain data — the screen renders it, the tests drive it. */
export interface EnrollmentState {
  readonly step: EnrollmentStep;
  readonly loginIdentifier: string;
  readonly password: string;
  readonly deviceName: string;
  /** Set after a successful login; carries the tenant/store choices step 2 confirms. */
  readonly login: LoginResult | null;
  readonly selectedStoreId: string | null;
  /** Whose own phone this is; null (the default) for one the store shares. */
  readonly personalUserId: string | null;
  readonly busy: boolean;
  readonly failure: EnrollmentFailure | null;
  /** §8.5: a `revoked` device lands here with the danger banner. */
  readonly revoked: boolean;
  /**
   * What this phone already holds when it is being enrolled AGAIN: its store, which it may only be
   * re-enrolled into, and the unsynced changes the owner reviews before they are carried over.
   * Null on a new phone (and until it has been read).
   */
  readonly phone: HeldPhone | null;
}

export function initialEnrollmentState(revoked = false): EnrollmentState {
  return {
    step: 'credentials',
    loginIdentifier: '',
    password: '',
    deviceName: '',
    login: null,
    selectedStoreId: null,
    personalUserId: null,
    busy: false,
    failure: null,
    revoked,
    phone: null,
  };
}

/**
 * Client-side validation, mirroring §4.2's `LoginReq` bounds.
 *
 * WHY IT MIRRORS THE SERVER RATHER THAN TRUSTING IT: a request that cannot possibly succeed must
 * never be sent. It costs a round trip the device may not have, and — the part that matters — it
 * spends a slot against §9's rate limit. A user who types a 4-character password three times and
 * gets rate-limited has been punished by the client for the client's own laziness.
 */
export function credentialsError(state: EnrollmentState): 'identifier' | 'password' | null {
  const identifier = state.loginIdentifier.trim();
  if (identifier.length < 1 || identifier.length > LOGIN_IDENTIFIER_MAX) return 'identifier';
  if (state.password.length < PASSWORD_MIN || state.password.length > PASSWORD_MAX) {
    return 'password';
  }
  return null;
}

/** Step 1's primary button. False ⇒ NO request is fired (see `credentialsError`). */
export function canSubmitCredentials(state: EnrollmentState): boolean {
  return !state.busy && credentialsError(state) === null;
}

/** §4.3's `deviceName` bound, checked before the enroll POST. */
export function deviceNameError(state: EnrollmentState): 'deviceName' | null {
  const name = state.deviceName.trim();
  if (name.length < 1 || name.length > DEVICE_NAME_MAX) return 'deviceName';
  return null;
}

/**
 * What step 2's primary button is still waiting for, said above it while it is disabled: a store
 * first (it is what the button names), then a device name. Null when the device can be bound.
 */
export function confirmMissing(state: EnrollmentState): 'store' | 'deviceName' | null {
  if (state.login === null || bindingSummary(state) === null) return 'store';
  if (deviceNameError(state) !== null) return 'deviceName';
  return null;
}

/** Step 2's primary button — the act of binding to the store it names (§8.5). */
export function canSubmitConfirm(state: EnrollmentState): boolean {
  return !state.busy && confirmMissing(state) === null;
}

/**
 * The store this device binds to: the one picked, or the account's only store, which needs no
 * picking (the one-store screen shows it in a box with nothing to tap).
 */
export function chosenStoreId(state: EnrollmentState): string | null {
  if (state.selectedStoreId !== null) return state.selectedStoreId;
  const stores = state.login?.stores ?? [];
  return stores.length === 1 ? (stores[0]?.id ?? null) : null;
}

/**
 * Who a phone at the chosen store may be set up for as their own (permission-scoped sync): it then
 * holds what that person may see, and only they sign in on it. The signed-in owner comes first.
 * Empty before a store is chosen, and from an older server.
 */
export function personalChoices(
  state: EnrollmentState,
): readonly { readonly id: string; readonly name: string }[] {
  const storeId = chosenStoreId(state);
  return state.login?.stores.find((store) => store.id === storeId)?.people ?? [];
}

/**
 * Whose own phone this becomes: the person picked, if the chosen store still offers them (picking
 * another store can drop them), else null, a phone the store shares.
 */
export function chosenPersonalUserId(state: EnrollmentState): string | null {
  const picked = state.personalUserId;
  if (picked === null) return null;
  return personalChoices(state).some((person) => person.id === picked) ? picked : null;
}

/** The tenant + store the user is about to bind to — what step 2 puts on screen, big. */
export function bindingSummary(
  state: EnrollmentState,
): { readonly tenantName: string; readonly storeName: string } | null {
  const storeId = chosenStoreId(state);
  if (state.login === null || storeId === null) return null;
  const store = state.login.stores.find((candidate) => candidate.id === storeId);
  if (store === undefined) return null;
  return { tenantName: state.login.tenantName, storeName: store.name };
}

/**
 * Step 1's answer. The server lists only the stores this account may enroll a phone into, so an
 * empty list is a non-owner: refused here, on the sign-in step, not after they named the phone.
 */
export function afterLogin(state: EnrollmentState, login: LoginResult): EnrollmentState {
  if (login.stores.length === 0) {
    return { ...state, busy: false, failure: { kind: 'notPermitted' } };
  }
  // A phone holding a store's data goes back to that store only: its records belong there. The
  // choice narrows to it, so step 2 states it instead of offering a list.
  if (state.phone !== null) {
    const home = login.stores.find((store) => store.id === state.phone?.storeId);
    if (home === undefined) return { ...state, busy: false, failure: { kind: 'otherStore' } };
    return {
      ...state,
      busy: false,
      login: { ...login, stores: [home] },
      step: 'confirm',
      selectedStoreId: home.id,
    };
  }
  return {
    ...state,
    busy: false,
    login,
    step: 'confirm',
    selectedStoreId:
      login.stores.length === 1 ? (login.stores[0]?.id ?? null) : state.selectedStoreId,
  };
}

/**
 * §8.1: a back press on non-empty input confirms via ConfirmSheet before discarding.
 *
 * "Non-empty" is measured on what the user TYPED, not on what the wizard fetched: re-typing a
 * password is the cost this guards, and a login result is free to re-fetch. On step 2 the typed
 * device name counts for the same reason.
 */
export function needsDiscardConfirm(state: EnrollmentState): boolean {
  if (state.step === 'done') return false;
  return (
    state.loginIdentifier.trim().length > 0 ||
    state.password.length > 0 ||
    state.deviceName.trim().length > 0
  );
}

/** Map a transport/server error onto the four buckets. Unknown shapes fall through to `unexpected`. */
export function classifyFailure(error: unknown): EnrollmentFailure {
  const status = readNumber(error, 'status');
  const code = readString(error, 'code');

  if (status === 401 || code === 'AUTH_INVALID_CREDENTIALS') return { kind: 'credentials' };
  if (status === 429 || code === 'RATE_LIMITED') {
    // §9 supplies `retryAfterSeconds`; default to 0 rather than guessing a duration — a countdown
    // the server did not authorize is a made-up promise.
    return { kind: 'rateLimited', retryAfterSeconds: readNumber(error, 'retryAfterSeconds') ?? 0 };
  }
  if (status === 403 || code === 'PERMISSION_DENIED' || code === 'ACTING_USER_INVALID') {
    return { kind: 'notPermitted' };
  }
  if (code === 'NETWORK' || isTransportError(error)) return { kind: 'offline' };
  return { kind: 'unexpected', code: code ?? 'UNEXPECTED' };
}

function readNumber(error: unknown, key: string): number | undefined {
  const value = (error as Record<string, unknown> | null)?.[key];
  return typeof value === 'number' ? value : undefined;
}

function readString(error: unknown, key: string): string | undefined {
  const value = (error as Record<string, unknown> | null)?.[key];
  return typeof value === 'string' ? value : undefined;
}

/** A thrown TypeError/`fetch` failure with no HTTP status is a transport failure. */
function isTransportError(error: unknown): boolean {
  return error instanceof Error && readNumber(error, 'status') === undefined;
}
