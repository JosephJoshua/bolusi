// The repair screens' runtime port (04 §7), the same pattern as notes: screens read and write
// through a small typed port the platform binds, never the database or the op log. The commands and
// queries come straight from the module through `ModulePort`, so a new command needs no new wiring.
import { useEffect, useRef, useState, type ReactNode } from 'react';

import type { ModulePort } from '@bolusi/core';

import type { IntakeOptionSettings } from '../intake-options.js';
import type { DeviceModelPhoto } from '../device-models.js';
import type { repairModule } from '../manifest.js';
import {
  createRuntimeContext,
  useLiveQuery,
  useThumbnailState,
  type EntitySyncStatuses,
  type LiveSource,
  type PhotoCapture,
  type QueryState,
  type SignatureCapture,
  type ThumbnailLoader,
  type ThumbnailRef,
  type ThumbnailState,
} from '../../screen-kit/index.js';

/** A colleague who can work repairs here, for the "assign to" picker. */
export interface RepairTechnician {
  readonly id: string;
  readonly name: string;
}

export interface RepairRuntime extends ModulePort<typeof repairModule>, LiveSource {
  /** Op sync statuses per ticket id (design-system §3.5); an absent ticket is all-synced. */
  ticketSyncStatuses(ticketIds: readonly string[]): Promise<EntitySyncStatuses>;
  /** Active colleagues who hold `repair.work` in this store, by name. */
  technicians(): Promise<readonly RepairTechnician[]>;
  readonly capturePhoto: PhotoCapture;
  readonly captureSignature: SignatureCapture;
  readonly loadThumbnail: ThumbnailLoader;
  /**
   * A catalog photo of a phone model, downloaded the first time it is shown and cached. Resolves
   * null when it cannot be had now (offline, not on the server): the screen shows no picture.
   */
  readonly loadModelPhoto: (photo: DeviceModelPhoto) => Promise<string | null>;
  /**
   * Hand one photo to the platform to save or send (the share sheet on a phone, a download on the
   * web). Absent ⇒ this build cannot, and the photo viewer shows no share button.
   */
  readonly sharePhoto?: ((ref: ThumbnailRef) => Promise<'done' | 'failed'>) | undefined;
}

const RepairRuntimeContext = createRuntimeContext<RepairRuntime>('repair');

export function RepairRuntimeProvider({
  runtime,
  children,
}: {
  readonly runtime: RepairRuntime;
  readonly children: ReactNode;
}): React.JSX.Element {
  return (
    <RepairRuntimeContext.Provider runtime={runtime}>{children}</RepairRuntimeContext.Provider>
  );
}

export const useRepairRuntime = RepairRuntimeContext.useRuntime;

/** A repair read kept live across local and pulled changes (04 §7). */
export function useRepairQuery<TData>(
  run: (runtime: RepairRuntime) => Promise<TData>,
  key: string,
): QueryState<TData> {
  return useLiveQuery(useRepairRuntime(), run, key);
}

export function useRepairThumbnail(ref: ThumbnailRef | null): ThumbnailState {
  return useThumbnailState(useRepairRuntime().loadThumbnail, ref);
}

/** The franchise's intake lists and this store's hidden items, kept live as either syncs in. */
export function useIntakeOptionSettings(): QueryState<IntakeOptionSettings> {
  return useRepairQuery(
    async (rt) => (await rt.query('intakeOptionSettings', {})).rows[0]!,
    'intakeOptionSettings',
  );
}

/** A model photo's uri once loaded; null while loading or when there is none to show. */
export function useModelPhoto(photo: DeviceModelPhoto | null): string | null {
  const load = useRepairRuntime().loadModelPhoto;
  const loadRef = useRef(load);
  loadRef.current = load;
  const key = photo === null ? null : `${photo.modelId}:${photo.sha256}`;
  const [loaded, setLoaded] = useState<{ key: string; uri: string | null } | null>(null);
  useEffect(() => {
    if (photo === null || key === null) return;
    let active = true;
    loadRef.current(photo).then(
      (uri) => {
        if (active) setLoaded({ key, uri });
      },
      () => {
        if (active) setLoaded({ key, uri: null });
      },
    );
    return () => {
      active = false;
    };
    // The key is the photo's identity; a new object for the same photo must not reload it.
  }, [key]);
  return loaded !== null && loaded.key === key ? loaded.uri : null;
}
