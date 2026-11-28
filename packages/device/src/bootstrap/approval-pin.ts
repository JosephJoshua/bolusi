// The approval PIN of owners and managers (owner decision 2026-11-25): set, changed and cleared on
// the server, which alone checks it (server auth/approval-pins.ts). Online only, like "Karyawan": a
// device never holds it. NODE-SAFE.
import { StaffAdminError, type ApprovalPinProof, type StaffAdminPort } from '@bolusi/core';

import type { AppSessionController } from './session.js';

export interface ApprovalPinControls {
  /**
   * Set the signed-in person's own approval PIN. `proof` is needed off their own phone. Resolves once
   * the server took it; REJECTS with a `StaffAdminError`.
   */
  readonly set: (pin: string, proof?: ApprovalPinProof) => Promise<void>;
  /** Clear a colleague's forgotten one, confirmed with the signed-in owner's own approval PIN. */
  readonly clear: (targetUserId: string, ownPin: string) => Promise<void>;
}

export function createApprovalPinControls(deps: {
  readonly port: StaffAdminPort;
  readonly session: Pick<AppSessionController, 'staffContext'>;
}): ApprovalPinControls {
  const actingUserId = (): string => {
    const current = deps.session.staffContext();
    // Behind a session on every screen, so never sent anonymously.
    if (current === null) throw new StaffAdminError('denied');
    return current.actingUserId;
  };
  return {
    set: (pin, proof) =>
      deps.port.setApprovalPin({
        actingUserId: actingUserId(),
        pin,
        ...(proof === undefined ? {} : { proof }),
      }),
    clear: (targetUserId, ownPin) =>
      deps.port.clearApprovalPin({ actingUserId: actingUserId(), targetUserId, pin: ownPin }),
  };
}
