// THE MEDIA CLIENT — the composition task 18's engine was waiting for.
//
// Task 18 shipped `MediaDrainLoop`, `prunePlanFor`, `fetchAndVerifyMedia` and the `MediaFilePort`
// adapter, and nothing constructed any of them. This file is the constructor: it assembles the loop
// with its real ports (the one DB connection, the fetch media transport, the expo filesystem, the
// clock/timer), attaches 06 §5.2's triggers, registers the background task, runs the pruning pass,
// and exposes the capture entry points. It mirrors `bootstrap/sync-client.ts` deliberately —
// same shape, same lifecycle, same injected-ports discipline — because 06 §5.2 says the media
// triggers "mirror the sync-loop triggers", and two loops with the same job should not have two
// different shapes for a reader to reconcile.
//
// ── FR-1138: THE TWO LOOPS DO NOT TOUCH ─────────────────────────────────────────────────────────
// Nothing in this file imports `SyncLoop`, `SyncClient`, or any op table, and nothing in the sync
// client imports this. They share the DB CONNECTION and four PORT TYPES (`ClockPort`, `TimerPort`,
// `AppStatePort`, `NetInfoPort`) and no state at all. That is what makes "a note is usable before
// its photo has uploaded" (06 §1) structural rather than a hope: a media queue stuck on a 3 G uplink
// has no edge through which it could delay an op push.
//
// ── WHAT IS REAL HERE, AND WHAT IS NOT (stated plainly, task 24's standard) ─────────────────────
//   REAL:    the drain loop over the real `MediaTransportPort` (api/03 §3) and the real
//            `MediaFilePort`; crash recovery at start; §5.2 triggers (a)(b)(c)(e); the background
//            task registration WITH its Restricted outcome reported; the pruning actor; the
//            capture and signature pipelines; the render-time remote cache.
//   NOT REAL YET: nothing in a shipping USER FLOW calls `capturePhoto`/`captureSignature` — the
//            screens exist (`CaptureScreen.tsx`, `SignaturePadScreen.tsx`, both render-tested) but
//            the navigation entry and the op that embeds the returned `mediaRef` belong to task 25
//            (the notes module's attach). Until then `attach()` is the only thing that can make a
//            captured row DRAINABLE, since the drain selects `attached_to_operation_id IS NOT NULL`.
//            Said out loud because "the pipeline is wired" would otherwise read as "photos are
//            reaching the server", and they will when 25 lands, not before.
//   NOT VERIFIABLE HERE: anything requiring hardware. No camera, no Android device, no iOS device
//            (D12/D13). Every native call below is type-checked against the installed SDK 57
//            declarations and unexecuted; the LOGIC around them runs in the test lane.
import {
  MediaDrainLoop,
  recoverInterruptedUploads,
  findMediaItem,
  type ClockPort,
  type CryptoPort,
  type MediaDrainTrigger,
  type MediaFilePort,
  type MediaSurfacePort,
  type MediaSurfacing,
  type MediaTransportPort,
  type StorageBand,
  type TimerPort,
} from '@bolusi/core';
import type { ClientDatabase, ClientDb } from '@bolusi/db-client';

import {
  registerMediaDrainTask,
  type BackgroundRegistration,
  type BackgroundTaskPlatform,
} from './background-task.js';
import {
  capturePhoto,
  type CameraCapturePort,
  type CaptureIdentity,
  type CaptureOutcome,
} from './capture.js';
import { type ImageCompressorPort } from './compression.js';
import {
  createPruningPass,
  type PruneReason,
  type PruneReport,
  type RemoteCacheEntry,
} from './pruning.js';
import { attachMediaToOperation } from './queue.js';
import {
  loadMediaForRender,
  type RenderableMedia,
  type RenderableMediaRef,
} from './remote-cache.js';
import { captureSignature, type SignatureOutcome } from './signature.js';
import { type PadSize, type SignatureStroke } from './signature-png.js';
import { createMediaTriggers, type MediaTriggers } from './triggers.js';
import type { AppStatePort, NetInfoPort } from '../bootstrap/triggers.js';

/** Cap on the retained surfacing buffer — a device running for a week must not grow it unbounded. */
const SURFACE_BUFFER_MAX = 100;

export interface MediaClientDeps {
  readonly db: ClientDb;
  readonly transport: MediaTransportPort;
  readonly files: MediaFilePort;
  readonly compressor: ImageCompressorPort;
  readonly crypto: CryptoPort;
  readonly clock: ClockPort;
  readonly timer: TimerPort;
  readonly appState: AppStatePort;
  readonly netInfo: NetInfoPort;
  readonly freeSpaceBytes: () => number;
  readonly moveToDocuments: (
    cacheUri: string,
    mediaId: string,
    extension: string,
  ) => Promise<string>;
  readonly writeToCache: (bytes: Uint8Array, mediaId: string, extension: string) => string;
  readonly findCached: (mediaId: string, extension: string) => string | null;
  readonly writeCached: (mediaId: string, extension: string, bytes: Uint8Array) => string;
  readonly evictCached: (mediaId: string) => void;
  readonly listRemoteCache: () => readonly RemoteCacheEntry[];
  readonly newId: () => string;
  readonly location: { getBestFix(): { lat: number; lng: number; accuracyMeters: number } | null };
  /**
   * The `expo-background-task` binding, or `null` when there is none (Node, or a composition that
   * chose not to register one). `null` is an honest "trigger (d) is absent", which `start()` reports
   * as such — NOT a silently skipped registration.
   */
  readonly background: BackgroundTaskPlatform | null;
  readonly surface?: MediaSurfacePort;
  /** Where an un-awaited background rejection goes. Never swallowed (06 §8). */
  readonly onError: (error: unknown) => void;
}

/** What `start()` observed. Every field is a MEASURED outcome, not an assumption. */
export interface MediaStartReport {
  /**
   * Rows walked back `uploading → pending` by crash recovery, or `null` when the driver reports no
   * count. `null` is load-bearing (core's `recoverInterruptedUploads` explains it at length):
   * op-sqlite's `numAffectedRows` is unverified on device, so a caller gating on `> 0` would work in
   * every test and could silently never fire on a real phone.
   */
  readonly recovered: number | null;
  /** `null` when no platform was supplied — trigger (d) is absent, not failed. */
  readonly background: BackgroundRegistration | null;
  readonly prune: PruneReport | null;
}

export interface MediaClient {
  start(): Promise<MediaStartReport>;
  stop(): void;
  /** 06 §2.2. `camera` is per call — the `CameraView` ref lives in the screen that owns the preview. */
  capturePhoto(identity: CaptureIdentity, camera: CameraCapturePort): Promise<CaptureOutcome>;
  /** 06 §2.3. */
  captureSignature(
    identity: CaptureIdentity,
    strokes: readonly SignatureStroke[],
    pad: PadSize,
  ): Promise<SignatureOutcome>;
  /** 04 §5.1 step 5 — the command runtime's attach. Task 25 drives it from a real command. */
  attach(mediaId: string, operationId: string): Promise<void>;
  /** 06 §6, at render time only. */
  loadForRender(ref: RenderableMediaRef): Promise<RenderableMedia>;
  /** 06 §5.2 (e). */
  requestManual(): void;
  /** 06 §7. Exposed so a caller can force one; the client already runs it at start and after drains. */
  prune(reason: PruneReason): Promise<PruneReport | null>;
  /** The band from the last pruning pass — drives §7's storage banners. */
  storageBand(): StorageBand | null;
  /** 06 §8: every failed item, never silent. The DB stays the source of truth. */
  surfacings(): readonly MediaSurfacing[];
  /** Await the in-flight drain cycle. Deterministic tests only (T-6). */
  settle(): Promise<void>;
}

class MediaClientImpl implements MediaClient {
  private readonly loop: MediaDrainLoop<ClientDatabase>;
  private readonly triggers: MediaTriggers;
  private readonly pruning: ReturnType<typeof createPruningPass<ClientDatabase>>;
  private readonly surfaceBuffer: MediaSurfacing[] = [];

  constructor(private readonly deps: MediaClientDeps) {
    const surface: MediaSurfacePort = deps.surface ?? {
      emit: (event) => {
        this.surfaceBuffer.push(event);
        if (this.surfaceBuffer.length > SURFACE_BUFFER_MAX) this.surfaceBuffer.shift();
      },
    };

    this.loop = new MediaDrainLoop<ClientDatabase>({
      db: deps.db.db,
      transport: deps.transport,
      files: deps.files,
      clock: deps.clock,
      surface,
    });

    this.pruning = createPruningPass<ClientDatabase>({
      db: deps.db.db,
      files: deps.files,
      clock: deps.clock,
      freeSpaceBytes: deps.freeSpaceBytes,
      listRemoteCache: deps.listRemoteCache,
      evictRemoteCache: (id) => {
        deps.evictCached(id);
        return Promise.resolve();
      },
    });

    this.triggers = createMediaTriggers({
      requestDrain: (reason) => this.request(reason),
      onConnectivityRegained: () => this.loop.onConnectivityRegained(),
      timer: deps.timer,
      appState: deps.appState,
      netInfo: deps.netInfo,
      onTriggerError: deps.onError,
    });
  }

  async start(): Promise<MediaStartReport> {
    // 03 §4's crash recovery, FIRST and before any trigger: an `uploading` row with no live task is
    // a process that died mid-upload, and leaving it `uploading` makes it invisible to the drain
    // selection forever (which reads `pending`/`failed`). Resume is server-authoritative afterwards,
    // so nothing is re-sent that the server already holds (06 §5.1 step 2).
    const recovered = await recoverInterruptedUploads(this.deps.db.db);

    // §5.4's trigger (d). The outcome is REPORTED, never assumed — see background-task.ts's header
    // for why a resolved `registerTaskAsync` means nothing on its own.
    const background =
      this.deps.background === null
        ? null
        : await registerMediaDrainTask({
            platform: this.deps.background,
            requestDrain: (reason) => this.request(reason),
            settle: () => this.loop.settle(),
            timer: this.deps.timer,
          });

    // §7: "Pruning pass runs on app start". Before the triggers, so a device that booted nearly full
    // has already freed what it can before the first upload attempt reads free space.
    const prune = await this.pruning.run('app_start');

    this.triggers.start();
    return { recovered, background, prune };
  }

  stop(): void {
    this.triggers.stop();
  }

  capturePhoto(identity: CaptureIdentity, camera: CameraCapturePort): Promise<CaptureOutcome> {
    return capturePhoto({
      db: this.deps.db.db,
      identity,
      camera,
      compressor: this.deps.compressor,
      files: this.deps.files,
      moveToDocuments: this.deps.moveToDocuments,
      location: this.deps.location,
      clock: this.deps.clock,
      newId: this.deps.newId,
      freeSpaceBytes: this.deps.freeSpaceBytes,
      onCaptured: () => this.triggers.notifyCapture(),
    });
  }

  captureSignature(
    identity: CaptureIdentity,
    strokes: readonly SignatureStroke[],
    pad: PadSize,
  ): Promise<SignatureOutcome> {
    return captureSignature(
      {
        db: this.deps.db.db,
        identity,
        files: this.deps.files,
        writeToCache: this.deps.writeToCache,
        moveToDocuments: this.deps.moveToDocuments,
        location: this.deps.location,
        clock: this.deps.clock,
        newId: this.deps.newId,
        freeSpaceBytes: this.deps.freeSpaceBytes,
        onCaptured: () => this.triggers.notifyCapture(),
      },
      strokes,
      pad,
    );
  }

  async attach(mediaId: string, operationId: string): Promise<void> {
    await attachMediaToOperation(this.deps.db.db, mediaId, operationId);
    // A newly attached item is drainable for the first time, so this is a capture-class event.
    this.triggers.notifyCapture();
  }

  loadForRender(ref: RenderableMediaRef): Promise<RenderableMedia> {
    return loadMediaForRender(
      {
        transport: this.deps.transport,
        crypto: this.deps.crypto,
        files: this.deps.files,
        localPathFor: async (mediaId) =>
          (await findMediaItem(this.deps.db.db, mediaId))?.localPath ?? null,
        findCached: this.deps.findCached,
        writeCached: this.deps.writeCached,
        evictCached: this.deps.evictCached,
      },
      ref,
    );
  }

  requestManual(): void {
    this.triggers.requestManual();
  }

  prune(reason: PruneReason): Promise<PruneReport | null> {
    return this.pruning.run(reason);
  }

  storageBand(): StorageBand | null {
    return this.pruning.lastBand();
  }

  surfacings(): readonly MediaSurfacing[] {
    return this.surfaceBuffer;
  }

  settle(): Promise<void> {
    return this.loop.settle();
  }

  /**
   * Every trigger goes through here so §7's "after every successful drain pass" has ONE home.
   *
   * The drain loop never throws to its caller (drain.ts) — it speaks through `media_items` and the
   * surfacing port — so the `catch` below is for a genuinely unexpected rejection, not for control
   * flow. The pruning run is deliberately AFTER `settle()`: pruning before a pass would evaluate
   * retention against `uploadedAt` values the pass is about to write.
   */
  private request(reason: MediaDrainTrigger): void {
    this.loop.requestDrain(reason);
    void this.loop
      .settle()
      .then(() => this.pruning.run('after_drain'))
      .then(() => undefined)
      .catch(this.deps.onError);
  }
}

export function createMediaClient(deps: MediaClientDeps): MediaClient {
  return new MediaClientImpl(deps);
}
