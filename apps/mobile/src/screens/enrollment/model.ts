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
 * `auth.enroll.needsConnection` ("Pendaftaran perangkat butuh koneksi internet.") — and this is its
 * only use in v0. Saying it here is honest; saying it anywhere else would be the lie §4 forbids.
 *
 * ── AND WHY STEP 2 EXISTS AT ALL ────────────────────────────────────────────────────────────────
 * §8.5: "wrong-store enrollment is the likely user error — make it visible". An owner with three
 * stores sees three near-identical names on a 5-inch screen in the sun. Binding is irreversible in
 * practice (§7.4: re-enrollment means a fresh keypair and a fresh deviceId — an operator round
 * trip). So the confirmation is not a checkbox on the login screen; it is a whole step whose only
 * job is showing the tenant and store big enough to read, and whose primary button is the act of
 * agreeing. `confirmed` gates the request — see `canSubmitConfirm`.
 */

/** api/02-auth §4.2's `LoginReq` bounds. Mirrored client-side so a bad field never leaves the device. */
export const LOGIN_IDENTIFIER_MAX = 64;
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

/** §4.3's `EnrollReq` bound. */
export const DEVICE_NAME_MAX = 64;

/** The three steps, rendered as "1/3" in the header (§3.10). */
export type EnrollmentStep = 'credentials' | 'confirm' | 'done';

/** A store the logged-in owner may bind this device to (§4.2 `LoginRes.stores`). */
export interface StoreChoice {
  readonly id: string;
  readonly name: string;
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
  /** Transport — the only sanctioned "you need internet" in the app. */
  | { readonly kind: 'offline' }
  /** Anything else, keyed by DomainError code (07-i18n §4.2). */
  | { readonly kind: 'unexpected'; readonly code: string };

/** The label key each failure renders. Keys only. */
export function failureKey(failure: EnrollmentFailure): string {
  switch (failure.kind) {
    case 'credentials':
      return 'core.errors.NOT_AUTHENTICATED';
    case 'rateLimited':
      return 'core.errors.RATE_LIMITED';
    case 'notPermitted':
      return 'core.errors.PERMISSION_DENIED';
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
  /** §8.5: the device is bound only after this is explicitly true. */
  readonly confirmed: boolean;
  readonly busy: boolean;
  readonly failure: EnrollmentFailure | null;
  /** §8.5: a `revoked` device lands here with the danger banner. */
  readonly revoked: boolean;
}

export function initialEnrollmentState(revoked = false): EnrollmentState {
  return {
    step: 'credentials',
    loginIdentifier: '',
    password: '',
    deviceName: '',
    login: null,
    selectedStoreId: null,
    confirmed: false,
    busy: false,
    failure: null,
    revoked,
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
 * Step 2's primary button — the act of binding. Requires a store, a device name, AND the explicit
 * confirmation (§8.5). `confirmed` is a separate input rather than "they pressed the button": the
 * button IS the confirmation, so the screen sets `confirmed` when the user ticks the tenant/store
 * summary, and the button only lights up once they have.
 */
export function canSubmitConfirm(state: EnrollmentState): boolean {
  return (
    !state.busy &&
    state.login !== null &&
    state.selectedStoreId !== null &&
    state.confirmed &&
    deviceNameError(state) === null
  );
}

/** The tenant + store the user is about to bind to — what step 2 puts on screen, big. */
export function bindingSummary(
  state: EnrollmentState,
): { readonly tenantName: string; readonly storeName: string } | null {
  if (state.login === null || state.selectedStoreId === null) return null;
  const store = state.login.stores.find((candidate) => candidate.id === state.selectedStoreId);
  if (store === undefined) return null;
  return { tenantName: state.login.tenantName, storeName: store.name };
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
