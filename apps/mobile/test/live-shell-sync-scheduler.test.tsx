/**
 * THE COMPOSED-APP TEST for task 136 — does a local append actually schedule a sync on a device?
 *
 * ── WHAT WAS BROKEN, AND WHY NOTHING NOTICED ────────────────────────────────────────────────────
 * `apps/mobile/index.ts` bound `syncScheduler: { schedule: () => undefined }` into
 * `createAppEnrollment`. That object became the app's ONE `AppRuntime` — reused by the session
 * controller and by every notes command, not just by enrollment — so `execute.ts`'s step-7
 * `this.#syncScheduler.schedule()` (04 §5.1) called a no-op after EVERY local append, forever, and
 * api/01-sync §5 (b)'s "debounced 3 s after any local append" did not exist in production. The real
 * implementation was already built and had ZERO production consumers: `createSyncTriggers(...)
 * .scheduler`, in a file whose own header says "**WIRED**".
 *
 * Both halves were reproduced before the fix, and the second one is the reason this file exists:
 *   - making `triggers.ts`'s real `scheduler.schedule()` throw → 5 tests red, ALL of them in
 *     `src/bootstrap/triggers.test.ts` (one literally titled "schedule() never throws … step 7").
 *     `sync-client.test.ts`, `bootstrap.test.ts` and `live-shell-notes.test.tsx` stayed green.
 *   - making the PRODUCTION binding in `index.ts` throw → **67 files / 629 tests passed, EXIT=0.**
 *     Nothing imports `index.ts`, so the shipping wiring was unguarded by construction.
 *
 * ── SO THIS FILE MOUNTS `Root` WITH A REAL `SyncClient` ─────────────────────────────────────────
 * Every live-shell test before this one mounted with NO `createSync` at all — the app's sync wiring
 * was never in the picture, which is exactly how the no-op survived. Here the composition root gets
 * a REAL `createSyncClient` (real `SyncLoop`, real `createSyncTriggers`, real push/pull phases over
 * the real database) and the note is created by TAPPING THE REAL EDITOR. The only fakes are the wire
 * (a scripted transport, zero sockets) and time (a virtual `TimerPort`, so the 3 s window is measured
 * rather than slept through — T-6).
 *
 * ── WHAT MAKES THIS MORE THAN "SOMETHING HAPPENED" ──────────────────────────────────────────────
 * The assertion is not "a timer was armed" — it is that the note the user just typed reaches the
 * push leg of a sync cycle, and that TWO notes typed inside one window reach it in ONE cycle. That
 * second arm is the positive control that separates "debounced" from "fired per append": a scheduler
 * wired straight through (no debounce) pushes twice, an unbound one pushes never, and only a real
 * debounce pushes once carrying both.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/** The native modules `Root`'s import graph reaches — doubled exactly as `live-shell-notes` does. */
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

import type {
  PullRequest,
  PullResponse,
  PushRequest,
  PushResponse,
  SignedOperation,
} from '@bolusi/schemas';
import { noblePort } from '@bolusi/test-support';
import * as SecureStore from 'expo-secure-store';

import type { RootProps } from '../src/bootstrap/Root.js';
import { createSyncClient, type SyncClient } from '../src/bootstrap/sync-client.js';
import { APPEND_DEBOUNCE_MS, type NetInfoPort } from '../src/bootstrap/triggers.js';
import {
  bootFixture,
  closeClientDb,
  enrolledDevice,
  fakeAppState,
  fireOn,
  mountRoot,
  seedDirectory,
  settle,
  submitPin,
  TEST_PIN,
  virtualTimer,
  waitUntil,
  type Fixture,
  type VirtualTimer,
} from './live-shell-support.js';
import { fire, type RenderResult } from '../../../packages/ui/test/render.js';

const SERVER_TIME = 1_726_000_000_000;

/**
 * A scripted transport, zero sockets. It ACCEPTS every op it is handed (echoing a `serverSeq`), so
 * a pushed op is marked synced and does not ride the next cycle — which is what makes
 * `pushes.length` a faithful count of "cycles that carried new local work".
 */
class FakeTransport {
  readonly pushes: PushRequest[] = [];
  readonly pulls: PullRequest[] = [];
  private serverSeq = 0;

  push(request: PushRequest): Promise<PushResponse> {
    this.pushes.push(request);
    return Promise.resolve({
      results: request.ops.map((op) => ({
        id: op.id,
        status: 'accepted' as const,
        serverSeq: (this.serverSeq += 1),
      })),
      serverTime: SERVER_TIME,
    });
  }

  pull(request: PullRequest): Promise<PullResponse> {
    this.pulls.push(request);
    return Promise.resolve({
      ops: [],
      nextCursor: request.cursor,
      hasMore: false,
      serverTime: SERVER_TIME,
    });
  }

  /** Every op id this transport was ever handed, flattened — the "did it reach the wire" oracle. */
  pushedOpTypes(): readonly string[] {
    return this.pushes.flatMap((request) => request.ops.map((op: SignedOperation) => op.type));
  }
}

/**
 * A NetInfo port that reports OFFLINE and never changes.
 *
 * Deliberate: trigger (a) fires `requestSync('connectivity')` on a transition INTO connectivity,
 * including the boot reading, so an "online" fake would drive cycles this file must not attribute to
 * the append trigger. Offline leaves the APPEND trigger as the only driver inside the window this
 * test advances, and `isOffline` is a UI input only — the loop still runs when triggered.
 */
const offlineNetInfo: NetInfoPort = {
  subscribe(listener) {
    listener(false);
    return () => undefined;
  },
};

interface Harness {
  readonly transport: FakeTransport;
  readonly timer: VirtualTimer;
  /** The client `Root` actually constructed — captured so the test can await its cycles. */
  client(): SyncClient;
  readonly createSync: RootProps['createSync'];
}

function syncHarness(): Harness {
  const transport = new FakeTransport();
  const timer = virtualTimer();
  let built: SyncClient | null = null;
  return {
    transport,
    timer,
    client: () => {
      if (built === null) throw new Error('Root never called createSync — no client was composed');
      return built;
    },
    createSync: (booted) => {
      if (booted.deviceId === null) return null;
      built = createSyncClient({
        db: booted.db,
        deviceId: booted.deviceId,
        transport,
        // 304 — the steady state; the bundle is not what this file measures.
        bundle: { refresh: () => Promise.resolve('unchanged') },
        applyPulledOp: (op) => booted.engine.applyPulledOp(op),
        crypto: noblePort,
        clock: { now: () => SERVER_TIME },
        timer,
        appState: fakeAppState(),
        netInfo: offlineNetInfo,
        initialSyncState: booted.syncState,
      });
      return built;
    },
  };
}

/** Move virtual time and let the cycle it may have triggered settle. */
async function advance(harness: Harness, ms: number): Promise<void> {
  await act(async () => {
    harness.timer.advance(ms);
  });
  await act(async () => {
    await harness.client().settle();
  });
  await settle();
}

/** Type a note in the REAL editor and save it — the same taps a mechanic makes (§5.1 step 1→7). */
async function createNoteThroughTheUI(
  screen: RenderResult,
  fixture: Fixture,
  title: string,
): Promise<void> {
  const before = await localOpCount(fixture);
  fireOn(screen, 'notes.list.create');
  await settle();
  fire(screen.get('notes.editor.title.field'), 'onChangeText', title);
  fire(screen.get('notes.editor.save'), 'onPress');
  // The save is OPTIMISTIC (fire-and-return), so wait on GROUND TRUTH — the op row landing in
  // `operations`. Step 7 runs in the same continuation as that commit, so once the row is visible
  // the schedule has been made. Polling here moves REAL time only; the virtual timer stands still,
  // which is what lets two notes land inside one debounce window.
  const landed = await waitUntil(async () => (await localOpCount(fixture)) > before);
  expect(landed, `the note "${title}" never reached the operations table`).toBe(true);
  await settle();
}

/** How many `notes.note_created` ops this device has appended locally. */
async function localOpCount(fixture: Fixture): Promise<number> {
  const rows = await fixture.app.db.db
    .selectFrom('operations')
    .select('id')
    .where('type', '=', 'notes.note_created')
    .execute();
  return rows.length;
}

/** Reach the notes list through the REAL switcher + PIN, then drain the session ops' own debounce. */
async function unlockAndDrain(fixture: Fixture, harness: Harness): Promise<RenderResult> {
  const screen = await mountRoot(fixture, { createSync: harness.createSync });
  fireOn(screen, `switcher-user-${fixture.userId}`);
  await settle();
  const opened = await submitPin(screen, TEST_PIN);
  expect(opened).toBe(true);
  // The unlock itself appends `auth.user_switched` (a sanctioned runtime emission, 04 §5.1) and so
  // arms its OWN debounce. Drain it here so every cycle counted below is attributable to a note.
  await advance(harness, APPEND_DEBOUNCE_MS);
  return screen;
}

let tempDir: string;
let secureStore: Map<string, string>;
let fixture: Fixture | null = null;

beforeEach(async () => {
  await closeClientDb();
  tempDir = mkdtempSync(join(tmpdir(), 'bolusi-live-shell-sync-'));
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

describe('the LIVE app schedules a debounced sync after a local append (task 136; 04 §5.1 step 7)', () => {
  test('THE REPRODUCTION, STANDING: a note created in the app is pushed after the debounce, and not before', async () => {
    fixture = await bootFixture();
    await enrolledDevice(fixture);
    await seedDirectory(fixture);

    const harness = syncHarness();
    const screen = await unlockAndDrain(fixture, harness);

    // THE DENOMINATOR (T-14). Everything the unlock scheduled has already fired, so any cycle from
    // here is the note's. Without this the assertions below could be satisfied by the session ops.
    const cyclesBefore = harness.transport.pulls.length;
    const pushesBefore = harness.transport.pushes.length;

    await createNoteThroughTheUI(screen, fixture, 'Ganti LCD');

    // (1) NOT BEFORE THE WINDOW. A scheduler wired straight through — schedule() → requestSync() with
    //     no debounce — would already have run a cycle here, which is the api/01-sync §5 (b) breach
    //     this arm exists to catch.
    await advance(harness, APPEND_DEBOUNCE_MS - 1);
    expect(harness.transport.pulls.length, 'a sync ran BEFORE the 3 s debounce elapsed').toBe(
      cyclesBefore,
    );

    // (2) AND AT THE WINDOW. One cycle, and it carries the op the user just typed — the whole point:
    //     "a sync was scheduled" is only meaningful if the append actually reaches the wire.
    await advance(harness, 1);
    expect(harness.transport.pulls.length).toBe(cyclesBefore + 1);
    expect(harness.transport.pushes.length).toBe(pushesBefore + 1);
    expect(harness.transport.pushedOpTypes()).toContain('notes.note_created');
  });

  test('POSITIVE CONTROL: two appends inside one window COALESCE into ONE sync — and a later one still fires', async () => {
    // This is what separates "the scheduler is bound" from "the DEBOUNCE is bound". An unbound
    // scheduler pushes nothing; a straight-through one pushes twice; only a real debounce pushes
    // once, carrying both ops. The second half is the control against a debounce that never re-arms
    // (T-14b) — without it, a `schedule()` that silently dropped everything after the first would
    // satisfy the coalescing assertion.
    fixture = await bootFixture();
    await enrolledDevice(fixture);
    await seedDirectory(fixture);

    const harness = syncHarness();
    const screen = await unlockAndDrain(fixture, harness);
    const pushesBefore = harness.transport.pushes.length;
    // The idle timer population (the 60 s foreground interval, and nothing else) — the denominator
    // for the re-arm assertion below.
    const armedBefore = harness.timer.pending();

    // Two notes, no virtual time in between ⇒ both land inside the SAME 3 s window.
    await createNoteThroughTheUI(screen, fixture, 'Ganti baterai');
    await createNoteThroughTheUI(screen, fixture, 'Ganti konektor');
    expect(await localOpCount(fixture)).toBe(2); // both really were appended

    // THE RE-ARM, MEASURED AT THE TRIGGER. Two appends have left exactly ONE pending debounce,
    // because `schedule()` cancels the previous timer before arming a new one. Asserted here and not
    // only through the transport because the LOOP coalesces too (03 §10's rerun flag is a flag, not a
    // counter) — so a scheduler that QUEUED a timer per append would still reach the wire once, and
    // the wire-level assertion alone could not tell the two apart.
    expect(
      harness.timer.pending(),
      'each append armed its own timer — that is a queue, not a debounce',
    ).toBe(armedBefore + 1);

    await advance(harness, APPEND_DEBOUNCE_MS);
    expect(harness.transport.pushes.length, '40 appends must not schedule 40 cycles').toBe(
      pushesBefore + 1,
    );
    const coalesced = harness.transport.pushes[pushesBefore];
    expect(coalesced?.ops.filter((op) => op.type === 'notes.note_created').length).toBe(2);

    // A THIRD note, in its own window, fires its own cycle.
    await createNoteThroughTheUI(screen, fixture, 'Ganti speaker');
    await advance(harness, APPEND_DEBOUNCE_MS);
    expect(harness.transport.pushes.length).toBe(pushesBefore + 2);
    const second = harness.transport.pushes[pushesBefore + 1];
    expect(second?.ops.filter((op) => op.type === 'notes.note_created').length).toBe(1);
  });

  test('POSITIVE CONTROL: no append, no sync — the debounce is the only driver in this window', async () => {
    // The arm that keeps the two above honest. If ANY cycle ran on its own inside a 3 s window (a
    // stray interval, a connectivity trigger, a client that syncs on every render), the counts above
    // would be satisfied by something other than the append and this file would prove nothing.
    fixture = await bootFixture();
    await enrolledDevice(fixture);
    await seedDirectory(fixture);

    const harness = syncHarness();
    await unlockAndDrain(fixture, harness);
    const cyclesBefore = harness.transport.pulls.length;

    await advance(harness, APPEND_DEBOUNCE_MS * 2);

    expect(harness.transport.pulls.length).toBe(cyclesBefore);
  });
});
