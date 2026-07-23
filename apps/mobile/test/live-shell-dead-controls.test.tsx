/**
 * THE COMPOSED-APP TEST for task 130 — when a user presses these controls on a real device, does
 * anything run?
 *
 * ── WHY A COMPONENT TEST WOULD PROVE NOTHING HERE, STATED FIRST ─────────────────────────────────
 * Every one of these controls already had a green component test. `SyncStatusScreen.test.tsx` passes
 * `onRetryMedia={vi.fn()}`, presses the chip, and asserts the mock fired. That test passes IDENTICALLY
 * whether the composition root supplies `MediaClient.requestManual` or `noop` — which is exactly what
 * it did, for five controls, for the whole of v0. The mock is the thing under test and the wiring is
 * the thing that was broken, so the assertion and the defect never met.
 *
 * So every test in this file mounts the REAL `Root` with the REAL production factories, navigates by
 * TAPPING, and asserts on a PRODUCER — the media client's own method, the database's own rows, the
 * capture pipeline's own call. The only fakes are the things that cannot exist under Node: the
 * camera, the filesystem, the wire.
 *
 * ── AND WHY THE ROWS HAD TO BECOME REAL FIRST ───────────────────────────────────────────────────
 * `shell-inputs.ts` handed the screen `rejected: []` and `media: []` as literals. A composed test
 * cannot press a row that no input can produce, so "wire the callback" alone would have produced
 * another green that proves nothing. The rows are read from the database now
 * (`bootstrap/sync-status-reads.ts`) and these tests seed them through the SAME writers production
 * uses — core's `markSyncResult` (the one sanctioned op-bookkeeping mutation, 05 §2.3) and core's
 * `markFailed` (the drain's own failure writer).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

import { IDLE_LOCK_DEFAULT_SECONDS, markFailed, type StorageBand } from '@bolusi/core';
import { noblePort } from '@bolusi/test-support';
import type {
  MediaRef,
  PullRequest,
  PullResponse,
  PushRequest,
  PushResponse,
} from '@bolusi/schemas';
import { sql } from 'kysely';
import { act } from 'react';

import type { CameraShot } from '../src/media/capture.js';
import type { CapturePlatform } from '../src/media/CaptureHost.js';
import type { MediaClient, MediaStartReport } from '../src/media/client.js';
import { createSyncClient, type SyncClient } from '../src/bootstrap/sync-client.js';
import type { NetInfoPort } from '../src/bootstrap/triggers.js';
import type { RootProps } from '../src/bootstrap/Root.js';
import {
  bootFixture,
  closeClientDb,
  enrolledDevice,
  fireOn,
  mountRoot,
  seedDirectory,
  settle,
  submitPin,
  TEST_PIN,
  advanceableClock,
  fakeAppState,
  manualTimer,
  seedTwoUsers,
  SECOND_USER_ID,
  virtualTimer,
  waitUntil,
  type Fixture,
  type VirtualTimer,
} from './live-shell-support.js';
import { fire, textsIn, type RenderResult } from '../../../packages/ui/test/render.js';

const MEDIA_ID = '01920000-0000-7000-8000-0000000130a1';

/**
 * A `MediaClient` double that RECORDS rather than simulates.
 *
 * Deliberately not the real client: the real one binds a drain loop, a background task and a
 * filesystem, none of which this file is about. What every test here asks is "did the shell reach the
 * client at all", and the honest oracle for that is the client's own method being entered. The type
 * is the REAL `MediaClient` interface, so a signature change reds this file rather than letting the
 * double drift away from what `Root` actually holds.
 */
interface RecordingMediaClient extends MediaClient {
  /** Every `requestManual()` the shell made — the media-retry oracle. */
  readonly manualRequests: number[];
  /** Every `capturePhoto(identity, camera)` the shell made — the shutter oracle. */
  readonly captureCalls: { readonly identity: { readonly userId: string } }[];
}

function fakeMediaClient(
  options: { readonly band?: StorageBand; readonly shot?: MediaRef } = {},
): RecordingMediaClient {
  const manualRequests: number[] = [];
  const captureCalls: { readonly identity: { readonly userId: string } }[] = [];
  return {
    start: () =>
      Promise.resolve({
        recovered: null,
        background: null,
        prune: null,
      } satisfies MediaStartReport),
    stop: () => undefined,
    // RECORDS FIRST, ALWAYS. An earlier version of this double let a per-test override REPLACE this
    // method, so the scripted outcome silently stopped recording and `captureCalls` stayed empty
    // while the shutter worked perfectly — a false RED, which is the same class of "the oracle was
    // wrong, not the code" this whole task is about. The outcome is a parameter now; the recording
    // is not overridable.
    capturePhoto: (identity) => {
      captureCalls.push({ identity });
      const ref = options.shot;
      if (ref === undefined) return Promise.reject(new Error('no shot scripted for this test'));
      return Promise.resolve({ kind: 'captured', ref, localPath: '/docs/x.jpg', passes: 1 });
    },
    captureSignature: () => Promise.reject(new Error('not used')),
    attach: () => Promise.resolve(),
    loadForRender: () => Promise.resolve({ kind: 'unavailable', code: null }),
    loadLocalForRender: () => Promise.resolve({ kind: 'unavailable', code: null }),
    requestManual: () => {
      manualRequests.push(Date.now());
    },
    prune: () => Promise.resolve(null),
    storageBand: () => options.band ?? 'normal',
    surfacings: () => [],
    settle: () => Promise.resolve(),
    manualRequests,
    captureCalls,
  };
}

let fixture: Fixture;
let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'bolusi-130-'));
  fixture = await bootFixture();
  await enrolledDevice(fixture);
  await seedDirectory(fixture);
});

afterEach(async () => {
  await closeClientDb();
  rmSync(dir, { recursive: true, force: true });
});

/** Sign in with the real PIN and land on the shell — the precondition for every surface below. */
async function signIn(screen: RenderResult): Promise<void> {
  fireOn(screen, `switcher-user-${fixture.userId}`);
  await settle();
  const opened = await submitPin(screen, TEST_PIN);
  expect(opened).toBe(true);
}

/** Navigate to §8.4 the way a user does: the always-present header sync chip. */
async function openSyncStatus(screen: RenderResult): Promise<void> {
  fire(screen.get('ui.syncChip'), 'onPress');
  await settle();
  await waitUntil(() => screen.query('sync-status-screen') !== null);
  await settle();
}

describe('media retry (06 §5.2 (e)) — the row, and the producer behind it', () => {
  test('a failed media row renders a retry chip whose press reaches MediaClient.requestManual()', async () => {
    // Seed one FAILED media row through the drain's own writers. `mediaItems` is written by
    // `insertMediaItem` at capture and moved to `failed` by core's `markFailed` — the same two
    // statements a real drain failure executes, so what the screen reads is a row a device produces.
    await sql`
      INSERT INTO media_items (
        id, tenant_id, store_id, captured_by_user_id, device_id, type, mime_type,
        byte_size, sha256, captured_at, location, local_path, upload_status, attached_to_operation_id
      ) VALUES (
        ${MEDIA_ID}, ${fixture.tenantId}, ${fixture.storeId}, ${fixture.userId}, ${fixture.deviceId},
        'image', 'image/jpeg', 1024, ${'a'.repeat(64)}, 1, NULL, '/tmp/x.jpg', 'pending', 'op-1'
      )
    `.execute(fixture.app.db.db);
    await markFailed(fixture.app.db.db, MEDIA_ID, {
      code: 'NETWORK',
      message: null,
      nextAttemptAt: null,
    });

    const media = fakeMediaClient();
    const screen = await mountRoot(fixture, { createMedia: () => media });
    await signIn(screen);
    await openSyncStatus(screen);

    // The row itself is the first half of the finding: before this task the media queue was fed the
    // literal `[]`, so this node could not exist on any device in any state.
    expect(screen.query(`sync-media-${MEDIA_ID}`)).not.toBeNull();
    expect(media.manualRequests).toHaveLength(0);

    fireOn(screen, `sync-media-retry-${MEDIA_ID}`);
    await settle();

    // THE ASSERTION THAT A COMPONENT TEST CANNOT MAKE: the real client the composition root built
    // was entered. `noop` here — the shipping value until this task — leaves this at 0.
    expect(media.manualRequests).toHaveLength(1);
  });

  test('an ORPHAN capture counts as zero pending and never lists (06 §4 canonical formula)', async () => {
    // Two rows: one ATTACHED-pending (real queued work) and one ORPHAN — captured, command abandoned,
    // `attached_to_operation_id` still NULL. This is not a hypothetical: `CaptureHost.onRetake` leaves
    // exactly such a row for the 24 h pruning pass, so a user who retakes produces orphans on a device
    // where everything is sent. 06 §4: "Orphans do not count. This formula is canonical." The first
    // implementation of this read counted every non-`uploaded` row and reported the orphan as pending,
    // which lit the header chip "Foto Belum Terkirim" on every screen — the exact lie this task removes.
    const ATTACHED = '01920000-0000-7000-8000-0000000130e1';
    const ORPHAN = '01920000-0000-7000-8000-0000000130e2';
    const insert = (id: string, attachedTo: string | null): Promise<unknown> =>
      sql`
      INSERT INTO media_items (
        id, tenant_id, store_id, captured_by_user_id, device_id, type, mime_type,
        byte_size, sha256, captured_at, location, local_path, upload_status, attached_to_operation_id
      ) VALUES (
        ${id}, ${fixture.tenantId}, ${fixture.storeId}, ${fixture.userId}, ${fixture.deviceId},
        'image', 'image/jpeg', 1024, ${'a'.repeat(64)}, 1, NULL, '/tmp/x.jpg', 'pending', ${attachedTo}
      )
    `.execute(fixture.app.db.db);
    await insert(ATTACHED, 'op-attached');
    await insert(ORPHAN, null);

    const screen = await mountRoot(fixture, { createMedia: () => fakeMediaClient() });
    await signIn(screen);
    await openSyncStatus(screen);

    // The counter is core's `pendingMediaCount` (`SELECT … WHERE attached_to_operation_id IS NOT
    // NULL`): exactly ONE, the attached row. Reading the rendered text, not the input, so this is the
    // number a shop owner actually sees. `media.length` (the pre-fix value) would read 2.
    expect(textsIn(screen.get('sync-counter-media')).join(' ')).toContain('1');

    // And the list agrees with the counter — the attached row is there, the orphan is not. A queue
    // that showed a row the counter did not count would promise an upload the drain never makes
    // (`repository.ts` selects on the same `IS NOT NULL`, "load-bearing security, not tidiness").
    expect(screen.query(`sync-media-${ATTACHED}`)).not.toBeNull();
    expect(screen.query(`sync-media-${ORPHAN}`)).toBeNull();
  });
});

/**
 * A server that REJECTS every op it is pushed (05 §8's `SCOPE_VIOLATION`).
 *
 * The rejection reaches the database through the REAL push leg — `markSyncResult`, the one sanctioned
 * op-bookkeeping mutation (05 §2.3) — rather than through a hand-written UPDATE in this file. That
 * matters twice: the row the screen reads is one a real server interaction produces, and the loop's
 * own subscriber is what tells the shell to re-read, which is the production refresh path.
 */
class RejectingTransport {
  static readonly CODE = 'SCOPE_VIOLATION';
  static readonly REASON = 'op store does not match device store';

  push(request: PushRequest): Promise<PushResponse> {
    return Promise.resolve({
      results: request.ops.map((op) => ({
        id: op.id,
        status: 'rejected' as const,
        // The WIRE names are `code`/`reason` (api/01 §3, `zPushResult`) — not the column names.
        // Writing `rejectionCode`/`rejectionReason` here made the push leg fall back to its
        // `?? 'UNKNOWN'` / `?? ''` defaults, and the screen dutifully rendered them: the composed
        // path caught the fake, which is the direction that check is supposed to run in.
        code: RejectingTransport.CODE,
        reason: RejectingTransport.REASON,
      })),
      serverTime: SERVER_TIME,
    });
  }

  pull(request: PullRequest): Promise<PullResponse> {
    return Promise.resolve({
      ops: [],
      nextCursor: request.cursor,
      hasMore: false,
      serverTime: SERVER_TIME,
    });
  }
}

const SERVER_TIME = 1_726_000_000_000;

/** Offline NetInfo: the loop still runs when triggered, but connectivity drives no cycle of its own. */
const offlineNetInfo: NetInfoPort = {
  subscribe(listener) {
    listener(false);
    return () => undefined;
  },
};

describe('rejected operations (05 §2.3 / 06 §8) — surfaced, never silent', () => {
  test('a server-rejected op renders in §8.4 and its tap discloses the server reason', async () => {
    const timer = virtualTimer();
    let client: SyncClient | null = null;
    const createSync: RootProps['createSync'] = (booted) => {
      if (booted.deviceId === null) return null;
      client = createSyncClient({
        db: booted.db,
        deviceId: booted.deviceId,
        transport: new RejectingTransport(),
        bundle: { refresh: () => Promise.resolve('unchanged') },
        applyPulledOp: (op) => booted.engine.applyPulledOp(op),
        crypto: noblePort,
        clock: { now: () => SERVER_TIME },
        timer,
        appState: fakeAppState(),
        netInfo: offlineNetInfo,
        initialSyncState: booted.syncState,
      });
      return client;
    };

    const screen = await mountRoot(fixture, { createSync });
    await signIn(screen);

    // A REAL note, typed into the REAL editor — the op that is about to be refused.
    fireOn(screen, 'notes.list.create');
    await settle();
    fire(screen.get('notes.editor.title.field'), 'onChangeText', 'Ganti LCD');
    await settle();
    fireOn(screen, 'notes.editor.save');
    await settle();

    await openSyncStatus(screen);

    // Press the screen's OWN manual-sync button (§8.4 item 3) rather than poking the client: the
    // push that produces the rejection is then driven by a user action, end to end.
    fireOn(screen, 'sync-now');
    await drainSync(client, timer);

    const opId = await rejectedOpId();
    const shown = await waitUntil(() => screen.query(`sync-rejected-${opId}`) !== null);
    // Half one: the list renders at all. `SyncStatusInput.rejected` was the literal `[]` until this
    // task, so this node could not exist on any device that had ever been refused an op.
    expect(shown, 'the rejected op never reached the sync-status list').toBe(true);
    // Half two: the tap does something. `onOpenRejected` was `noop`, so the chevron was decoration.
    expect(screen.query(`sync-rejected-detail-${opId}`)).toBeNull();

    fireOn(screen, `sync-rejected-${opId}`);
    await settle();

    expect(screen.get(`sync-rejected-reason-${opId}`).props['children']).toBe(
      RejectingTransport.REASON,
    );
    expect(screen.get(`sync-rejected-code-${opId}`).props['children']).toBe(
      RejectingTransport.CODE,
    );

    // A second tap closes it — the only way out of a disclosure with no chrome of its own.
    fireOn(screen, `sync-rejected-${opId}`);
    await settle();
    expect(screen.query(`sync-rejected-detail-${opId}`)).toBeNull();
  });
});

/** Let the triggered cycle finish, then let the shell re-read and re-render. */
async function drainSync(client: SyncClient | null, timer: VirtualTimer): Promise<void> {
  if (client === null) throw new Error('Root never called createSync — no client was composed');
  await act(async () => {
    timer.advance(60_000);
  });
  await act(async () => {
    await client.settle();
  });
  await settle();
}

/** The id of the op the server refused, read from the database the screen reads. */
async function rejectedOpId(): Promise<string> {
  const found = await waitUntil(async () => {
    const rows = await fixture.app.db.db
      .selectFrom('operations')
      .select('id')
      .where('syncStatus', '=', 'rejected')
      .execute();
    return rows.length > 0;
  });
  expect(found, 'the push leg never marked an op rejected').toBe(true);
  const row = await fixture.app.db.db
    .selectFrom('operations')
    .select('id')
    .where('syncStatus', '=', 'rejected')
    .executeTakeFirstOrThrow();
  return row.id ?? '';
}

describe('switcher error retry (design-system §5) — the read that failed, run again', () => {
  test('retry re-runs the directory read and the roster comes back', async () => {
    // Break the directory read for real, and NARROWLY. `listSwitcherUsers` selects
    // `id, name, photo_media_id`; the permission evaluator's `loadDirectorySnapshot` selects only
    // `id, status`. Dropping `photo_media_id` therefore makes the SWITCHER's read throw — exactly as
    // a partially-migrated projection would — while the boot's own directory prime still succeeds.
    // Renaming the whole table (tried first) breaks the evaluator too, which fails the boot before
    // the session controller is ever built: that reproduces a different bug, and a test that cannot
    // reach the surface it is about proves nothing about it.
    await sql`ALTER TABLE users_directory DROP COLUMN photo_media_id`.execute(fixture.app.db.db);

    const screen = await mountRoot(fixture);
    // `mountRoot` CLOSES the client DB and re-boots, so every handle taken before it is dead
    // ("driver has already been destroyed"). Re-read `fixture.app.db.db` after mounting — it is the
    // connection the mounted app is actually using, which is the one a test must manipulate.
    await waitUntil(() => screen.query('switcher-error') !== null);
    await settle();
    expect(screen.query('switcher-error')).not.toBeNull();
    expect(screen.query(`switcher-user-${fixture.userId}`)).toBeNull();

    // Heal the underlying cause, then press RETRY. If the button is `noop` — the shipping value until
    // this task — the roster stays broken forever and this assertion fails on a timeout.
    await sql`ALTER TABLE users_directory ADD COLUMN photo_media_id TEXT`.execute(
      fixture.app.db.db,
    );
    fireOn(screen, 'switcher-error.retry');
    await settle();

    const recovered = await waitUntil(
      () => screen.query(`switcher-user-${fixture.userId}`) !== null,
    );
    expect(recovered).toBe(true);
    expect(screen.query('switcher-error')).toBeNull();
  });
});

describe('the empty roster CTA is REMOVED, not stubbed (design-system §5; owner ruling D23 §3)', () => {
  test('an empty directory renders guidance text and NO pressable create control', async () => {
    // A real empty roster: the device is enrolled, the directory exists, and it lists nobody. Seeded
    // by deactivating the one seeded user through the directory table `listSwitcherUsers` reads
    // (`packages/core/src/auth/repo.ts:412-415`, `WHERE status = 'active'`) — not by handing the
    // screen a fake `[]`, which would prove nothing about what a device reaches.
    await sql`UPDATE users_directory SET status = 'deactivated'`.execute(fixture.app.db.db);

    const screen = await mountRoot(fixture);
    const empty = await waitUntil(() => screen.query('switcher-empty') !== null);
    expect(empty, 'the switcher never reached its §5 Empty state').toBe(true);

    // §5 still requires the Empty state to SAY WHAT TO DO — so the guidance line is present...
    expect(screen.query('switcher-empty.hint')).not.toBeNull();
    // ...and the control that could not work is GONE. `EmptyState` renders its CTA iff `onCreate` is
    // supplied (EmptyState.tsx:56-62), so the absence of this node IS the absence of the affordance.
    // Falsified by restoring `createLabel`/`onCreate` in SwitcherScreen: this line goes red.
    expect(screen.query('switcher-empty.cta')).toBeNull();
  });
});

/** A camera that hands back a fixed frame — the one thing that genuinely cannot exist under Node. */
function fakeCapturePlatform(
  overrides: Partial<CapturePlatform> = {},
): CapturePlatform & { readonly shots: number } {
  let shots = 0;
  const platform: CapturePlatform = {
    ensurePermission: () => Promise.resolve(true),
    // The real one renders `<CameraView onCameraReady=…>`; this publishes immediately, which is the
    // same event ordering (`warming_up` until the camera says it is ready, then `ready`).
    renderPreview: (publish) => {
      queueMicrotask(() =>
        publish({
          takePicture: (): Promise<CameraShot> => {
            shots += 1;
            return Promise.resolve({ uri: 'file:///cache/shot.jpg', width: 1600, height: 1200 });
          },
        }),
      );
      return null;
    },
    renderStill: () => null,
    ...overrides,
  };
  return Object.assign(platform, {
    get shots(): number {
      return shots;
    },
  });
}

const CAPTURED_REF: MediaRef = {
  mediaId: MEDIA_ID,
  sha256: 'b'.repeat(64),
  mime: 'image/jpeg',
  type: 'image',
  sizeBytes: 204_800,
  capturedAt: 1,
  location: null,
  userId: '01920000-0000-7000-8000-0000000130b1',
  deviceId: '01920000-0000-7000-8000-0000000130c1',
};

describe('the in-app camera entry point (06 §2.1) and §7 storage bands', () => {
  async function openCamera(band: StorageBand): Promise<{
    readonly screen: RenderResult;
    readonly media: RecordingMediaClient;
  }> {
    const media = fakeMediaClient({ band, shot: CAPTURED_REF });
    const screen = await mountRoot(fixture, {
      createMedia: () => media,
      capturePlatform: fakeCapturePlatform(),
    });
    await signIn(screen);
    fireOn(screen, 'notes.list.create');
    await settle();
    fireOn(screen, 'notes.editor.attach');
    await settle();
    await waitUntil(() => screen.query('capture-screen') !== null);
    await settle();
    return { screen, media };
  }

  test('the editor attach button opens the capture surface and the shutter reaches the pipeline', async () => {
    const { screen, media } = await openCamera('normal');

    // The surface exists on a real device now. Before this task `capturePhoto` was the REJECTING
    // `UNWIRED_NOTES_MEDIA` seam, so this press produced an unhandled rejection and no screen.
    expect(screen.query('capture-screen')).not.toBeNull();
    await waitUntil(() => screen.query('capture-shutter') !== null);
    await settle();

    expect(media.captureCalls).toHaveLength(0);
    fireOn(screen, 'capture-shutter');
    await settle();

    // `MediaClient.capturePhoto` — the method whose own file said "nothing in a shipping USER FLOW
    // calls capturePhoto" — was entered, with the SESSION's identity (06 §4, frozen at capture).
    expect(media.captureCalls).toHaveLength(1);
    expect((media.captureCalls[0] as { identity: { userId: string } }).identity.userId).toBe(
      fixture.userId,
    );

    // And the review frame the user confirms from.
    await waitUntil(() => screen.query('capture-review') !== null);
    expect(screen.query('capture-review')).not.toBeNull();
  });

  test('06 §7: a `warning` band renders the low-storage banner over the viewfinder', async () => {
    const { screen } = await openCamera('warning');
    await waitUntil(() => screen.query('capture-storage-banner') !== null);
    // `storageBand()` shipped with zero consumers, so this banner had never rendered on a device.
    expect(screen.query('capture-storage-banner')).not.toBeNull();
  });

  test('06 §7: `capture_refused` replaces the viewfinder with the explicit refusal, not a banner', async () => {
    const { screen } = await openCamera('capture_refused');
    await waitUntil(() => screen.query('capture-refused') !== null);
    expect(screen.query('capture-refused')).not.toBeNull();
    // The positive control §7 actually demands: no live viewfinder behind the refusal, which would
    // imply a shutter that does nothing (PRD-012 §6's "silent camera death").
    expect(screen.query('capture-viewfinder')).toBeNull();
    expect(screen.query('capture-shutter')).toBeNull();
    expect(screen.query('capture-storage-banner')).toBeNull();
  });

  test('the capture surface YIELDS TO AN IDLE LOCK — a locked device never shows a live viewfinder', async () => {
    // api/02-auth §6.4 + design-system §8.2. This is a REGRESSION TEST for a defect in this task's
    // own first draft: `App` returned the capture surface on `capture !== null` alone, so the zone
    // it had just computed was never read and a lock that fired with the camera open kept rendering
    // the viewfinder over an ended session. The comment above that early return asserted the
    // opposite — which is why this is a test and not a second comment.
    const clock = advanceableClock();
    const timer = manualTimer();
    const media = fakeMediaClient({ band: 'normal', shot: CAPTURED_REF });
    const screen = await mountRoot(fixture, {
      clock,
      timer,
      createMedia: () => media,
      capturePlatform: fakeCapturePlatform(),
    });
    await signIn(screen);
    fireOn(screen, 'notes.list.create');
    await settle();
    fireOn(screen, 'notes.editor.attach');
    await settle();

    // THE DENOMINATOR (T-14): the viewfinder really is up before the lock, or the assertion below
    // would pass against a capture that never opened.
    const live = await waitUntil(() => screen.query('capture-shutter') !== null);
    expect(live, 'the viewfinder never opened — the lock assertion would be vacuous').toBe(true);

    // Idle past the tenant's deadline and run one real tick through the composed idle ticker.
    clock.advance((IDLE_LOCK_DEFAULT_SECONDS + 1) * 1000);
    await act(async () => {
      timer.fire();
      for (let i = 0; i < 12; i += 1) await Promise.resolve();
    });

    const locked = await waitUntil(() => screen.query('switcher-lock-banner') !== null);
    expect(locked, 'the idle lock never reached the shell').toBe(true);
    expect(screen.query('capture-screen')).toBeNull();
    expect(screen.query('capture-shutter')).toBeNull();
  });

  test('a `normal` band renders NO banner — the control that separates "wired" from "always warns"', async () => {
    const { screen } = await openCamera('normal');
    // ASSERT THE VIEWFINDER IS LIVE FIRST. Without this line the test passed while the capture
    // surface did not exist AT ALL (falsified: reverting the seam to `UNWIRED_NOTES_MEDIA` left this
    // one green while its three neighbours went red) — a screen that never opened also has no
    // banner. A negative control has to prove it is looking at the thing it says has no banner.
    const live = await waitUntil(() => screen.query('capture-shutter') !== null);
    expect(live, 'the viewfinder never became ready — this test would pass vacuously').toBe(true);
    expect(screen.query('capture-storage-banner')).toBeNull();
  });

  test('a pending capture does NOT survive an idle lock into a DIFFERENT user’s session', async () => {
    // The compounding half of the idle-lock story (06 §4; api/02-auth §6.4). The zone guard (above)
    // hides the viewfinder WHILE locked — but the host held `state`/`settleRef` with no identity
    // reset, so when a DIFFERENT user unlocked they landed directly on the outgoing user's live
    // viewfinder, shutter armed. A shot pressed there stamps the INCOMING user (`identityRef`) into
    // the OUTGOING user's dead promise, producing an orphan attributed to the wrong person — the
    // exact cross-user attribution the switcher exists to prevent. Two real users, real PINs.
    await seedTwoUsers(fixture);

    const clock = advanceableClock();
    const timer = manualTimer();
    const media = fakeMediaClient({ band: 'normal', shot: CAPTURED_REF });
    const screen = await mountRoot(fixture, {
      clock,
      timer,
      createMedia: () => media,
      capturePlatform: fakeCapturePlatform(),
    });

    // User A opens the camera.
    fireOn(screen, `switcher-user-${fixture.userId}`);
    await settle();
    expect(await submitPin(screen, TEST_PIN)).toBe(true);
    fireOn(screen, 'notes.list.create');
    await settle();
    fireOn(screen, 'notes.editor.attach');
    await settle();
    const live = await waitUntil(() => screen.query('capture-shutter') !== null);
    expect(live, 'user A’s viewfinder never opened — the rest is vacuous').toBe(true);

    // Idle lock ends A's session.
    clock.advance((IDLE_LOCK_DEFAULT_SECONDS + 1) * 1000);
    await act(async () => {
      timer.fire();
      for (let i = 0; i < 12; i += 1) await Promise.resolve();
    });
    expect(await waitUntil(() => screen.query('switcher-lock-banner') !== null)).toBe(true);

    // User B unlocks — a DIFFERENT user on the shared device.
    fireOn(screen, `switcher-user-${SECOND_USER_ID}`);
    await settle();
    expect(await submitPin(screen, TEST_PIN)).toBe(true);
    const home = await waitUntil(() => screen.query('notes.list.title') !== null);

    // B lands on B's OWN home, never on A's camera. Pre-fix: `captureScreenAfterBUnlock: true`,
    // `captureShutterAfterBUnlock: true`, `notesListAfterBUnlock: false` — B unlocked straight onto
    // A's armed viewfinder. The identity guard (`openedForUserRef`/`stranded`) makes all three flip.
    expect(home, 'user B never reached their own home').toBe(true);
    expect(screen.query('capture-screen')).toBeNull();
    expect(screen.query('capture-shutter')).toBeNull();
    // And the shutter was never pressed under B — no capture was attributed across the switch.
    expect(media.captureCalls).toHaveLength(0);
  });
});
