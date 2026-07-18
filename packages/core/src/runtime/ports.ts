// The command runtime's injected effect seams (08-stack-and-repo §3.2; testing-guide T-6).
//
// @bolusi/core is PLATFORM-FREE: it owns no clock, no rng, no GPS, no timer, no network. Every
// effect the 04 §5.1 sequence needs arrives here as an interface, bound by the app (mobile),
// the harness, or a test. That is what makes the whole runtime constructible from a FakeClock +
// seeded IdSource and byte-stable per seed (T-6) — the seam every CHAOS scenario's simulator
// needs (testing-guide §3.3).
//
// WHY THE CLOCK IS A PORT AND NOT AN IMPORT. 04 §5.2 gives handlers NO clock: the runtime stamps
// `timestamp` once per command. If the runtime reached `Date.now()` directly, "once per command"
// would be a property of the call sites rather than of the design, a handler could reach the same
// global, and no test could pin the stamp without mocking a global. Injected at construction, the
// stamp point is a single place and the tests own time.
import type { Location } from '@bolusi/schemas';

/**
 * ms-epoch clock (08 §3.2 `ClockPort`). Production binds the system clock; tests bind a FakeClock
 * (testing-guide §3.3). The ONLY clock the command runtime may read — 04 §5.2's "no `Date.now()`
 * in handlers" is enforced by `bolusi/no-clock-in-handlers` plus the purity guard suite.
 */
export interface ClockPort {
  /** Integer ms since the unix epoch. */
  now(): number;
}

/**
 * Best-available position (08 §3.2 `LocationPort`), stamped onto every op's `location` (05 §2.1).
 *
 * **NON-BLOCKING BY CONTRACT.** It returns the best fix it already has, or `null`; it never waits
 * on GPS and the runtime never retries or polls it (04 §5.1 step 4: "null never blocks",
 * PRD-009 FR-802). A cached fix up to 60 s old is acceptable — freshness is the adapter's
 * business, not the runtime's. Synchronous precisely so that "never blocks" is structural: an
 * async signature would invite an adapter to await a fix and silently make every command wait on
 * a cold GPS chip.
 */
export interface LocationPort {
  getBestFix(): Location | null;
}

/**
 * The debounced sync-schedule hook (04 §5.1 step 7). The real loop — debounce window, backoff,
 * triggers — is task 15 (api/01-sync §5/§6); this is the seam it plugs into.
 *
 * Fire-and-forget by contract: step 7 runs AFTER the local append committed, and a locally
 * durable op is already a successful command. Sync scheduling must never fail a command, and the
 * runtime must never wait on it (offline-first — the whole point is the command succeeded).
 */
export interface SyncSchedulerPort {
  schedule(): void;
}

/**
 * A one-shot delay scheduler (08 §3.2; testing-guide T-6). The runtime uses it to BOUND an await
 * that would otherwise hang forever — today, the denial-audit emit on the deny path (task 40): a
 * never-settling client op-append (a stuck op-sqlite WAL lock) must not wedge `execute()`.
 *
 * WHY A PORT, AND WHY ITS OWN ONE. @bolusi/core owns no timers (08 §3.3 rule 3): a bare `setTimeout`
 * here would be untestable without sleeping (T-6) and is trapped by the purity suite
 * (test/runtime/_purity.ts). So the effect arrives as an interface, exactly as `ClockPort` does.
 *
 * This is the SAME SHAPE as the sync loop's `TimerPort` (sync/ports.ts) — deliberately, and by
 * INTERFACE SEGREGATION, not duplication (§2.8 forbids two IMPLEMENTATIONS of one logic; a port
 * carries none). It is declared HERE rather than reused from `sync` because `sync` depends on this
 * layer (`sync/ports.ts` imports `ClockPort` from this file), never the reverse — the runtime must
 * not reach up into the loop for a foundational effect. One production binding satisfies both: the
 * app's `setTimeout`-backed `systemTimer` (apps/mobile) drops into this slot with no new code, the
 * way `SigningKeyPort` and `KeyStorePort` share one impl above.
 */
export interface RuntimeTimerPort {
  /**
   * Run `fn` after `delayMs`. Returns a canceller; calling it after `fn` fired is a no-op (so the
   * happy path — the emit resolved first — cancels the pending timeout and leaks nothing).
   */
  schedule(delayMs: number, fn: () => void): () => void;
}

/**
 * UUIDv7 source (05 §2.1 `id`/`entityId`; 08 §2.3). Backs `ctx.newId()`.
 *
 * Injected rather than imported so tests get a seeded, FakeClock-driven source (T-6) and ids —
 * and therefore canonical ordering — reproduce bit-for-bit per seed. `createUuidV7Generator`
 * (../ids/uuidv7.ts) is the production implementation over the clock + a CSPRNG.
 */
export type IdSource = () => string;

/**
 * The device's Ed25519 signing key, for the op signature (05 §2.2).
 *
 * **The command runtime's SEGREGATED view of the key store — keep it; do NOT collapse it.** This is
 * the one method the runtime needs to sign an op. Task 14's real `KeyStorePort` (08 §3.2:
 * SecureStore-backed `bolusi.device_private_key`, plus enroll/token/wipe) STRUCTURALLY satisfies this
 * one-method shape, so the production adapter and the test `FakeKeyStore` drop in with no call-site
 * change — and so does a bare `{ getSigningKey }`, which is how the runtime tests build the seam.
 *
 * This is interface segregation, not duplication. §2.8 forbids two IMPLEMENTATIONS of the same logic;
 * `SigningKeyPort` carries NO logic and has exactly one impl (`KeyStorePort`). Typing
 * `CommandRuntime.signingKey` as the full `KeyStorePort` would drag enrollment/token/wipe concerns
 * into the command runtime and force every runtime test to build a 6-method fake. (Task 14 landed and
 * correctly did NOT delete this — an earlier "DELETE WHEN TASK 14 LANDS" note here was wrong.)
 */
export interface SigningKeyPort {
  /** The device's 32-byte RFC 8032 seed. */
  getSigningKey(): Uint8Array;
}
