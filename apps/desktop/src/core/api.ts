// What the window and the offline core say to each other: the state the core pushes, and the
// event names. Types only, so both sides share them without either bundling the other.
import type { ActiveSession, PinAttemptRow } from '@bolusi/core';
import type { DeviceInfo } from '@bolusi/device/models/settings/model';
import type { SwitcherUser } from '@bolusi/device/models/switcher/model';
import type { SyncStatusInput } from '@bolusi/device/models/sync-status/model';
import type { DeviceStatus } from '@bolusi/device/navigation/zone';
import type { LockReason } from '@bolusi/device/session/shell-session';
import type { UserWorkspace } from '@bolusi/device/state/user-workspaces';
import type { MediaRef } from '@bolusi/schemas';

/** The PIN session as the window renders it. */
export interface SessionView {
  readonly active: ActiveSession | null;
  readonly users: readonly SwitcherUser[] | null;
  readonly usersError: string | null;
  /** Each listed person's attempt row on this PC, for the pad's lockout view. */
  readonly pinRows: Readonly<Record<string, PinAttemptRow | null>>;
  readonly locked: boolean;
  readonly lockReason: LockReason | null;
  readonly workspace: UserWorkspace | null;
  readonly canUnlock: boolean;
  readonly canReset: boolean;
  readonly canManageStaff: boolean;
  /** May set limited roles' amounts at this store (`auth.limit_manage`). */
  readonly canSetLimits: boolean;
  readonly tenantAdmin: boolean;
  /**
   * Every module's permissions the signed-in person holds (repair's, money's, ...), for showing
   * actions; the core enforces.
   */
  readonly permissions: readonly string[];
  /** The same for each colleague, for pickers. */
  readonly colleaguePermissions: Readonly<Record<string, readonly string[]>>;
  /** For each of those permissions, how far the person may use it (`ModulePort.limitOf`). */
  readonly limits: Readonly<Record<string, number | null>>;
}

export interface CoreState {
  /** `failed`: the database could not be opened; `bootError` says why (for support, not people). */
  readonly phase: 'booting' | 'ready' | 'failed';
  readonly bootError: string | null;
  readonly device: DeviceStatus;
  readonly deviceInfo: DeviceInfo | null;
  /** Null before the PC is enrolled. */
  readonly session: SessionView | null;
  /** Null until the core has booted. */
  readonly sync: SyncStatusInput | null;
}

/** Events the core pushes to the window. */
export const CORE_EVENTS = {
  state: 'state',
  repairChanged: 'repair.changed',
  handoff: 'handoff',
} as const;

/** What a photo or signature handed to the core became. */
export type CoreCaptureOutcome =
  | { readonly kind: 'captured'; readonly mediaRef: MediaRef }
  | { readonly kind: 'refused_low_storage' }
  | { readonly kind: 'refused_empty' };

/** The phone handoff (core/handoff.ts): a new pairing's id and the page the phone opens. */
export type HandoffOpened =
  | { readonly ok: true; readonly id: string; readonly urls: readonly string[] }
  /** The PC cannot reach the server, or the server would not pair. */
  | { readonly ok: false; readonly problem: 'offline' | 'failed' };

/** What the core passes on from the paired phone, by the pairing's id. */
export type HandoffEvent =
  /** The phone opened the page; or the pairing ended (expired, or replaced elsewhere). */
  | { readonly id: string; readonly type: 'paired' | 'expired' }
  | {
      readonly id: string;
      readonly type: 'photo';
      readonly seq: number;
      readonly bytes: Uint8Array;
    }
  | {
      readonly id: string;
      readonly type: 'signature';
      readonly seq: number;
      readonly strokes: readonly (readonly { readonly x: number; readonly y: number }[])[];
      readonly pad: { readonly width: number; readonly height: number };
    };
