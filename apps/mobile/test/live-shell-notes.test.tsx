/**
 * THE COMPOSED-APP TEST for task 119 — are the notes screens reachable in the RUNNING app?
 *
 * ── WHAT WAS BROKEN, AND WHY NOTHING NOTICED ────────────────────────────────────────────────────
 * Task 96 shipped the notes screens, the `NotesRuntime` port and its adapter, all green against a
 * REAL command/query runtime. Every one of those tests mounted a SCREEN and handed it a runtime the
 * test itself had constructed. Not one of them asked the question this file asks: does anything in
 * shipping source construct that runtime? It did not. `Root` passed `session={null}`, `users={null}`
 * and `onSubmitPin={() => undefined}` as literals, and `App.notes` was never given a value — so on a
 * real device the switcher listed nobody, no PIN could open a session, and `home` rendered an empty
 * `View`. The screens were unreachable, and 100% of their tests stayed green (§2.11: "a function with
 * sound tests and zero callers"; the 40→102 / 20→105 shape).
 *
 * ── SO THIS FILE MOUNTS `Root`, NOT `App` ───────────────────────────────────────────────────────
 * That distinction is the whole point. `App` already rendered `NotesHome` correctly when handed a
 * `notes` prop — a test driving `App` directly would have been GREEN BEFORE THIS TASK and would have
 * proven nothing about the defect. `Root` is the composition root, the thing that was actually
 * missing a producer, so the test drives it end to end: boot the REAL data layer, reach the switcher,
 * tap a user, submit a PIN through the REAL `verifyPin`, and assert the notes list renders. The whole
 * chain has to work, because every link in it is what was absent.
 *
 * ── EVERYTHING BELOW THE SEAM IS REAL (T-7) ─────────────────────────────────────────────────────
 * Real `bootstrap()` over better-sqlite3, real client migrations, real `CLIENT_MODULES`, real
 * projection engine + invalidation bus, real `createAppRuntime` (one op store, one enforcement
 * point), real `PermissionEvaluator` over the real directory tables, real argon2id verifier, real
 * `verifyPin`, real `SessionManager`, real notes commands/queries, and the REAL pull path
 * (`engine.applyPulledOp`). The only fakes are the things that cannot exist in Node: SecureStore, the
 * enroll transports (never called — the device is seeded already enrolled), and the media seams.
 *
 * WHAT THIS LANE CANNOT ANSWER: SQLCipher at rest, op-sqlite, and real device rendering — the
 * standing D12/D13 ceiling this repo states everywhere. `test-renderer` over RN doubles is a
 * component tree, not pixels (task 116 is the browser lane, 117 the native one).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * The native modules `Root`'s import graph reaches, doubled here rather than in the lane's config.
 *
 * They are mocked, not aliased globally, because they are incidental to what this file proves: the
 * status bar, the notification channels and the location watcher are boot side-effects, and letting
 * them load would drag in Expo's `__DEV__`-dependent runtime for no assertion's benefit. Everything
 * this test actually measures — the database, the runtime, the evaluator, argon2id, the session, the
 * projection — is REAL below the seam.
 */
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

import {
  bootFixture,
  closeClientDb,
  enrolledDevice,
  fireOn,
  mountRoot,
  NOTE_FROM_ANOTHER_DEVICE,
  pulledNote,
  seedDirectory,
  settle,
  waitForFailedAttempt,
  submitPin,
  TEST_PIN,
  type Fixture,
} from './live-shell-support.js';

let tempDir: string;
let secureStore: Map<string, string>;
let fixture: Fixture | null = null;

beforeEach(async () => {
  await closeClientDb();
  tempDir = mkdtempSync(join(tmpdir(), 'bolusi-live-shell-'));
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

describe('the LIVE shell reaches the notes screens after a PIN unlock (task 119)', () => {
  test('THE REPRODUCTION, STANDING: enrolled device → switcher → PIN → notes list renders', async () => {
    fixture = await bootFixture();
    await enrolledDevice(fixture);
    await seedDirectory(fixture);

    const screen = await mountRoot(fixture);

    // 1. PRE-SESSION. The device is enrolled and nobody is signed in ⇒ the switcher, listing the
    //    seeded user. Before this task `users` was the literal `null`, so this row never existed.
    expect(screen.query('shell-home')).toBeNull();
    expect(screen.query(`switcher-user-${fixture.userId}`)).not.toBeNull();

    // 2. Tap the user ⇒ the PIN pad for that identity.
    fireOn(screen, `switcher-user-${fixture.userId}`);
    await settle();
    expect(screen.query('pin-pad')).not.toBeNull();

    // 3. Submit the CORRECT PIN. This runs the REAL `verifyPin` (argon2id over the real verifier
    //    seeded above) and, on success, the REAL `SessionManager.switchTo`. Before this task
    //    `onSubmitPin` was `() => undefined` and this did nothing at all.
    await submitPin(screen, TEST_PIN);

    // 4. THE ASSERTION THIS TASK EXISTS FOR. A session is open, so the gate resolves to the shell —
    //    and `home` is the NOTES surface, not the empty `View`. `shell-home` is the empty-shell
    //    fallback `App` renders when `notes` is undefined; its ABSENCE is what proves a live
    //    `NotesRuntime` reached the navigator.
    expect(screen.query('notes.list.title')).not.toBeNull();
    expect(screen.query('shell-home')).toBeNull();
  });

  test('a note delivered through the REAL PULL PATH renders on the live shell (04 §7)', async () => {
    // The runtime is not merely mounted — it is LIVE. This drives `engine.applyPulledOp`, the exact
    // seam the sync loop folds a colleague's op through, and asserts the mounted list re-renders.
    // It is the invalidation bus `bootstrap.ts` now exposes that carries it: subscribe to any other
    // bus (or to the engine's old private one) and this row never appears.
    fixture = await bootFixture();
    await enrolledDevice(fixture);
    await seedDirectory(fixture);

    const screen = await mountRoot(fixture);
    fireOn(screen, `switcher-user-${fixture.userId}`);
    await settle();
    await submitPin(screen, TEST_PIN);

    // The list is up and EMPTY — the denominator (T-14). Without this the assertion below could pass
    // against a row that was already there.
    expect(screen.query('notes.list.items.empty')).not.toBeNull();
    expect(screen.query(`notes.list.row.${NOTE_FROM_ANOTHER_DEVICE}`)).toBeNull();

    await act(async () => {
      await fixture!.app.engine.applyPulledOp(pulledNote(fixture!));
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    expect(screen.query(`notes.list.row.${NOTE_FROM_ANOTHER_DEVICE}`)).not.toBeNull();
    expect(screen.query('notes.list.items.empty')).toBeNull();
  });

  test('POSITIVE CONTROL: a WRONG PIN opens no session — the shell stays unreachable', async () => {
    // The arm that makes the two above mean something. If `submitPin` opened a session regardless of
    // the verify result, every assertion in this file would still pass while the app had no
    // authentication at all. The notes surface must be reachable ONLY through a real unlock.
    fixture = await bootFixture();
    await enrolledDevice(fixture);
    await seedDirectory(fixture);

    const screen = await mountRoot(fixture);
    fireOn(screen, `switcher-user-${fixture.userId}`);
    await settle();
    const opened = await submitPin(screen, '000000'); // not TEST_PIN

    // The verify genuinely RAN and genuinely refused — the attempt counter moved. Without this the
    // test would also pass against a submit handler that was never wired (`() => undefined`), which
    // is exactly the state this task fixed.
    expect(await waitForFailedAttempt(fixture)).toBe(1);
    expect(opened).toBe(false);
    expect(screen.query('notes.list.title')).toBeNull();
    expect(screen.query('pin-pad')).not.toBeNull(); // still at the pad, session never opened
  });

  test('POSITIVE CONTROL: an UNENROLLED device still lands on the enrollment wizard, unchanged', async () => {
    // The pre-session path this task must not have disturbed. No deviceId ⇒ no session controller,
    // no notes runtime, and the gate routes to the wizard exactly as it did before task 119.
    fixture = await bootFixture();
    // deliberately NOT `enrolledDevice(fixture)`

    const screen = await mountRoot(fixture);

    expect(screen.query('enrollment-screen')).not.toBeNull();
    expect(screen.query('notes.list.title')).toBeNull();
    expect(screen.query('switcher-screen')).toBeNull();
  });
});
