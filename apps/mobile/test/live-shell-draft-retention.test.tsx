/**
 * THE COMPOSED-APP TEST for task 155 — does the idle-lock work-retention path finally have a
 * PRODUCER, so a half-typed note survives a lock on a real device?
 *
 * ── WHAT TASK 133 SHIPPED, AND WHAT IT DISCLOSED ────────────────────────────────────────────────
 * Task 133 wired the retention PATH: `updateWorkspace` → `SessionManager.saveWork(userId, …)`,
 * restored by the SAME user's unlock through `restoreWorkspace`'s owner check. It then said so in its
 * own header — NOTHING wrote into it. `NoteEditor` kept its in-flight title/body/mediaRef in local
 * `useState`, no screen fed `updateWorkspace`, and `live-shell-idle-lock.test.tsx` could only drive
 * the path by calling `controller.updateWorkspace(...)` from the test itself. So the composed proof
 * that the lock preserved the work a USER actually typed did not exist. This file is that proof.
 *
 * ── SO IT DRIVES THE EDITOR, NOT THE CONTROLLER ─────────────────────────────────────────────────
 * A test that calls `controller.updateWorkspace(...)` is the one that already existed and was green
 * before this task — it tests the map, not the wiring. This one boots the REAL data layer, unlocks a
 * REAL session through the REAL PIN pad, opens the REAL editor, types into the REAL `onChangeText`,
 * advances the clock past the tenant's `idleLockSeconds`, lets the REAL ticker lock the shell, and
 * unlocks. Every link between a keystroke and a restored draft has to work, because every link is
 * what was absent (T-7). The fakes are the clock, the timer and `AppState` — the three things a test
 * must drive rather than wait for (T-6) — and the native boot side-effects Node cannot load.
 *
 * ── THE PRIVACY CONTROL IS THE POINT, NOT A NICETY (SEC-AUTH-08) ────────────────────────────────
 * A transient null identity is a LOCK, not a switch (task 130's `CaptureHost` established the phrase
 * for the capture surface). `A → null → A` must hand A back their draft; `A → null → B` must land B
 * on B's OWN home with none of A's work reachable. Restoring A's draft into B's session would be a
 * PRIVACY defect, not a UX bug — the same class rev-130 caught in the capture host. `live-shell`
 * seeds TWO real users with real argon2id verifiers via `applyBundle`, so B's unlock is a real verify
 * against a real second verifier and the cross-user assertion is a fact about the running app.
 *
 * ── WHAT THIS LANE CANNOT ANSWER ────────────────────────────────────────────────────────────────
 * `test-renderer` over RN doubles under Node. It proves the COMPOSITION — given the signals, the app
 * retains, locks and restores per user. It does not prove Android delivers the `AppState` transition,
 * nor anything after process death. Those are D12/D13's standing ceiling, stated so a green is not
 * over-read.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// The native modules `Root`'s import graph reaches — doubled exactly as the other live-shell files do.
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

import { fire, textsIn, type RenderResult } from '../../../packages/ui/test/render.js';
import type { AppSessionController } from '../src/bootstrap/session.js';
import {
  advanceableClock,
  bootFixture,
  closeClientDb,
  enrolledDevice,
  fakeAppState,
  fireCreateNote,
  fireOn,
  manualTimer,
  mountRoot,
  seedDirectory,
  seedTwoUsers,
  settle,
  submitPin,
  waitUntil,
  SECOND_USER_ID,
  TEST_PIN,
  type Fixture,
} from './live-shell-support.js';

/** The §6.4 FLOOR (not the 300 s default) — a lock at 61 s also proves the tenant value threaded. */
const TENANT_IDLE_SECONDS = 60;

/** The half-typed repair note the retention path exists to protect — user A's work. */
const DRAFT_A = 'ganti LCD iPhone 11 — nunggu konfirmasi harga';

let tempDir: string;
let secureStore: Map<string, string>;
let fixture: Fixture | null = null;

beforeEach(async () => {
  await closeClientDb();
  tempDir = mkdtempSync(join(tmpdir(), 'bolusi-draft-retention-'));
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
  readonly controller: AppSessionController;
}

/** Boot an enrolled device, seed it (one or two users), and mount the LIVE `Root`. */
async function liveShell(
  target: Fixture,
  seed: (f: Fixture, idle: number) => Promise<void>,
): Promise<Harness> {
  await enrolledDevice(target);
  await seed(target, TENANT_IDLE_SECONDS);

  const clock = advanceableClock();
  const timer = manualTimer();
  let controller: AppSessionController | null = null;
  const screen = await mountRoot(target, {
    clock,
    timer,
    appState: fakeAppState(),
    onSessionController: (c) => {
      controller = c;
    },
  });
  if (controller === null) throw new Error('Root composed no session controller');
  return { screen, clock, timer, controller };
}

/** Tap a user on the (lock or choose) switcher and unlock with the real PIN. Returns success. */
async function unlockAs(harness: Harness, userId: string): Promise<boolean> {
  fireOn(harness.screen, `switcher-user-${userId}`);
  await settle();
  expect(harness.screen.query('pin-pad')).not.toBeNull();
  return submitPin(harness.screen, TEST_PIN);
}

/** Open the create editor from the notes list. */
async function openCreateEditor(harness: Harness): Promise<void> {
  fireCreateNote(harness.screen);
  await settle();
  expect(harness.screen.query('notes.editor.title')).not.toBeNull();
}

/** Type into the body through the REAL `onChangeText` the RN field fires, then let retention settle. */
async function typeBody(harness: Harness, text: string): Promise<void> {
  fire(harness.screen.get('notes.editor.body.field'), 'onChangeText', text);
  await settle();
}

/** Advance past the deadline and run one idle tick, the way the foregrounded app does. */
async function idleLock(harness: Harness): Promise<void> {
  harness.clock.advance((TENANT_IDLE_SECONDS + 1) * 1000);
  await act(async () => {
    harness.timer.fire();
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
  });
}

/** The current value of the editor body field, or null when no editor is mounted. */
function bodyValue(harness: Harness): string | null {
  const field = harness.screen.query('notes.editor.body.field');
  return field === null ? null : ((field.props['value'] as string | undefined) ?? null);
}

/** Navigate to the §8.4 Sync Status route the way a user does — the always-present header sync chip. */
async function openSyncStatus(harness: Harness): Promise<void> {
  fire(harness.screen.get('ui.syncChip'), 'onPress');
  await settle();
  await waitUntil(() => harness.screen.query('sync-status-screen') !== null);
  await settle();
}

describe('SEC-AUTH-08 — a typed draft survives the idle lock and the SAME user restores it (task 155)', () => {
  test('THE CORE CASE: type → idle lock → same user unlocks → the body is STILL THERE', async () => {
    fixture = await bootFixture();
    const harness = await liveShell(fixture, seedDirectory);
    const { screen, controller } = harness;

    expect(await unlockAs(harness, fixture.userId)).toBe(true);
    await openCreateEditor(harness);
    await typeBody(harness, DRAFT_A);

    // DENOMINATOR (T-14): the WRITE actually reached retention BEFORE any lock. Without a producer
    // this is empty and the restore below could never be more than a vacuous pass. The draft is keyed
    // under the notes module id and owned by the signed-in user.
    const beforeLock = controller.snapshot().workspace;
    expect(beforeLock?.ownerUserId).toBe(fixture.userId);
    expect((beforeLock?.drafts['notes'] as { body?: string } | undefined)?.body).toBe(DRAFT_A);
    expect(bodyValue(harness)).toBe(DRAFT_A);

    await idleLock(harness);

    // The lock fired: the shell is the LOCK screen, the editor is gone, and the shell exposes NO
    // workspace while locked (the read side reads null, never a stale draft behind the lock).
    expect(controller.snapshot().locked).toBe(true);
    expect(screen.query('switcher-lock-banner')).not.toBeNull();
    expect(screen.query('notes.editor.title')).toBeNull();
    expect(controller.snapshot().workspace).toBeNull();

    expect(await unlockAs(harness, fixture.userId)).toBe(true);
    // The surface remounts; wait for the editor (the notes runtime rebuild on unlock is async).
    await waitUntil(() => screen.query('notes.editor.title') !== null);

    // THE WHOLE OF THE TASK: the editor is back, in create mode, with the exact body typed before the
    // lock — restored from retention, not re-derived. `ownerUserId` witnesses it is the same user's.
    expect(screen.query('notes.editor.title')).not.toBeNull();
    expect(bodyValue(harness)).toBe(DRAFT_A);
    expect(controller.snapshot().workspace?.ownerUserId).toBe(fixture.userId);
  });

  test('POSITIVE CONTROL: an EMPTY editor retains nothing and restores no spurious editor', async () => {
    // The arm that stops "always restores" from passing vacuously. Opening the editor and typing
    // nothing must leave NO empty-draft artifact, so the unlock lands on the LIST, not a blank editor.
    fixture = await bootFixture();
    const harness = await liveShell(fixture, seedDirectory);
    const { screen, controller } = harness;

    expect(await unlockAs(harness, fixture.userId)).toBe(true);
    await openCreateEditor(harness);
    await settle();

    // Nothing typed ⇒ nothing retained (a clean editor publishes `null`, never an empty draft).
    expect(controller.snapshot().workspace?.drafts['notes'] ?? null).toBeNull();

    await idleLock(harness);
    expect(controller.snapshot().locked).toBe(true);

    expect(await unlockAs(harness, fixture.userId)).toBe(true);
    await waitUntil(() => screen.query('notes.list.title') !== null);

    // Back on the list — no editor was restored, and no draft was invented.
    expect(screen.query('notes.list.title')).not.toBeNull();
    expect(screen.query('notes.editor.title')).toBeNull();
    expect(controller.snapshot().workspace?.drafts['notes'] ?? null).toBeNull();
  });
});

describe('SEC-AUTH-08 PRIVACY — a different user must NOT inherit the outgoing user`s draft (task 155)', () => {
  test('THE PRIVACY CONTROL: A types a draft → idle lock → USER B unlocks → B sees NO draft and lands on their own home', async () => {
    fixture = await bootFixture();
    const target = fixture;
    const harness = await liveShell(target, seedTwoUsers);
    const { screen, controller } = harness;

    // ── USER A leaves a half-typed note ─────────────────────────────────────────────────────────
    expect(await unlockAs(harness, target.userId)).toBe(true);
    await openCreateEditor(harness);
    await typeBody(harness, DRAFT_A);
    // Denominator: A's draft is genuinely retained under A before the lock — so a failure below is
    // "B inherited it", not "it was never there".
    expect(controller.snapshot().workspace?.ownerUserId).toBe(target.userId);
    expect((controller.snapshot().workspace?.drafts['notes'] as { body?: string }).body).toBe(
      DRAFT_A,
    );

    await idleLock(harness);
    expect(controller.snapshot().locked).toBe(true);
    expect(screen.query('switcher-lock-banner')).not.toBeNull();

    // ── USER B unlocks on the shared terminal ───────────────────────────────────────────────────
    expect(await unlockAs(harness, SECOND_USER_ID)).toBe(true);
    await waitUntil(() => screen.query('notes.list.title') !== null);

    // 1. B LANDS ON THEIR OWN HOME — the notes list, not A's open editor.
    expect(screen.query('notes.list.title')).not.toBeNull();
    expect(screen.query('notes.editor.title')).toBeNull();

    // 2. B's SESSION IS B's, AND CARRIES NONE OF A's WORK. The restored workspace belongs to B and
    //    holds no notes draft — `restoreWorkspace`'s owner check + task 14's per-user key mean A's
    //    saved work is never even handed to B's unlock (traced to the producer, T-16).
    const bWorkspace = controller.snapshot().workspace;
    expect(bWorkspace?.ownerUserId).toBe(SECOND_USER_ID);
    expect(bWorkspace?.drafts['notes'] ?? null).toBeNull();

    // 3. A's DRAFT TEXT IS NOWHERE ON B's SCREEN. The strongest statement of the privacy property —
    //    not just "no editor" but "A's bytes do not appear anywhere in the rendered tree".
    expect(textsIn(screen.container).some((s) => s.includes(DRAFT_A))).toBe(false);
  });

  test('AND THE ORIGINAL OWNER STILL GETS IT BACK: after B, user A unlocks and sees their OWN draft', async () => {
    // The other half of "transient null is a lock, not a switch": B intervening must not have
    // destroyed A's retained work. A's key still holds A's draft, so A's next unlock restores it.
    fixture = await bootFixture();
    const target = fixture;
    const harness = await liveShell(target, seedTwoUsers);
    const { screen, controller } = harness;

    expect(await unlockAs(harness, target.userId)).toBe(true);
    await openCreateEditor(harness);
    await typeBody(harness, DRAFT_A);
    await idleLock(harness);

    // B unlocks (empty), then re-locks by going idle.
    expect(await unlockAs(harness, SECOND_USER_ID)).toBe(true);
    await waitUntil(() => screen.query('notes.list.title') !== null);
    await idleLock(harness);
    expect(controller.snapshot().locked).toBe(true);

    // A unlocks: their draft is intact, untouched by B's session in between.
    expect(await unlockAs(harness, target.userId)).toBe(true);
    await waitUntil(() => screen.query('notes.editor.title') !== null);
    expect(bodyValue(harness)).toBe(DRAFT_A);
    expect(controller.snapshot().workspace?.ownerUserId).toBe(target.userId);
  });
});

describe('SEC-AUTH-08 ROUTE — the shell route is retained per user across the idle lock (task 155)', () => {
  // WHY THIS SUITE EXISTS SEPARATELY FROM THE DRAFT ONES. The draft lives in task 14's per-user map,
  // which UNMOUNTS with the notes surface on a lock — so no App-owned state carries a draft across a
  // lock. The ROUTE is the one thing that does: `App`'s `route` is React state and `App` does NOT
  // unmount across a lock (only the ZONE swaps to the switcher), so absent a correction the shell
  // simply keeps whatever route was showing and hands it to whoever unlocks next. The guard is the
  // `routeOwner` correction (App.tsx: `setRoute(workspace?.route ?? 'home')` on a user change). This
  // suite is the producer that watches it — the task's FALSIFY line required "the route restored",
  // and rev-155 confirmed deleting that line left the whole 686-test lane green.

  test('SAME USER: A on Sync Status → idle lock → A unlocks → the route is RESTORED (not home)', async () => {
    fixture = await bootFixture();
    const harness = await liveShell(fixture, seedDirectory);
    const { screen, controller } = harness;

    expect(await unlockAs(harness, fixture.userId)).toBe(true);
    await openSyncStatus(harness);
    // DENOMINATOR: A really is off `home` — on the Sync Status surface, and the notes list is gone.
    expect(screen.query('sync-status-screen')).not.toBeNull();
    expect(screen.query('notes.list.title')).toBeNull();
    // The route was retained under A (consuming task 133's `withRoute`).
    expect(controller.snapshot().workspace?.route).toBe('syncStatus');

    await idleLock(harness);
    expect(controller.snapshot().locked).toBe(true);
    expect(screen.query('sync-status-screen')).toBeNull(); // the lock screen replaces it

    expect(await unlockAs(harness, fixture.userId)).toBe(true);
    await waitUntil(() => screen.query('sync-status-screen') !== null);

    // A lands back on Sync Status — the lock was invisible to their position, not a bounce to home.
    // (This arm PASSES with or without the guard: A's route persisted across the non-unmounting App
    // anyway. It is the positive half the task required; the guard is falsified by the NEXT test.)
    expect(screen.query('sync-status-screen')).not.toBeNull();
    expect(screen.query('notes.list.title')).toBeNull();
  });

  test('THE ROUTE PRIVACY CONTROL: A on Sync Status → idle lock → USER B unlocks → B lands on their OWN home, NOT A`s route', async () => {
    fixture = await bootFixture();
    const target = fixture;
    const harness = await liveShell(target, seedTwoUsers);
    const { screen, controller } = harness;

    // A parks on a non-home route and it is retained under A.
    expect(await unlockAs(harness, target.userId)).toBe(true);
    await openSyncStatus(harness);
    expect(controller.snapshot().workspace?.route).toBe('syncStatus');

    await idleLock(harness);
    expect(controller.snapshot().locked).toBe(true);

    // B unlocks on the shared terminal.
    expect(await unlockAs(harness, SECOND_USER_ID)).toBe(true);

    // B MUST NOT inherit A's Sync Status position. This is the assertion that reds when the
    // `routeOwner` correction is removed: `route` persisted across the lock as `syncStatus`, and
    // without the correction B renders A's Sync Status surface instead of their own home.
    await waitUntil(() => screen.query('notes.list.title') !== null);
    expect(screen.query('sync-status-screen')).toBeNull();
    expect(screen.query('notes.list.title')).not.toBeNull();
    // B's retained route is their own `home`, never A's.
    expect(controller.snapshot().workspace?.route).toBe('home');
    expect(controller.snapshot().workspace?.ownerUserId).toBe(SECOND_USER_ID);
  });
});
