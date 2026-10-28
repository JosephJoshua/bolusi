// Composes "Karyawan" (owner decision 2026-10-27): the server calls of `StaffAdminPort`, made as the
// signed-in owner for this device's store, each followed by a directory refresh so the screen reads
// the server's answer, not a guess. NODE-SAFE: core types and injected functions only.
import {
  StaffAdminError,
  type StaffAdminPort,
  type StaffDirectory,
  type StaffDraft,
} from '@bolusi/core';

/** What "Karyawan" needs from the composition root: reads and server-backed changes. */
export interface StaffControls {
  /** The signed-in user is a main owner (may make and manage owners). */
  readonly tenantAdmin: boolean;
  readonly load: () => Promise<StaffDirectory>;
  /** Each resolves once the server applied the change and this phone's directory caught up;
   *  each REJECTS with a `StaffAdminError`. */
  readonly onCreate: (draft: StaffDraft) => Promise<{ readonly userId: string }>;
  readonly onUpdate: (
    userId: string,
    change: { readonly name?: string; readonly roleIds?: readonly string[] },
  ) => Promise<void>;
  readonly onSetActive: (userId: string, active: boolean) => Promise<void>;
}

export interface StaffControlsDeps {
  readonly port: StaffAdminPort;
  readonly tenantAdmin: boolean;
  readonly load: () => Promise<StaffDirectory>;
  /** The signed-in owner and this device's store; null with no session. */
  readonly context: () => { readonly actingUserId: string; readonly storeId: string } | null;
  /**
   * Pull the server's directory into this phone (a sync cycle, whose bundle refresh rewrites the
   * mirrors). Never rejects in a way that undoes the change: the server already has it.
   */
  readonly refreshDirectory: () => Promise<void>;
}

export function createStaffControls(deps: StaffControlsDeps): StaffControls {
  const context = (): { readonly actingUserId: string; readonly storeId: string } => {
    const current = deps.context();
    // Unreachable from the screen (it is behind a session), so never sent anonymously.
    if (current === null) throw new StaffAdminError('denied');
    return current;
  };
  const thenRefresh = async <T>(change: Promise<T>): Promise<T> => {
    const result = await change;
    await deps.refreshDirectory().catch(() => undefined);
    return result;
  };

  return {
    tenantAdmin: deps.tenantAdmin,
    load: deps.load,
    onCreate: async (draft) => {
      const { actingUserId, storeId } = context();
      return thenRefresh(
        deps.port.create({ actingUserId, storeId, name: draft.name, roleIds: draft.roleIds }),
      );
    },
    onUpdate: async (userId, change) =>
      thenRefresh(deps.port.update({ actingUserId: context().actingUserId, userId, ...change })),
    onSetActive: async (userId, active) =>
      thenRefresh(deps.port.setActive({ actingUserId: context().actingUserId, userId, active })),
  };
}
