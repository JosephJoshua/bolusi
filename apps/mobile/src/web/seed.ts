/**
 * The in-memory demo seed for the react-native-web visual harness (task 116).
 *
 * ── WHAT THIS IS (and the seam it uses) ─────────────────────────────────────────────────────────
 * The device app boots a real SQLCipher DB, mints keys with quick-crypto, and reads native ports
 * (op-sqlite / expo-secure-store / expo-camera). NONE of those load in a browser. But every screen
 * in this app is a PURE FUNCTION OF ITS PROPS — `App` "takes every input as a prop (so it is drivable
 * from fakes)" (bootstrap/Root.tsx header), and each screen takes its data as props too. So the web
 * bootstrap does not fake the native modules one by one; it binds the SEAM those modules ultimately
 * feed — the screen/`App` prop interfaces — with in-memory demo data. That is the same seam the test
 * lane drives (test-renderer), one layer of fidelity up: real DOM instead of a component tree.
 *
 * Every value below is typed against the REAL interface the shipping code already defines
 * (`SwitcherUser`, `DeviceInfo`, `SyncStatusInput`, `SyncState`, `PinAttemptRow`, `LoginResult`,
 * `EnrollmentController`). No new port shape is invented (CLAUDE.md §2.8); this file only supplies
 * instances of them.
 *
 * ── HONEST CEILING ──────────────────────────────────────────────────────────────────────────────
 * This is a browser APPROXIMATION, NOT a device. Fonts, shadows, safe-area insets, gestures and Yoga
 * layout differ from a real 2 GB Android. It does not replace the device gates (27a/27b) or the
 * native E2E (117). It is a fast visual+interaction feedback loop, and every artifact it produces is
 * labelled "RNW browser approximation — NOT device-verified" so it is never mistaken for the device
 * lane.
 */
import type { PinAttemptRow, SyncState } from '@bolusi/core';
import type { NoteRow } from '@bolusi/modules/notes';
import type { NotesRuntime } from '@bolusi/modules/notes/screens';

import type { LoginResult } from '../screens/enrollment/model.js';
import type { DeviceInfo } from '../screens/settings/model.js';
import type { RejectedOpRow, SyncStatusInput } from '../screens/sync-status/model.js';
import type { SwitcherUser } from '../screens/switcher/model.js';
import type { EnrollmentController } from '../bootstrap/enrollment.js';

/**
 * A FIXED clock instant for every timestamp the harness renders. Screenshots must be byte-stable
 * across runs, so nothing here reads `Date.now()` — a "5 menit lalu" that drifts to "6 menit lalu"
 * between runs would make a pinned screenshot flap and a relative-time assertion flaky.
 */
export const HARNESS_NOW = Date.UTC(2026, 6, 21, 3, 0, 0);

const MINUTE = 60_000;

/**
 * The demo switcher roster — the DATA-BACKED screen the "fake feed drives the render" falsification
 * uses (the notes list of task 96 is not merged yet; the switcher is the data screen that exists
 * now). `PROBE_USER_NAME` is asserted verbatim by the visual suite, so changing this array changes
 * what the browser renders — the property the falsification proves. Sorted-by-recency is the
 * screen's own job (`sortByRecency`); this is just the unsorted seed.
 */
export const PROBE_USER_NAME = 'Andi Pratama';

export const DEMO_USERS: readonly SwitcherUser[] = [
  {
    id: 'u-andi',
    name: PROBE_USER_NAME,
    photoMediaId: null,
    lastActiveAt: HARNESS_NOW - 2 * MINUTE,
    needsFirstPin: false,
  },
  {
    id: 'u-siti',
    name: 'Siti Rahayu',
    photoMediaId: null,
    lastActiveAt: HARNESS_NOW - 45 * MINUTE,
    needsFirstPin: false,
  },
  {
    id: 'u-budi',
    name: 'Budi Santoso',
    photoMediaId: null,
    lastActiveAt: null,
    needsFirstPin: true,
  },
];

/** The Settings device block for an enrolled demo device (task 94's real shape, demo values). */
export const DEMO_DEVICE_INFO: DeviceInfo = {
  deviceId: 'dev_7Q2K9Z4M',
  deviceName: 'Konter Depan',
  storeName: 'Servis Ponsel Maju',
  tenantName: 'Maju Group',
  platform: 'android',
  appVersion: '0.0.0 (web-approx)',
};

/** A logged-in owner with two stores to bind — drives the enrollment confirm step. */
export const DEMO_LOGIN: LoginResult = {
  controlSession: 'demo-control-session',
  tenantId: 'tenant-maju',
  tenantName: 'Maju Group',
  user: { id: 'owner-1', name: 'Pemilik Toko' },
  stores: [
    { id: 'store-depan', name: 'Servis Ponsel Maju' },
    { id: 'store-cabang', name: 'Cabang Pasar Baru' },
  ],
};

/** A `SyncState` with every field real (10-db §9.3's row shape), demo values, overridable per state. */
export function demoSyncState(overrides: Partial<SyncState> = {}): SyncState {
  return {
    cursor: 128,
    devicesDirectoryVersion: 4,
    lastSuccessfulSyncAt: HARNESS_NOW - 4 * MINUTE,
    lastPushAt: HARNESS_NOW - 4 * MINUTE,
    lastPullAt: HARNESS_NOW - 4 * MINUTE,
    lastServerTime: HARNESS_NOW - 4 * MINUTE,
    lastServerTimeReceivedAt: HARNESS_NOW - 4 * MINUTE,
    pushHalted: false,
    syncDisabled: false,
    syncDisabledReason: null,
    lastSyncError: null,
    backoffUntil: null,
    ...overrides,
  };
}

/** The `SyncStatusInput` the sync-status screen reads, with the empty derived-query defaults. */
export function demoSyncInput(overrides: Partial<SyncStatusInput> = {}): SyncStatusInput {
  return {
    state: demoSyncState(),
    loopState: 'idle',
    pendingOperationCount: 0,
    pendingMediaCount: 0,
    rejected: [],
    quarantined: [],
    media: [],
    isOffline: false,
    manualSyncBusy: false,
    manualSyncError: null,
    now: HARNESS_NOW,
    ...overrides,
  };
}

/** The demo rejected op's id — exported so the gallery can open its §8.4 detail (task 130). */
export const DEMO_REJECTED_OP_ID = 'op_9f3a';

const DEMO_REJECTED: readonly RejectedOpRow[] = [
  {
    opId: DEMO_REJECTED_OP_ID,
    type: 'notes.create',
    at: HARNESS_NOW - 12 * MINUTE,
    rejectionCode: 'STALE_WRITE',
    rejectionReason: 'server has a newer version',
  },
];

/**
 * The meaningful sync-status shapes: healthy-and-synced, saved-here (ops pending), photos-pending
 * (ops sent but media still draining, FR-1138 — task 147), offline-but-safe, needs-attention.
 */
export const SYNC_STATUS_STATES = {
  allSent: () => demoSyncInput(),
  savedHere: () => demoSyncInput({ pendingOperationCount: 3, loopState: 'idle' }),
  photosPending: () => demoSyncInput({ pendingMediaCount: 3, pendingOperationCount: 0 }),
  offline: () => demoSyncInput({ isOffline: true, pendingOperationCount: 2 }),
  attention: () => demoSyncInput({ rejected: DEMO_REJECTED }),
} as const;

/** A clean PIN row (entry) and a lockout-bearing row (delayed) — the pad's real states. */
export const DEMO_PIN_ROWS = {
  /** No streak — a clean slate, keys live. */
  clean: null as PinAttemptRow | null,
  /** 3 ≤ failures < 10 with a future `notBefore` ⇒ `delayed`; the pad disables its keys. */
  delayed: {
    userId: 'u-andi',
    deviceId: DEMO_DEVICE_INFO.deviceId,
    consecutiveFailures: 4,
    windowStartedAt: HARNESS_NOW - 3 * MINUTE,
    notBefore: HARNESS_NOW + 30_000,
  } satisfies PinAttemptRow,
  /** failures ≥ 10 ⇒ `locked_out`; keys dead, forgot-affordance shown. */
  lockedOut: {
    userId: 'u-andi',
    deviceId: DEMO_DEVICE_INFO.deviceId,
    consecutiveFailures: 10,
    windowStartedAt: HARNESS_NOW - 10 * MINUTE,
    notBefore: HARNESS_NOW + 5 * MINUTE,
  } satisfies PinAttemptRow,
} as const;

/**
 * A fake enrollment controller for app-mode. It resolves against the demo login/enroll rather than
 * hitting a server — reused, not reinvented: it satisfies the SAME `EnrollmentController` interface
 * `App` drives on a device (the real one binds transports + keystore + the command runtime).
 */
export function fakeEnrollmentController(): EnrollmentController {
  return {
    login: () => Promise.resolve(DEMO_LOGIN),
    enroll: () => Promise.resolve(),
  };
}

/** The demo notes, seeded so the app-mode shell renders a POPULATED list rather than the empty state. */
const DEMO_NOTES: readonly NoteRow[] = [
  {
    id: 'note-demo-1',
    title: 'Stok kopi menipis',
    body: 'Sisa 4 karung di gudang belakang. Pesan ulang sebelum akhir minggu.',
    mediaId: null,
    mediaSha256: null,
    mediaMime: null,
    archived: false,
    editCount: 0,
    createdBy: 'u-andi',
    createdAt: HARNESS_NOW - 12 * MINUTE,
    lastEditedBy: 'u-andi',
    lastEditedAt: HARNESS_NOW - 12 * MINUTE,
  },
  {
    id: 'note-demo-2',
    title: 'Ganti LCD — Pak Budi',
    body: 'Unit ditinggal, ambil besok sore.',
    mediaId: 'media-demo-1',
    mediaSha256: 'e'.repeat(64),
    mediaMime: 'image/jpeg',
    archived: false,
    editCount: 2,
    createdBy: 'u-siti',
    createdAt: HARNESS_NOW - 3 * 60 * MINUTE,
    lastEditedBy: 'u-andi',
    lastEditedAt: HARNESS_NOW - 40 * MINUTE,
  },
];

/**
 * A `NotesRuntime` over in-memory demo data, for app-mode in the browser harness (task 116 + 119).
 *
 * WHY A FAKE HERE AND A REAL ONE ON DEVICE. `createSessionNotesRuntime` composes over the SQLCipher
 * database through better-sqlite3/op-sqlite — neither loads in a browser, which is the whole reason
 * this harness binds the SEAM rather than the native modules (see this file's header). So the browser
 * lane renders the REAL screens over fake data, exactly as it already does for the switcher and the
 * sync-status screen; the device lane runs the real runtime. Writes mutate the in-memory array and
 * notify subscribers, so the create/edit interactions genuinely re-render the list.
 */
export function demoNotesRuntime(): NotesRuntime {
  let rows: NoteRow[] = [...DEMO_NOTES];
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of listeners) listener();
  };
  const touch = (id: string, patch: Partial<NoteRow>): { readonly noteId: string } => {
    rows = rows.map((row) => (row.id === id ? { ...row, ...patch } : row));
    notify();
    return { noteId: id };
  };

  return {
    listNotes: (input) =>
      Promise.resolve({
        rows: rows.filter((row) => row.archived === (input.filter?.archived ?? false)),
        nextCursor: null,
      }),
    getNote: (input) =>
      Promise.resolve({ rows: rows.filter((row) => row.id === input.noteId), nextCursor: null }),
    createNote: (input) => {
      const id = `note-demo-${String(rows.length + 1)}`;
      rows = [
        {
          id,
          title: input.title,
          body: input.body,
          mediaId: input.mediaRef?.mediaId ?? null,
          mediaSha256: input.mediaRef?.sha256 ?? null,
          mediaMime: input.mediaRef?.mime ?? null,
          archived: false,
          editCount: 0,
          createdBy: 'u-andi',
          createdAt: HARNESS_NOW,
          lastEditedBy: 'u-andi',
          lastEditedAt: HARNESS_NOW,
        },
        ...rows,
      ];
      notify();
      return Promise.resolve({ noteId: id });
    },
    editNoteBody: (input) =>
      Promise.resolve(touch(input.noteId, { body: input.body, lastEditedAt: HARNESS_NOW })),
    archiveNote: (input) => Promise.resolve(touch(input.noteId, { archived: true })),
    noteSyncStatuses: () => Promise.resolve({ 'note-demo-1': ['local'] }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    hasPermission: () => true,
    // A browser has no camera flow and no verified-media pipeline; both answer the honest "not here"
    // rather than a fabricated photo (this file's "do not fake a photo" rule).
    capturePhoto: () => Promise.resolve(null),
    loadThumbnail: () => Promise.resolve({ kind: 'unavailable' }),
  };
}
