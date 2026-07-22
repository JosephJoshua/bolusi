/**
 * THE COMPOSED-APP TEST for task 133 — does SEC-AUTH-08's idle lock actually FIRE in the running app?
 *
 * ── WHAT WAS BROKEN, AND WHY NOTHING NOTICED ────────────────────────────────────────────────────
 * `ShellSession` (the lock's UI half) shipped with EIGHT green tests and zero production callers.
 * `SessionManager.checkIdle()` — the lock DECISION — had none either. `Root` passed `locked={false}`
 * as a literal, so the gate's third input was a constant. And `bootstrap/session.ts` constructed
 * `SessionManager` WITHOUT `idleLockSeconds`, so a tenant that tightened the timeout to 60 s got the
 * 300 s default on every device and never knew. Reproduced before the fix: making `ShellSession.tick`
 * throw reddened `src/session/shell-session.test.ts` (8 tests, including the two titled
 * `SEC-AUTH-08 — a lock preserves work…`) and NOTHING else in a 63-file, 575-test suite.
 *
 * ── SO THIS FILE MOUNTS `Root` AND MOVES A CLOCK ────────────────────────────────────────────────
 * A test that constructed a `ShellSession` and called `tick()` would have been GREEN BEFORE THE FIX
 * — that is precisely the test that already existed. What was missing is a producer, so this drives
 * the composition root: boot the REAL data layer, apply a REAL bundle carrying `idleLockSeconds: 60`,
 * unlock through the REAL `verifyPin`, advance the clock, and let the REAL ticker call through to
 * 14's `checkIdle`. Every link has to work, because every link is what was absent.
 *
 * ── THE 60 s IS LOAD-BEARING, NOT A CONVENIENT NUMBER ───────────────────────────────────────────
 * §6.4's default is 300 s and its floor is 60 s. The bundle seeds 60; the tests lock at 61 s. If the
 * `idleLockSeconds` threading regressed — the second half of this defect — the manager would fall
 * back to 300 and nothing would lock at 61 s. So the SAME assertion that proves the tick runs also
 * proves the tenant's value reached the device. There is no arrangement of these tests that passes
 * with either half missing.
 *
 * ── EVERYTHING BELOW THE SEAM IS REAL (T-7) ─────────────────────────────────────────────────────
 * Real `bootstrap()` over better-sqlite3, real migrations, real `applyBundle`, real argon2id
 * verifier, real `verifyPin`, real `SessionManager`, real `ShellSession`, real command runtime and
 * op log (the `session_ended(idle_lock)` op is asserted in the `auth_sessions` PROJECTION, not in a
 * spy). The clock, the timer and `AppState` are fakes, because those are the three things a test
 * must drive rather than wait for (T-6).
 *
 * ── WHAT THIS LANE CANNOT ANSWER — read before trusting a green ─────────────────────────────────
 * This is `test-renderer` over RN doubles under Node. It does NOT prove that Android delivers the
 * `AppState` `active` transition on every real resume path, that a JS interval survives Doze, or
 * that anything at all happens after process death. It proves the COMPOSITION: given the signals,
 * the app locks, retains, and unlocks. The device legs are D12/D13's standing ceiling.
 *
 * ── FOUND BUT NOT FIXED — the draft this file writes has no SCREEN producer yet ─────────────────
 * The retention PATH is live and round-trips through 14's per-user map, which is what these tests
 * drive. What does NOT exist is a screen that writes into it: `NoteEditor` holds its in-flight text
 * in its own `useState`, so on a real device an idle lock still discards a half-typed note. Closing
 * that needs a draft seam on `NoteEditor` (@bolusi/modules, contended) plus a prop on `App`, both
 * owned by other queued tasks — so it is stated here, not implied away. §6.4 is explicit that a lock
 * which loses work is a lock somebody disables.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// The native modules `Root`'s import graph reaches — doubled exactly as `live-shell-notes.test.tsx`
// does, and for the same reason: they are boot side-effects incidental to what this file measures.
vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  setItemAsync: vi.fn(async () => undefined),
  getItemAsync: vi.fn(async () => null),
  deleteItemAsync: vi.fn(async () => undefined),
}));

vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));

vi.mock('expo-notifications', () => ({
  AndroidImportance: { HIGH: 4, DEFAULT: 3, LOW: 2, MIN: 1 },
  setNotificationChannelAsync: vi.fn(async () => undefined),
  getNotificationChannelsAsync: vi.fn(async () => []),
}));

vi.mock('expo-location', () => ({
  Accuracy: { Balanced: 3 },
  requestForegroundPermissionsAsync: vi.fn(async () => ({ status: 'denied' })),
  getForegroundPermissionsAsync: vi.fn(async () => ({ status: 'denied' })),
  watchPositionAsync: vi.fn(async () => ({ remove: () => undefined })),
}));

import * as SecureStore from 'expo-secure-store';
import { sql } from 'kysely';

import { emptyWorkspace, withDraft, type UserWorkspace } from '../src/state/user-workspaces.js';
import type { AppSessionController } from '../src/bootstrap/session.js';
import {
  advanceableClock,
  bootFixture,
  closeClientDb,
  enrolledDevice,
  fakeAppState,
  fireOn,
  manualTimer,
  mountRoot,
  seedDirectory,
  settle,
  submitPin,
  TEST_PIN,
  type Fixture,
} from './live-shell-support.js';
import type { RenderResult } from '../../../packages/ui/test/render.js';

/** The §6.4 FLOOR, deliberately not the 300 s default — see the header. */
const TENANT_IDLE_SECONDS = 60;

/** The half-typed repair note SEC-AUTH-08 exists to protect. */
const DRAFT_BODY = 'ganti LCD iPhone 11 — belum selesai';

let tempDir: string;
let secureStore: Map<string, string>;
let fixture: Fixture | null = null;

beforeEach(async () => {
  await closeClientDb();
  tempDir = mkdtempSync(join(tmpdir(), 'bolusi-idle-lock-'));
  secureStore = new Map<string, string>();
  vi.clearAllMocks();
  vi.mocked(SecureStore.getItemAsync).mockImplementation(
    async (key: string) => secureStore.get(key) ?? null,
  );
  vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key: string, value: string) => {
    secureStore.set(key, value);
  });
  vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key: string) => {
    secureStore.delete(key);
  });
});

afterEach(async () => {
  await fixture?.close();
  fixture = null;
  await closeClientDb();
  rmSync(tempDir, { recursive: true, force: true });
});

interface Harness {
  readonly screen: RenderResult;
  readonly clock: ReturnType<typeof advanceableClock>;
  readonly timer: ReturnType<typeof manualTimer>;
  readonly appState: ReturnType<typeof fakeAppState>;
  readonly controller: AppSessionController;
}

/** Boot an enrolled device whose tenant configured `idleLockSeconds`, and mount the LIVE `Root`. */
async function liveShell(target: Fixture): Promise<Harness> {
  await enrolledDevice(target);
  await seedDirectory(target, TENANT_IDLE_SECONDS);

  const clock = advanceableClock();
  const timer = manualTimer();
  const appState = fakeAppState();
  let controller: AppSessionController | null = null;
  const screen = await mountRoot(target, {
    clock,
    timer,
    appState,
    onSessionController: (c) => {
      controller = c;
    },
  });
  if (controller === null) throw new Error('Root composed no session controller');
  return { screen, clock, timer, appState, controller };
}

/** Sign in through the REAL PIN pad, then leave a draft in the retained workspace. */
async function signInWithDraft(harness: Harness, target: Fixture): Promise<UserWorkspace> {
  fireOn(harness.screen, `switcher-user-${target.userId}`);
  await settle();
  const opened = await submitPin(harness.screen, TEST_PIN);
  expect(opened).toBe(true);

  const workspace = withDraft(emptyWorkspace(target.userId), 'notes', { body: DRAFT_BODY });
  act(() => harness.controller.updateWorkspace(workspace));
  await settle();
  expect(harness.controller.snapshot().workspace).toEqual(workspace);
  return workspace;
}

/** Run one idle tick the way the foregrounded app does, and let the tree settle. */
async function tickOnce(harness: Harness): Promise<void> {
  await act(async () => {
    harness.timer.fire();
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
  });
}

/** How many sessions this device ended with `reason: 'idle_lock'`, from the REAL projection. */
async function idleLockRows(target: Fixture): Promise<number> {
  const result = await sql<{ n: number }>`
    SELECT COUNT(*) AS n FROM auth_sessions WHERE end_reason = 'idle_lock'
  `.execute(target.app.db.db);
  return Number(result.rows[0]?.n ?? 0);
}

describe('SEC-AUTH-08 — the idle lock FIRES on the live shell (api/02-auth §6.4; task 133)', () => {
  test('THE REPRODUCTION, STANDING: idle past the tenant`s idleLockSeconds locks the shell, keeps the work, and PIN unlocks', async () => {
    fixture = await bootFixture();
    const harness = await liveShell(fixture);
    const { screen, clock, controller } = harness;
    const saved = await signInWithDraft(harness, fixture);

    // The shell is open on the notes surface — the denominator (T-14). Without this the lock
    // assertions below could pass against a shell that never opened in the first place.
    expect(screen.query('notes.list.title')).not.toBeNull();
    expect(controller.snapshot().locked).toBe(false);
    expect(await idleLockRows(fixture)).toBe(0);

    // ── POSITIVE CONTROL: one second BELOW the deadline, a tick must change nothing ──────────────
    // This is what lets the test distinguish "the lock fired because the deadline passed" from
    // "anything that ticks locks". Without it, a `tick()` hardcoded to lock would pass everything.
    clock.advance((TENANT_IDLE_SECONDS - 1) * 1000);
    await tickOnce(harness);
    expect(controller.snapshot().locked).toBe(false);
    expect(screen.query('notes.list.title')).not.toBeNull();
    expect(screen.query('switcher-lock-banner')).toBeNull();

    // ── PAST THE DEADLINE ───────────────────────────────────────────────────────────────────────
    // 61 s total. Note what this number means: if `idleLockSeconds` had NOT been threaded from the
    // bundle, `SessionManager` would hold §6.4's 300 s default and this tick would be a no-op.
    clock.advance(2000);
    await tickOnce(harness);

    // 1. THE GATE MOVED. `locked` is derived, so the switcher renders as the LOCK (§8.2): the lock
    //    banner is up and there is NO header back — a back control here would walk straight into the
    //    previous user's session, which is why its absence is the security assertion, not a detail.
    expect(controller.snapshot().locked).toBe(true);
    expect(controller.snapshot().lockReason).toBe('idle_lock');
    expect(controller.snapshot().session).toBeNull();
    expect(screen.query('switcher-screen')).not.toBeNull();
    expect(screen.query('switcher-lock-banner')).not.toBeNull();
    expect(screen.query('switcher-screen.back')).toBeNull();
    expect(screen.query('notes.list.title')).toBeNull();

    // 2. THE OP IS REAL. `session_ended(idle_lock)` went through the REAL command runtime into the
    //    REAL op log and folded into the `auth_sessions` projection. A spy would have proven that a
    //    function was called; this proves the durable, signed record §6.3 requires exists.
    expect(await idleLockRows(fixture)).toBe(1);

    // 3. THE WORK IS NOT EXPOSED WHILE LOCKED. The shell publishes no workspace at all behind the
    //    lock screen — that is what a consumer (App, and every future module surface) reads.
    //
    //    DELIBERATELY NOT ALSO ASSERTED ON THE RENDERED TREE. A `textsIn(...).some(...)` check for
    //    DRAFT_BODY here would be green no matter what the code did, because NO screen renders a
    //    workspace draft yet (see the "found but not fixed" note below). A guard whose failure mode
    //    is "silently checks nothing" is worse than no guard (CLAUDE.md §2.11), so it is absent
    //    rather than decorative — and belongs with the task that ships the draft producer.
    expect(controller.snapshot().workspace).toBeNull();

    // ── UNLOCK THROUGH THE EXISTING `onSubmitPin` SEAM ──────────────────────────────────────────
    fireOn(screen, `switcher-user-${fixture.userId}`);
    await settle();
    expect(screen.query('pin-pad')).not.toBeNull();
    expect(await submitPin(screen, TEST_PIN)).toBe(true);

    // 4. THE LOCK IS OVER AND THE WORK CAME BACK — EXACTLY, and for its owner. This is the whole of
    //    SEC-AUTH-08: a lock that lost this would be raised to its 3600 s ceiling by the shop.
    expect(controller.snapshot().locked).toBe(false);
    expect(controller.snapshot().lockReason).toBeNull();
    expect(controller.snapshot().workspace).toEqual(saved);
    expect(controller.snapshot().workspace?.ownerUserId).toBe(fixture.userId);
    expect(screen.query('notes.list.title')).not.toBeNull();
  });

  test('interaction resets the deadline — a user who is working is not locked out mid-note', async () => {
    // §6.4: "any interaction resets the idle deadline". The producer is `Root`'s responder-capture
    // wrapper, which is why this drives the RENDERED node rather than calling `recordActivity`
    // directly: calling the controller would test the controller, and the controller was never the
    // part that was missing.
    fixture = await bootFixture();
    const harness = await liveShell(fixture);
    const { screen, clock, controller } = harness;
    await signInWithDraft(harness, fixture);

    for (let round = 0; round < 3; round += 1) {
      clock.advance((TENANT_IDLE_SECONDS - 1) * 1000);
      // A touch anywhere in the app. It must DECLINE the responder (`false`) — a capture handler
      // that returned true would swallow every tap in the product to run a bookkeeping call.
      const shouldCapture = screen.get('root-activity').props[
        'onStartShouldSetResponderCapture'
      ] as () => boolean;
      act(() => {
        expect(shouldCapture()).toBe(false);
      });
      await tickOnce(harness);
      expect(controller.snapshot().locked).toBe(false);
    }

    // Nearly three full timeouts of wall time have passed and nothing locked, because none of it was
    // IDLE. Now stop touching: one more period and it locks.
    clock.advance((TENANT_IDLE_SECONDS + 1) * 1000);
    await tickOnce(harness);
    expect(controller.snapshot().locked).toBe(true);
    expect(screen.query('switcher-lock-banner')).not.toBeNull();
  });

  test('a RESUME from the background locks at once — not one interval later', async () => {
    // The likeliest real lock: the phone goes face-down on the counter. A JS interval is throttled
    // or stopped while backgrounded (and killed by Doze), so a ticker that only counted intervals
    // would hand the next person an open session. `createIdleTicker` checks on the `active`
    // transition, BEFORE re-arming — this drives that path with the timer never firing at all.
    fixture = await bootFixture();
    const harness = await liveShell(fixture);
    const { screen, clock, timer, appState, controller } = harness;
    await signInWithDraft(harness, fixture);

    act(() => appState.set('background'));
    await settle();
    // Backgrounded: the interval is disarmed, so nothing is pending to fire.
    expect(timer.pending()).toBe(0);

    clock.advance((TENANT_IDLE_SECONDS + 1) * 1000);
    expect(controller.snapshot().locked).toBe(false); // nothing ran while backgrounded

    await act(async () => {
      appState.set('active');
      for (let i = 0; i < 12; i += 1) await Promise.resolve();
    });

    expect(controller.snapshot().locked).toBe(true);
    expect(controller.snapshot().lockReason).toBe('idle_lock');
    expect(screen.query('switcher-lock-banner')).not.toBeNull();
    expect(await idleLockRows(fixture)).toBe(1);
  });

  test('the tick emits ONE session_ended however long the device sits at the lock screen', async () => {
    // The ticker keeps running after the lock. A tick that emitted per fire would spray duplicate
    // ops into an immutable, forever-replicated log for the whole time a shop is closed.
    fixture = await bootFixture();
    const harness = await liveShell(fixture);
    await signInWithDraft(harness, fixture);

    harness.clock.advance((TENANT_IDLE_SECONDS + 1) * 1000);
    for (let i = 0; i < 5; i += 1) {
      harness.clock.advance(10_000);
      await tickOnce(harness);
    }

    expect(harness.controller.snapshot().locked).toBe(true);
    expect(await idleLockRows(fixture)).toBe(1);
  });
});
