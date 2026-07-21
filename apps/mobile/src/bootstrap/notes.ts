/**
 * THE PRODUCTION CONSTRUCTION SITE for the notes module surface (task 119).
 *
 * ── WHAT WAS INERT (§2.11 — "who constructs this in production? here, nobody yet") ──────────────
 * Task 96 shipped the notes screens, the `NotesRuntime` port, and `createNotesRuntime` — the adapter
 * that binds that port over the composed command/query runtimes. All of it green, all of it mounted-
 * tested against a REAL runtime. And every one of those callers lived under `test/`: shipping source
 * contained no call to `createNotesRuntime` at all, `Root` passed `session: null` unconditionally, and
 * `App`'s `notes` prop was never given a value. So `home` rendered an empty `View` on a real device
 * and the screens were unreachable — the 40→102 / 20→105 shape, one layer up.
 *
 * This file is the missing producer. It does NOT re-implement the adapter (task 96 owns it) or the
 * data layer (task 25 owns it): it resolves the session identity, hands the shared runtime pieces to
 * `createNotesRuntime`, and returns the port the shell mounts.
 *
 * ── WHY THE IDENTITY IS READ, NOT PASSED IN ─────────────────────────────────────────────────────
 * 04 §5.2's identity is `{tenantId, storeId, userId, deviceId}`, and three of those four are facts the
 * SERVER established at enrollment and `meta_kv` persists (task 88). Reading them here means a
 * screen's reads are scoped to the device's real tenant/store rather than to whatever a caller
 * believed them to be — and an unenrolled device resolves `null` and gets NO runtime, instead of one
 * scoped to empty strings that would query successfully and return nothing.
 *
 * ── NODE-SAFE ──────────────────────────────────────────────────────────────────────────────────
 * core / db-client / types only. The media seams are injected because they are the one part that
 * binds native modules (camera, file system) — same reason `createSync` and `createMedia` are
 * injected from index.ts.
 */
import { readStoreId, readTenantId, type CommandIdentity, type DeviceIdentity } from '@bolusi/core';
import type { NotesRuntime } from '@bolusi/modules/notes/screens';

import { createNotesRuntime, readNoteSyncStatuses } from '../screens/notes/runtime-adapter.js';

import type { Bootstrapped } from './bootstrap.js';
import type { AppRuntime } from './runtime.js';

/**
 * The two seams whose sources are native, injected rather than reached for (the adapter's own rule).
 * Kept as one object so the shell passes "the media half" as a unit and a test overrides one leg.
 */
export interface NotesMediaSeams {
  /** Open the in-app capture flow (06 §2.1) and resolve the attached media, or null if cancelled. */
  readonly capturePhoto: NotesRuntime['capturePhoto'];
  /**
   * Resolve a note's attachment to a hash-verified thumbnail (06 §6).
   *
   * DERIVED FROM THE PORT ON PURPOSE, not re-declared. Task 120 is changing what a thumbnail resolve
   * must be GIVEN — a pulled note has no local `media_items` row, so the sha256 to verify against can
   * only come from the op's signed payload, which means this argument grows from a bare `mediaId` to
   * a signed ref. Restating the signature here would let this file keep compiling against the old
   * shape while the port moved underneath it; deriving it makes that a typecheck failure at the one
   * site that has to change.
   */
  readonly loadThumbnail: NotesRuntime['loadThumbnail'];
}

/**
 * The seams for a build that has not wired the media half yet.
 *
 * `capturePhoto` REJECTS rather than resolving `null`. The difference matters: `null` is the port's
 * "the user cancelled" value, so a stub returning it would make the camera button a control that
 * silently does nothing and reports success — the working-looking lie `UNWIRED_ENROLLMENT` refuses
 * for the same reason one file over. A rejection surfaces.
 *
 * `loadThumbnail` resolves `unavailable`, which is NOT a stub: api/03 §8 makes a missing photo an
 * expected, transient state, and for a PULLED note it is currently the only honest answer — 06 §6
 * verification needs the signed sha256/mime that `notes.note_created` does not carry (task 120 owns
 * that payload gap). Returning a `ready` uri without that hash is the one thing 06 §6 forbids.
 */
export const UNWIRED_NOTES_MEDIA: NotesMediaSeams = {
  capturePhoto: () =>
    Promise.reject(new Error('notes capture is not wired (no media seams injected)')),
  loadThumbnail: () => Promise.resolve({ kind: 'unavailable' }),
};

/**
 * The acting identity for a session on THIS device, or `null` when the device cannot supply one.
 *
 * `null` is returned — never a partially-filled identity — when any of tenant/store/device is absent,
 * i.e. the device is not enrolled. The caller turns that into "no notes runtime", which the shell
 * renders as the empty shell. A `''` fallback on any of these would produce an identity that queries
 * happily and matches no rows, which reads on screen as "this shop has no notes" (T-19).
 */
export async function readSessionIdentity(
  app: Bootstrapped,
  userId: string,
): Promise<CommandIdentity | null> {
  const device = await readDeviceIdentity(app);
  return device === null ? null : { ...device, userId };
}

/**
 * The enrolled device's `{tenantId, storeId, deviceId}` from `meta_kv` (task 88), or `null` when this
 * device has not enrolled. This is the device half of the identity above — the part that is a fact
 * about the DEVICE rather than about who is signed in, which is why the session controller can build
 * a command runtime from it before any user has authenticated.
 */
export async function readDeviceIdentity(app: Bootstrapped): Promise<DeviceIdentity | null> {
  if (app.deviceId === null) return null;
  const [tenantId, storeId] = await Promise.all([
    readTenantId(app.db.db as never),
    readStoreId(app.db.db as never),
  ]);
  if (tenantId === null || storeId === null) return null;
  return { tenantId, storeId, deviceId: app.deviceId };
}

/**
 * Bind a `NotesRuntime` for an open session, over the app's ONE composed runtime.
 *
 * Every piece is shared, deliberately: `runtime.moduleRuntimeFor` is the same `createModuleRuntime`
 * composition the enrollment genesis appends through (one op store, one enforcement point, one
 * evaluator — the one the sync loop's bundle refresh invalidates), and `app.invalidation` is the bus
 * the projection engine emits on for BOTH an own-device append and a pulled remote op. That second
 * one is the live-query property (04 §7): subscribe to any other bus and a note pulled from a
 * colleague's phone never reaches the mounted list.
 */
export function createSessionNotesRuntime(deps: {
  readonly app: Bootstrapped;
  readonly runtime: AppRuntime;
  readonly identity: CommandIdentity;
  readonly media: NotesMediaSeams;
}): NotesRuntime {
  const { app, identity } = deps;
  return createNotesRuntime({
    runtime: deps.runtime.moduleRuntimeFor({
      tenantId: identity.tenantId,
      storeId: identity.storeId,
      deviceId: identity.deviceId,
    }),
    invalidation: app.invalidation,
    identity,
    noteSyncStatuses: (ids) => readNoteSyncStatuses(app.db.db, ids),
    capturePhoto: deps.media.capturePhoto,
    loadThumbnail: deps.media.loadThumbnail,
  });
}
