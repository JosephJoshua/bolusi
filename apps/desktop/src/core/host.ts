// The PC's offline core: the same composition the phone's `Root` makes, run in Electron's utility
// process instead of a React tree. It boots the encrypted database, enrols the PC, opens PIN
// sessions, runs the sync and media loops and binds the repair module for whoever is signed in.
// The window reaches it only through the calls in `handlers` and the `state` it is sent; the
// database, the keys and the server token never leave this process.
import { readFileSync, rmSync } from 'node:fs';
import { extname, join } from 'node:path';

import {
  changedRemotely,
  createUuidV7Generator,
  DomainError,
  finishDeviceSetup,
  readDeviceId,
  readDeviceSetupFor,
  readSyncState,
  type ClockPort,
  type CommandIdentity,
  type LimitAmounts,
  type LocationPort,
  type TimerPort,
} from '@bolusi/core';
import { DEFAULT_DATABASE_NAME } from '@bolusi/db-client';
import { bootstrap, type Bootstrapped } from '@bolusi/device/bootstrap/bootstrap';
import { readDeviceInfo, renameDevice } from '@bolusi/device/bootstrap/device-info';
import {
  createEnrollTransport,
  createLoginTransport,
} from '@bolusi/device/bootstrap/enroll-transport';
import { createAppEnrollment, type AppEnrollment } from '@bolusi/device/bootstrap/enrollment';
import { readSessionIdentity } from '@bolusi/device/bootstrap/notes';
import { createFetchPinVerifierUpload } from '@bolusi/device/bootstrap/pin-verifier-transport';
import { bootWithLocalRecovery } from '@bolusi/device/bootstrap/recovery';
import {
  createSessionRepairRuntime,
  REPAIR_REJECTED_SUBJECTS,
  repairMediaSeamsFor,
} from '@bolusi/device/bootstrap/repair';
import { createAppSession, type AppSessionController } from '@bolusi/device/bootstrap/session';
import {
  createStaffControls,
  type RoleChange,
  type StaffControls,
} from '@bolusi/device/bootstrap/staff';
import { createFetchQris } from '@bolusi/device/bootstrap/qris-transport';
import { createFetchStaffAdmin } from '@bolusi/device/bootstrap/staff-transport';
import { resolveShellInputs } from '@bolusi/device/bootstrap/shell-inputs';
import { createSyncClientForApp, type SyncClient } from '@bolusi/device/bootstrap/sync-client';
import {
  NO_SYNC_STATUS_READS,
  markRejectionsHandled,
  readSyncStatusRows,
  type SyncStatusReads,
} from '@bolusi/device/bootstrap/sync-status-reads';
import type { AppStatePort, NetInfoPort } from '@bolusi/device/bootstrap/triggers';
import { createMediaClient, type MediaClient } from '@bolusi/device/media/client';
import { createFetchMediaTransport } from '@bolusi/device/media/transport';
import { createPhonePhotoLoader } from '@bolusi/device/media/phone-photos';
import type { SignatureStroke, PadSize } from '@bolusi/device/media/signature-png';
import type { DeviceInfo } from '@bolusi/device/models/settings/model';
import type { LoginResult } from '@bolusi/device/models/enrollment/model';
import { systemClock } from '@bolusi/device/ports/clock';
import { consoleDiagnostics } from '@bolusi/device/ports/diagnostics';
import {
  SecretDbKeyStore,
  SecretKeyStore,
  type SecretsPort,
} from '@bolusi/device/ports/secret-keystores';
import { systemTimer } from '@bolusi/device/ports/timer';
import { createIdleTicker, type IdleTicker } from '@bolusi/device/session/idle-ticker';
import type { UserWorkspace } from '@bolusi/device/state/user-workspaces';
import { approvalsModule, inventoryModule, moneyModule, purchasingModule } from '@bolusi/modules';
import { QrisError, type QrisPort } from '@bolusi/modules/money';
import { repairModule } from '@bolusi/modules/repair';
import type { ThumbnailRef, VideoMediaRef } from '@bolusi/modules/screen-kit';
import {
  MEDIA_EXTENSION,
  VIDEO_MAX_SIZE_BYTES,
  isVideoMime,
  type HandoffAsk,
  type HandoffPageLabels,
  type MediaRef,
  type QrisChargeBody,
  type VideoMime,
} from '@bolusi/schemas';

import type { Handlers } from '../main/rpc.js';
import { actingDeviceAdmin, actingSession, actingStaffAdmin, readForActing } from './acting.js';
import type {
  CoreState,
  CoreVideoLoad,
  CoreVideoOutcome,
  HandoffEvent,
  RepairChange,
  SessionView,
} from './api.js';
import { createHandoffClient } from './handoff.js';
import { heldPermissions } from './permissions.js';
import { initCoreI18n } from './i18n.js';
import { nodeRealtimeSocket } from './websocket.js';

/** The repair runtime the core builds for whoever is signed in. */
type RepairRuntime = ReturnType<typeof createSessionRepairRuntime>;
type InventoryRuntime = NonNullable<RepairRuntime['inventory']>;
type PurchasingRuntime = NonNullable<RepairRuntime['purchasing']>;

import { nodeColumnAead, nodeCryptoPort } from './crypto.js';
import { createDesktopMediaFiles, createDesktopPhonePhotoFiles } from './media-files.js';
import { openNodeSqliteDriver } from './sqlite-driver.js';

export interface CoreHostDeps {
  /** The app's own data folder (Electron's `userData`): the database and media live here. */
  readonly dataDir: string;
  /** The server, no trailing slash. */
  readonly apiBaseUrl: string;
  readonly appVersion: string;
  /** The sealed secret store in the main process. */
  readonly secrets: SecretsPort;
  readonly netInfo: NetInfoPort;
  readonly appState: AppStatePort;
  readonly clock?: ClockPort;
  readonly timer?: TimerPort;
  readonly fetchImpl?: typeof fetch;
}

export interface CoreHost {
  /** The calls the window may make. */
  readonly handlers: Handlers;
  start(): Promise<void>;
  state(): CoreState;
  /** Fires with every new state; returns the unsubscribe. */
  onState(listener: (state: CoreState) => void): () => void;
  /** Sync now (the PC woke up, or someone asked). */
  requestSync(): void;
  /**
   * Fires when a repair read may have changed (the live-query signal), naming the record when the
   * change came from another device so the window can let it glow.
   */
  onRepairChanged(listener: (change: RepairChange | null) => void): () => void;
  /** Fires with what the paired phone did (the phone handoff). */
  onHandoff(listener: (event: HandoffEvent) => void): () => void;
  stop(): Promise<void>;
}

/** A counter PC has no GPS; every op and photo honestly records no location. */
const NO_LOCATION: LocationPort = { getBestFix: () => null };

const PLATFORM = 'windows';

const IMAGE_MIME: Readonly<Record<string, string>> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

function fileDataUri(path: string): string {
  const mime = IMAGE_MIME[extname(path).toLowerCase()] ?? 'image/jpeg';
  return `data:${mime};base64,${readFileSync(path).toString('base64')}`;
}

/**
 * A query or command named by the window. Only the module's own names run; the input itself is
 * checked by the runtime's strict schema, as for any caller.
 */
function knownName(operations: object, name: string): string {
  if (!Object.hasOwn(operations, name)) {
    throw new DomainError('VALIDATION_FAILED', { operation: name });
  }
  return name;
}

/** The port's typed `query`/`run`, called with a name and input that crossed the process boundary. */
function untyped(call: unknown): (name: string, input: unknown) => Promise<unknown> {
  return call as (name: string, input: unknown) => Promise<unknown>;
}

function warn(message: string, error: unknown): void {
  consoleDiagnostics.warn(message, {
    error: error instanceof Error ? error.message : String(error),
  });
}

export function createCoreHost(deps: CoreHostDeps): CoreHost {
  initCoreI18n();
  const clock = deps.clock ?? systemClock;
  const timer = deps.timer ?? systemTimer;
  const crypto = nodeCryptoPort;
  const fetchOptions = deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl };
  const newId = createUuidV7Generator({
    now: () => clock.now(),
    randomBytes: (n) => crypto.randomBytes(n),
  });
  const dbKeyStore = new SecretDbKeyStore(deps.secrets, crypto);
  // ONE keystore for enrolment and the runtime's signing key: the seed enrolment caches is the
  // seed the genesis and every later op are signed with.
  const keystore = new SecretKeyStore(deps.secrets);
  const loadDeviceToken = (): Promise<string | null> => keystore.loadDeviceToken();
  const mediaFiles = createDesktopMediaFiles(join(deps.dataDir, 'files'), () =>
    dbKeyStore.getDatabaseEncryptionKey(),
  );
  const loadModelPhotoPath = createPhonePhotoLoader({
    baseUrl: deps.apiBaseUrl,
    deviceToken: loadDeviceToken,
    sha256Hex: (bytes) => Buffer.from(crypto.sha256(bytes)).toString('hex'),
    files: createDesktopPhonePhotoFiles(join(deps.dataDir, 'files')),
    ...fetchOptions,
  });
  const uploadPinVerifier = createFetchPinVerifierUpload({
    baseUrl: deps.apiBaseUrl,
    deviceToken: loadDeviceToken,
  });
  const staffAdmin = createFetchStaffAdmin({
    baseUrl: deps.apiBaseUrl,
    deviceToken: loadDeviceToken,
    ...fetchOptions,
  });
  const qrisFor = createFetchQris({
    baseUrl: deps.apiBaseUrl,
    deviceToken: loadDeviceToken,
    ...fetchOptions,
  });

  let app: Bootstrapped | null = null;
  let enrollment: AppEnrollment | null = null;
  let session: AppSessionController | null = null;
  let sync: SyncClient | null = null;
  let media: MediaClient | null = null;
  let ticker: IdleTicker | null = null;
  let deviceInfo: DeviceInfo | null = null;
  /** The owner this PC's first-run setup waits for (core device-setup.ts), or null. */
  let setupFor: string | null = null;
  let syncReads: SyncStatusReads = NO_SYNC_STATUS_READS;
  let bootError: string | null = null;
  let stopped = false;
  /** The owner's login, kept here so the control-session token never reaches the window. */
  let heldLogin: LoginResult | null = null;
  /** The repair surface for whoever is signed in; rebuilt on a switch or when media lands. */
  let repair: {
    readonly userId: string;
    readonly identity: CommandIdentity;
    readonly runtime: RepairRuntime;
  } | null = null;
  const cleanups: (() => void)[] = [];
  /** What the session and the loops subscribed; a re-enrolment drops them with the services. */
  const serviceCleanups: (() => void)[] = [];
  // Bumped by `stopServices`: a start still awaiting when the services stop must not install itself.
  let generation = 0;

  const stateListeners = new Set<(state: CoreState) => void>();
  const repairListeners = new Set<(change: RepairChange | null) => void>();
  const handoffListeners = new Set<(event: HandoffEvent) => void>();
  // The phone handoff talks to the server with this PC's token, so it lives here; the window gets
  // ids and what the phone sent, and keeps that through `media.*` like its own capture.
  const handoff = createHandoffClient({
    baseUrl: deps.apiBaseUrl,
    deviceToken: loadDeviceToken,
    emit: (event) => {
      for (const listener of handoffListeners) listener(event);
    },
    ...fetchOptions,
  });
  let current: CoreState = {
    phase: 'booting',
    bootError: null,
    device: 'unenrolled',
    deviceInfo: null,
    setupFor: null,
    session: null,
    sync: null,
    statusSite: deps.apiBaseUrl,
  };

  // Many changes land together (a pull applies ops one by one), so the window gets one state per
  // turn of the event loop, not one per change.
  let emitQueued = false;
  const emit = (): void => {
    if (emitQueued) return;
    emitQueued = true;
    queueMicrotask(() => {
      emitQueued = false;
      current = computeState();
      for (const listener of stateListeners) listener(current);
    });
  };

  function sessionView(): SessionView | null {
    if (session === null) return null;
    const snapshot = session.snapshot();
    const users = snapshot.users ?? [];
    const pinRows = Object.fromEntries(users.map((user) => [user.id, session!.pinRow(user.id)]));
    const active = snapshot.session;
    const repairRuntime = activeRepair();
    const permissions =
      repairRuntime === null
        ? []
        : heldPermissions((permission) => repairRuntime.hasPermission(permission));
    const colleaguePermissions =
      repairRuntime === null
        ? {}
        : Object.fromEntries(
            users.map((user) => [
              user.id,
              heldPermissions((permission) =>
                repairRuntime.colleagueHasPermission(user.id, permission),
              ),
            ]),
          );
    const limits =
      repairRuntime === null
        ? {}
        : Object.fromEntries(
            permissions.map((permission) => [permission, repairRuntime.limitOf(permission)]),
          );
    return {
      active,
      users: snapshot.users,
      usersError: snapshot.usersError,
      pinRows,
      locked: snapshot.locked,
      lockReason: snapshot.lockReason,
      workspace: snapshot.workspace,
      deviceDrafts: snapshot.deviceDrafts,
      canUnlock: snapshot.canUnlock,
      canReset: snapshot.canReset,
      canManageStaff: snapshot.canManageStaff,
      canSetLimits: snapshot.canSetLimits,
      canRenameDevice: snapshot.canRenameDevice,
      tenantAdmin: snapshot.tenantAdmin,
      permissions,
      colleaguePermissions,
      limits,
    };
  }

  function computeState(): CoreState {
    if (app === null) {
      return { ...current, phase: bootError === null ? 'booting' : 'failed', bootError };
    }
    const shell = resolveShellInputs(app, sync, clock.now(), syncReads);
    return {
      phase: 'ready',
      bootError: null,
      device: shell.device,
      deviceInfo,
      setupFor,
      session: sessionView(),
      sync: shell.sync,
      statusSite: deps.apiBaseUrl,
    };
  }

  /** Who is signed in now, or null while nobody is or the screen is locked. */
  function signedInUserId(): string | null {
    const snapshot = session?.snapshot();
    if (snapshot === undefined || snapshot.locked) return null;
    return snapshot.session?.userId ?? null;
  }

  /** The repair runtime for the user signed in now, or null with nobody signed in. */
  function activeRepair(): RepairRuntime | null {
    const active = session?.snapshot().session ?? null;
    if (active === null || session?.snapshot().locked === true) return null;
    return repair !== null && repair.userId === active.userId ? repair.runtime : null;
  }

  /** Rebuild the repair runtime for whoever is signed in now. Run unawaited, so it never rejects. */
  async function bindRepair(): Promise<void> {
    try {
      const active = session?.snapshot().session ?? null;
      if (app === null || enrollment === null || active === null) {
        repair = null;
        return;
      }
      if (repair?.userId === active.userId) return;
      const booted = app;
      const enroll = enrollment;
      const identity = await readForActing(
        () => session,
        active.userId,
        (userId) => readSessionIdentity(booted, userId),
      );
      // Dropped when someone else signed in or the PC was re-registered while the read ran; the
      // change that did it has already asked for a fresh bind.
      if (identity === null || app !== booted || enrollment !== enroll) return;
      if (repair?.userId === active.userId) return;
      repair = { userId: active.userId, identity, runtime: buildRepair(booted, enroll, identity) };
      emit();
    } catch (error) {
      warn('repair runtime could not be built', error);
    }
  }

  function buildRepair(
    booted: Bootstrapped,
    enroll: AppEnrollment,
    identity: CommandIdentity,
  ): RepairRuntime {
    // The window owns the camera, the signature pad and the print dialog; their results come back
    // through `media.*` and the window's own printing, so these seams are never called here.
    const windowOnly = (): Promise<never> =>
      Promise.reject(new Error('capture runs in the window on a PC'));
    return createSessionRepairRuntime({
      app: booted,
      runtime: enroll.runtime,
      identity,
      media: repairMediaSeamsFor(media, {
        capturePhoto: windowOnly,
        captureSignature: windowOnly,
        loadModelPhoto: async (photo) => {
          const path = await loadModelPhotoPath(photo);
          return path === null ? null : fileDataUri(path);
        },
      }),
      print: {
        print: () => Promise.reject(new Error('printing runs in the window on a PC')),
        sharePdf: () => Promise.reject(new Error('printing runs in the window on a PC')),
        // A PC's thumbnails are already `data:` URIs.
        readBase64: (uri) => Promise.resolve(uri.slice(uri.indexOf(',') + 1)),
      },
      qris: qrisFor,
      statusSite: deps.apiBaseUrl,
    });
  }

  /**
   * The repair runtime a window call runs on. The window names the user it was built for, and a call
   * made for anyone but the person signed in now is refused: a screen left over from before a switch
   * must never write as the next person.
   */
  function repairFor(userId: string): RepairRuntime {
    const runtime = activeRepair();
    if (runtime === null || runtime.userId !== userId) throw new DomainError('NOT_AUTHENTICATED');
    return runtime;
  }

  /** QRIS for the person signed in now; a call for anyone else is refused like a repair call. */
  function qrisOf(userId: string): QrisPort {
    const port = repairFor(userId).money.qris;
    if (port === undefined) throw new QrisError('unavailable');
    return port;
  }

  function inventoryFor(userId: string): InventoryRuntime {
    const inventory = repairFor(userId).inventory;
    if (inventory === undefined) throw new Error('stock is not running on this PC');
    return inventory;
  }

  function purchasingFor(userId: string): PurchasingRuntime {
    const purchasing = repairFor(userId).purchasing;
    if (purchasing === undefined) throw new Error('buying is not running on this PC');
    return purchasing;
  }

  /** Who a photo or signature from the window is stamped with: the person signed in now. */
  function captureFor(userId: string): { identity: CommandIdentity; client: MediaClient } {
    repairFor(userId);
    if (media === null || repair === null) throw new Error('media is not running on this PC yet');
    return { identity: repair.identity, client: media };
  }

  function requireSession(): AppSessionController {
    if (session === null) throw new DomainError('NOT_AUTHENTICATED');
    return session;
  }

  /**
   * "Karyawan" as the person signed in now, the phone's composition: each change is a server call
   * as them, then a sync so this PC's directory holds the server's answer before the window reads
   * it again.
   */
  function staffFor(userId: string): StaffControls {
    const current = actingStaffAdmin(session, userId);
    return createStaffControls({
      port: staffAdmin,
      tenantAdmin: current.snapshot().tenantAdmin,
      canSetLimits: current.snapshot().canSetLimits,
      load: () => current.listStaff(),
      context: () => current.staffContext(),
      refreshDirectory: async () => {
        if (sync === null) return;
        sync.requestManual();
        await sync.settle();
      },
    });
  }

  /** The PIN session, for a window call made for the person signed in now. */
  const sessionFor = (userId: string): AppSessionController => actingSession(session, userId);

  function requireEnrollment(): AppEnrollment {
    if (enrollment === null) throw new Error('the core has not booted');
    return enrollment;
  }

  // One read at a time; asks during a read fold into one more after it (a first pull writes a lot).
  let reading: Promise<void> | null = null;
  let readAgain = false;
  async function rereadSyncStatus(): Promise<void> {
    if (app === null) return;
    if (reading !== null) {
      readAgain = true;
      return reading;
    }
    const booted = app;
    reading = (async () => {
      do {
        readAgain = false;
        try {
          syncReads = await readSyncStatusRows(
            booted.db.db,
            REPAIR_REJECTED_SUBJECTS,
            signedInUserId(),
          );
          emit();
        } catch (error) {
          warn('sync status read failed', error);
        }
      } while (readAgain);
    })();
    try {
      await reading;
    } finally {
      reading = null;
    }
  }

  async function bootDataLayer(): Promise<Bootstrapped> {
    const location = deps.dataDir;
    return bootWithLocalRecovery({
      boot: () =>
        bootstrap({
          driverFactory: openNodeSqliteDriver,
          keyStore: dbKeyStore,
          crypto,
          aead: nodeColumnAead,
          clock,
          databaseLocation: location,
        }),
      wipeLocalData: async () => {
        await dbKeyStore.wipe();
        for (const suffix of ['', '-wal', '-shm', '-journal']) {
          rmSync(join(location, `${DEFAULT_DATABASE_NAME}${suffix}`), { force: true });
        }
      },
    });
  }

  async function startSession(booted: Bootstrapped, enroll: AppEnrollment): Promise<void> {
    if (session !== null || booted.deviceId === null) return;
    const started = generation;
    await enroll.loadSigningKey();
    const controller = await createAppSession({
      app: booted,
      runtime: enroll.runtime,
      crypto,
      clock,
      idSource: newId,
    });
    if (controller === null || stopped || started !== generation) return;
    session = controller;
    serviceCleanups.push(
      controller.subscribe(() => {
        // A switch or a lock changes who the repair runtime is for, and whose refusals are listed.
        void bindRepair();
        void rereadSyncStatus();
        emit();
      }),
    );
    ticker = createIdleTicker({
      tick: () => controller.tick(),
      timer,
      appState: deps.appState,
      onError: (error) => warn('idle lock tick failed', error),
    });
    ticker.start();
    await controller.refresh();
    emit();
  }

  async function startSync(booted: Bootstrapped, enroll: AppEnrollment): Promise<void> {
    if (sync !== null || booted.deviceId === null) return;
    const started = generation;
    await enroll.evaluator.prime();
    const client = createSyncClientForApp(booted, {
      baseUrl: deps.apiBaseUrl,
      deviceId: booted.deviceId,
      loadDeviceToken,
      crypto,
      clock,
      timer,
      appState: deps.appState,
      netInfo: deps.netInfo,
      ...fetchOptions,
      webSocketImpl: nodeRealtimeSocket,
      onBundleRefreshed: async () => {
        await enroll.evaluator.onBundleRefresh();
        await session?.refreshSettings();
        await session?.refresh();
        emit();
      },
      onBundleChecked: async () => {
        await session?.drainVerifiers(uploadPinVerifier);
      },
    });
    if (stopped || started !== generation) {
      client.stop();
      return;
    }
    sync = client;
    serviceCleanups.push(
      client.subscribe(() => {
        void rereadSyncStatus();
        emit();
      }),
    );
    await client.start();
    enroll.runtime.bindSyncScheduler(client.scheduler);
  }

  async function startMedia(booted: Bootstrapped, enroll: AppEnrollment): Promise<void> {
    if (media !== null || booted.deviceId === null) return;
    const client = createMediaClient({
      db: booted.db,
      transport: createFetchMediaTransport({
        baseUrl: deps.apiBaseUrl,
        deviceToken: loadDeviceToken,
        ...fetchOptions,
      }),
      ...mediaFiles,
      // Photos reach the core already compressed by the window (see `media.importImage`), so
      // the phone's camera path, the one caller of the compressor, never runs here.
      compressor: {
        compress: () => Promise.reject(new Error('the window compresses photos on a PC')),
      },
      crypto,
      clock,
      timer,
      appState: deps.appState,
      netInfo: deps.netInfo,
      newId,
      location: NO_LOCATION,
      background: null,
      onQueueChanged: () => void rereadSyncStatus(),
      onError: (error) => warn('media drain trigger failed', error),
    });
    media = client;
    enroll.runtime.bindMediaAttached(() => media?.notifyAttached());
    // The thumbnails the repair runtime loads go through the client, so rebind it.
    repair = null;
    void bindRepair();
    await client.start();
  }

  /**
   * Stop everything bound to this PC's registration: the loops would send under a token being
   * replaced, and an open session would keep signing under the old device id, which the server
   * refuses once the PC pushes as the new one. The session ends without a record, like the phone's.
   */
  function stopServices(): void {
    generation += 1;
    ticker?.stop();
    ticker = null;
    for (const cleanup of serviceCleanups.splice(0)) cleanup();
    enrollment?.runtime.bindSyncScheduler(null);
    enrollment?.runtime.bindMediaAttached(null);
    sync?.stop();
    sync = null;
    media?.stop();
    media = null;
    session = null;
    repair = null;
    emit();
  }

  /** Run the services under `deviceId`, the registration enrolment just made; a no-op when they do. */
  async function adopt(deviceId: string): Promise<void> {
    if (app === null || enrollment === null || app.deviceId === deviceId) return;
    const reenrolled = app.deviceId !== null;
    if (reenrolled) stopServices();
    // Claimed before the await, so a second signal for the same registration is the no-op above.
    app = { ...app, deviceId };
    // Enrolment reset the sync state for the new registration; the boot-time copy is the old one's.
    if (reenrolled) app = { ...app, syncState: await readSyncState(app.db.db) };
    heldLogin = null;
    emit();
    void startEnrolledServices(app, enrollment);
  }

  /** Session first, so the switcher lists people even if a loop stalls (the phone's order). */
  async function startEnrolledServices(booted: Bootstrapped, enroll: AppEnrollment): Promise<void> {
    try {
      await startSession(booted, enroll);
    } catch (error) {
      warn('session open failed', error);
    }
    try {
      deviceInfo = await readDeviceInfo(booted, {
        platform: PLATFORM,
        appVersion: deps.appVersion,
      });
      setupFor = await readDeviceSetupFor(booted.db.db);
      emit();
      const started = generation;
      await startSync(booted, enroll);
      if (started === generation) await startMedia(booted, enroll);
    } catch (error) {
      warn('enrolled services failed to start', error);
    }
    emit();
  }

  function startProjectionRebuild(booted: Bootstrapped): void {
    void booted.engine
      .rebuildOutdated({
        pause: () => new Promise<void>((resolve) => timer.schedule(0, resolve)),
        isStopped: () => stopped,
      })
      .catch((error: unknown) => warn('projection rebuild failed', error));
  }

  async function start(): Promise<void> {
    let booting: Bootstrapped;
    try {
      booting = await bootDataLayer();
    } catch (error) {
      bootError = error instanceof Error ? error.message : String(error);
      emit();
      throw error;
    }
    if (stopped) {
      await booting.close();
      return;
    }
    app = booting;
    const enroll = createAppEnrollment(
      booting,
      {
        loginTransport: createLoginTransport({ baseUrl: deps.apiBaseUrl, ...fetchOptions }),
        enrollTransport: createEnrollTransport({ baseUrl: deps.apiBaseUrl, ...fetchOptions }),
        keystore,
        crypto,
        clock,
        idSource: newId,
        location: NO_LOCATION,
        platform: PLATFORM,
        appVersion: deps.appVersion,
      },
      (deviceId) => void adopt(deviceId),
    );
    enrollment = enroll;
    cleanups.push(
      booting.invalidation.subscribe((_tables, change) => {
        const freshIds = changedRemotely(change);
        const fresh: RepairChange | null = freshIds.length > 0 ? { freshIds } : null;
        for (const listener of repairListeners) listener(fresh);
        void rereadSyncStatus();
      }),
    );
    startProjectionRebuild(booting);
    deviceInfo = await readDeviceInfo(booting, { platform: PLATFORM, appVersion: deps.appVersion });
    setupFor = await readDeviceSetupFor(booting.db.db);
    emit();
    await startEnrolledServices(booting, enroll);
    await rereadSyncStatus();
  }

  async function stop(): Promise<void> {
    stopped = true;
    stopServices();
    for (const cleanup of cleanups.splice(0)) cleanup();
    handoff.stop();
    await app?.close();
  }

  const handlers = {
    // ── Enrolment ───────────────────────────────────────────────────────────────────────────────
    async 'enrollment.login'(request: { loginIdentifier: string; password: string }) {
      const login = await requireEnrollment().controller.login(request);
      heldLogin = login;
      // The control session is the owner's sign-in to the server: it stays in this process.
      return { ...login, controlSession: '' } satisfies LoginResult;
    },
    async 'enrollment.enroll'(request: { storeId: string; deviceName: string }) {
      if (heldLogin === null) throw new DomainError('NOT_AUTHENTICATED');
      const enroll = requireEnrollment();
      const booted = app;
      if (booted === null || booted.deviceId === null) {
        // The counter PC is always shared by its store.
        await enroll.controller.enroll({ login: heldLogin, ...request, personalUserId: null });
        return;
      }
      // Re-enrolling replaces this PC's registration (and carries its unsent work over), so
      // nothing may keep running under the old one meanwhile.
      stopServices();
      try {
        // The counter PC is always shared by its store.
        await enroll.controller.enroll({ login: heldLogin, ...request, personalUserId: null });
      } catch (error) {
        // Nothing was replaced: pick up where the PC was.
        if (!stopped) void startEnrolledServices(booted, enroll);
        throw error;
      }
      // The new registration runs at once: the PC has work to send, and the owner leaving the
      // success step some other way must not strand it.
      const deviceId = await readDeviceId(booted.db.db);
      if (deviceId !== null) await adopt(deviceId);
    },
    // What a PC enrolled before holds: its store (the only one it may join again) and the unsent
    // changes the owner sees before they are carried over.
    'enrollment.heldPhone': () => requireEnrollment().controller.heldPhone(),
    'enrollment.finish'() {
      requireEnrollment().controller.finish();
    },
    // The first-run setup is finished or skipped: it does not open by itself again.
    async 'device.finishSetup'() {
      if (app === null) return;
      await finishDeviceSetup(app.db.db);
      setupFor = null;
      emit();
    },

    // ── PIN session ─────────────────────────────────────────────────────────────────────────────
    'session.refresh': () => requireSession().refresh(),
    async 'session.submitPin'(userId: string, pin: string) {
      const outcome = await requireSession().submitPin(userId, pin);
      emit();
      return outcome;
    },
    async 'session.setFirstPin'(userId: string, pin: string) {
      await requireSession().setFirstPin(userId, pin);
      emit();
    },
    // Every call below names the person its screen was built for, as repair calls do.
    'session.changePin': (userId: string, currentPin: string, newPin: string) =>
      sessionFor(userId).changePin(currentPin, newPin),
    // A colleague's PIN, from "PIN karyawan". The core flows check the owner's permission.
    'session.listPinTargets': (userId: string) => sessionFor(userId).listPinTargets(),
    'session.clearLockout': (userId: string, targetUserId: string) =>
      sessionFor(userId).clearLockout(targetUserId),
    'session.resetPin': (userId: string, targetUserId: string, newPin: string) =>
      sessionFor(userId).resetPin(targetUserId, newPin),
    // The screen locks even when `session_ended` cannot be written; the lost record is logged.
    'session.lock': () =>
      requireSession()
        .lockNow()
        .catch((error: unknown) => warn('manual lock was not recorded', error)),
    'session.recordActivity'() {
      session?.recordActivity();
    },
    'session.updateWorkspace'(next: UserWorkspace) {
      session?.updateWorkspace(next);
    },
    'session.updateDeviceDraft'(moduleId: string, draft: unknown) {
      session?.updateDeviceDraft(moduleId, draft);
    },

    // ── Karyawan (online only; each change is a server call as the signed-in owner) ────────────
    'staff.list': (userId: string) => staffFor(userId).load(),
    'staff.create': (userId: string, draft: Parameters<StaffControls['onCreate']>[0]) =>
      staffFor(userId).onCreate(draft),
    'staff.update': (
      userId: string,
      memberId: string,
      change: Parameters<StaffControls['onUpdate']>[1],
    ) => staffFor(userId).onUpdate(memberId, change),
    'staff.setActive': (userId: string, memberId: string, active: boolean) =>
      staffFor(userId).onSetActive(memberId, active),
    'staff.setLimits': (userId: string, roleId: string, limits: LimitAmounts) =>
      staffFor(userId).onSetLimits(roleId, limits),
    'staff.createRole': (userId: string, name: string, copyFromRoleId: string) =>
      staffFor(userId).onCreateRole(name, copyFromRoleId),
    'staff.updateRole': (userId: string, roleId: string, change: RoleChange) =>
      staffFor(userId).onUpdateRole(roleId, change),
    'staff.deleteRole': (userId: string, roleId: string) => staffFor(userId).onDeleteRole(roleId),

    // Online only, like Karyawan: the server takes the new name first, then this PC shows it.
    async 'device.rename'(userId: string, name: string) {
      actingDeviceAdmin(session, userId);
      const booted = app;
      if (booted === null) throw new Error('the core has not booted');
      await renameDevice(booted, staffAdmin, { actingUserId: userId, name });
      deviceInfo = await readDeviceInfo(booted, {
        platform: PLATFORM,
        appVersion: deps.appVersion,
      });
      emit();
    },

    // ── Sync ────────────────────────────────────────────────────────────────────────────────────
    'sync.requestManual'() {
      sync?.requestManual();
      media?.requestManual();
    },
    // The person signed in has dealt with these refused changes of theirs.
    async 'sync.markRejectedHandled'(opIds: readonly string[]) {
      const userId = signedInUserId();
      if (app === null || userId === null) return;
      await markRejectionsHandled(app.db, userId, opIds, clock.now());
      await rereadSyncStatus();
    },

    // ── Repair (every call names the user its screen was built for) ─────────────────────────────
    'repair.query': (userId: string, name: string, input: unknown) =>
      untyped(repairFor(userId).query)(knownName(repairModule.queries, name), input),
    'repair.run': (userId: string, name: string, input: unknown) =>
      untyped(repairFor(userId).run)(knownName(repairModule.commands, name), input),
    // The money a servisan takes (payment methods, a DP, the handover payment), for the same person.
    'money.query': (userId: string, name: string, input: unknown) =>
      untyped(repairFor(userId).money.query)(knownName(moneyModule.queries, name), input),
    'money.run': (userId: string, name: string, input: unknown) =>
      untyped(repairFor(userId).money.run)(knownName(moneyModule.commands, name), input),
    'money.stores': (userId: string) => repairFor(userId).money.stores(),
    // QRIS through Xendit: server calls as the same person, made from here like the staff calls.
    'money.qris.connections': (userId: string) => qrisOf(userId).connections(),
    'money.qris.connect': (userId: string, accountId: string, secretKey: string) =>
      qrisOf(userId).connect(accountId, secretKey),
    'money.qris.disconnect': (userId: string, accountId: string) =>
      qrisOf(userId).disconnect(accountId),
    'money.qris.createCharge': (userId: string, body: QrisChargeBody) =>
      qrisOf(userId).createCharge(body),
    'money.qris.charge': (userId: string, id: string) => qrisOf(userId).charge(id),
    'money.qris.simulate': (userId: string, id: string) => qrisOf(userId).simulate(id),
    // Approval requests on servisan (a discount or a cancel asked of an owner), for the same person.
    'approvals.query': (userId: string, name: string, input: unknown) =>
      untyped(repairFor(userId).approvals.query)(knownName(approvalsModule.queries, name), input),
    'approvals.run': (userId: string, name: string, input: unknown) =>
      untyped(repairFor(userId).approvals.run)(knownName(approvalsModule.commands, name), input),
    // The parts list and each servisan's parts, for the same person.
    'inventory.query': (userId: string, name: string, input: unknown) =>
      untyped(inventoryFor(userId).query)(knownName(inventoryModule.queries, name), input),
    'inventory.run': (userId: string, name: string, input: unknown) =>
      untyped(inventoryFor(userId).run)(knownName(inventoryModule.commands, name), input),
    // Orders to suppliers and their deliveries, for the same person.
    'purchasing.query': (userId: string, name: string, input: unknown) =>
      untyped(purchasingFor(userId).query)(knownName(purchasingModule.queries, name), input),
    'purchasing.run': (userId: string, name: string, input: unknown) =>
      untyped(purchasingFor(userId).run)(knownName(purchasingModule.commands, name), input),
    'purchasing.storeName': (userId: string) =>
      purchasingFor(userId).storeName?.() ?? Promise.resolve(null),
    'repair.ticketSyncStatuses': (userId: string, ticketIds: readonly string[]) =>
      repairFor(userId).ticketSyncStatuses(ticketIds),
    'repair.technicians': (userId: string) => repairFor(userId).technicians(),
    'repair.loadThumbnail': (userId: string, ref: ThumbnailRef) =>
      repairFor(userId).loadThumbnail(ref),
    'repair.loadModelPhoto': (
      userId: string,
      photo: Parameters<RepairRuntime['loadModelPhoto']>[0],
    ) => repairFor(userId).loadModelPhoto(photo),
    'repair.print.storeName': (userId: string) => repairFor(userId).printing!.storeName(),
    'repair.print.readPaper': (userId: string) => repairFor(userId).printing!.readPaper(),
    'repair.print.writePaper': (
      userId: string,
      paper: Parameters<NonNullable<RepairRuntime['printing']>['writePaper']>[0],
    ) => repairFor(userId).printing!.writePaper(paper),
    'repair.print.imageDataUri': (userId: string, ref: ThumbnailRef) =>
      repairFor(userId).printing!.imageDataUri(ref),

    // ── Media from the window: a webcam photo (already compressed) or a signature ───────────────
    async 'media.importImage'(
      userId: string,
      image: { bytes: Uint8Array; mime: MediaRef['mime'] },
    ) {
      const { identity, client } = captureFor(userId);
      const extension = image.mime === 'image/png' ? 'png' : 'jpg';
      const scratch = mediaFiles.writeToCache(image.bytes, newId(), extension);
      const outcome = await client.importImage(identity, { uri: scratch, mime: image.mime });
      if (outcome.kind !== 'imported') return { kind: outcome.kind } as const;
      return { kind: 'captured', mediaRef: outcome.ref } as const;
    },
    // The ownership video as the webcam recorded it, kept like the phone's: encrypted and queued.
    async 'media.importVideo'(
      userId: string,
      video: { bytes: Uint8Array; mime: VideoMime },
    ): Promise<CoreVideoOutcome> {
      const { identity, client } = captureFor(userId);
      // The window is trusted only as far as the server would trust it.
      if (!isVideoMime(video.mime)) throw new DomainError('VALIDATION_FAILED');
      if (video.bytes.length > VIDEO_MAX_SIZE_BYTES) return { kind: 'refused_too_large' };
      // `importVideo` deletes the scratch copy whenever it does not keep it.
      const scratch = mediaFiles.writeToCache(video.bytes, newId(), MEDIA_EXTENSION[video.mime]);
      const outcome = await client.importVideo(identity, { uri: scratch, mime: video.mime });
      if (outcome.kind !== 'imported') return { kind: outcome.kind };
      return { kind: 'captured', videoRef: outcome.ref };
    },
    'media.hasLocal': (userId: string, mediaId: string) =>
      captureFor(userId).client.hasLocal(mediaId),
    /** A stored clip's bytes to play, checked against its signed hash; downloaded when not here. */
    async 'media.loadVideo'(userId: string, ref: VideoMediaRef): Promise<CoreVideoLoad> {
      const { client } = captureFor(userId);
      const rendered = await client.loadForRender(ref);
      if (rendered.kind === 'unavailable') return { kind: 'unavailable' };
      if (rendered.kind === 'mismatch') return { kind: 'failed' };
      // `toRenderUri` hands the window a data uri; the bytes cross the port as they are.
      const base64 = rendered.uri.slice(rendered.uri.indexOf(',') + 1);
      return {
        kind: 'ready',
        bytes: new Uint8Array(Buffer.from(base64, 'base64')),
        mime: ref.mime,
      };
    },
    async 'media.captureSignature'(userId: string, strokes: SignatureStroke[], pad: PadSize) {
      const { identity, client } = captureFor(userId);
      const outcome = await client.captureSignature(identity, strokes, pad);
      if (outcome.kind !== 'captured') return { kind: outcome.kind } as const;
      return { kind: 'captured', mediaRef: outcome.ref } as const;
    },

    // ── Phone handoff: a store phone takes the photo or signature for this PC ───────────────────
    'handoff.pair': (labels: HandoffPageLabels) => handoff.pair(labels),
    'handoff.ask': (id: string, ask: HandoffAsk) => handoff.ask(id, ask),
    'handoff.withdraw': (id: string, seq: number) => handoff.withdraw(id, seq),
    'handoff.unpair': (id: string) => handoff.unpair(id),
  } satisfies Handlers;

  return {
    handlers,
    start,
    requestSync: () => handlers['sync.requestManual'](),
    stop,
    state: () => current,
    onState(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    onRepairChanged(listener) {
      repairListeners.add(listener);
      return () => repairListeners.delete(listener);
    },
    onHandoff(listener) {
      handoffListeners.add(listener);
      return () => handoffListeners.delete(listener);
    },
  };
}
