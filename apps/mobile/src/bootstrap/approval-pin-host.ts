// The approval PIN prompt's host on the phone: holds what a decision waits on while the prompt is
// shown over the screen that asked, and opens it from Settings to set or change the PIN. A lock or
// a switch answers "not approved", so a prompt never outlives its person.
import type { ApprovalPinProof, StaffAdminPort } from '@bolusi/core';
import { createApprovalPinControls } from '@bolusi/device/bootstrap/approval-pin';
import type { DecisionOpening } from '@bolusi/device/bootstrap/person-access';
import type { AppSessionController } from '@bolusi/device/bootstrap/session';
import { proofKindsFor } from '@bolusi/device/models/approval-pin/model';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ApprovalPinScreenProps } from '../screens/pin/ApprovalPinScreen.js';

export interface ApprovalPinHost {
  /** Ask the signed-in `userId` for it; resolves whether a decision session opened. */
  readonly ask: (userId: string) => Promise<boolean>;
  /** Settings: set or change it. Absent for someone who makes no decisions. */
  readonly openSetup: (() => void) | undefined;
  /** What the shell shows over the screen while it is open, else null. */
  readonly surface: ApprovalPinScreenProps | null;
}

export function useApprovalPinHost(deps: {
  readonly session: AppSessionController | null;
  readonly staffAdmin: StaffAdminPort | undefined;
}): ApprovalPinHost {
  const snapshot = deps.session?.snapshot() ?? null;
  const userId = snapshot !== null && !snapshot.locked ? (snapshot.session?.userId ?? null) : null;
  const users = snapshot?.users ?? null;
  const tenantAdmin = snapshot?.tenantAdmin ?? false;
  const personalDevice = snapshot?.personalDevice ?? false;
  const [mode, setMode] = useState<'ask' | 'setup' | null>(null);
  const pending = useRef<((ok: boolean) => void) | null>(null);

  const finish = useCallback((ok: boolean) => {
    const resolve = pending.current;
    pending.current = null;
    setMode(null);
    resolve?.(ok);
  }, []);

  // Whoever the prompt was for left: nothing is approved in their name.
  useEffect(() => finish(false), [userId, finish]);

  const ask = useCallback(
    (asking: string): Promise<boolean> => {
      if (asking !== userId || pending.current !== null) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        pending.current = resolve;
        setMode('ask');
      });
    },
    [userId],
  );

  const { session, staffAdmin } = deps;
  const port = useMemo(() => {
    if (session === null || staffAdmin === undefined) return null;
    const controls = createApprovalPinControls({ port: staffAdmin, session });
    return {
      open: (pin: string): Promise<DecisionOpening> => session.openDecision(pin),
      set: (pin: string, proof: ApprovalPinProof | undefined) => controls.set(pin, proof),
    };
  }, [session, staffAdmin]);

  const owners = useMemo(
    () =>
      (users ?? [])
        .filter((user) => user.id !== userId && user.roleKeys.some(isOwnerRole))
        .map((user) => ({ userId: user.id, name: user.name })),
    [users, userId],
  );
  const person = users?.find((user) => user.id === userId) ?? null;

  return {
    ask,
    openSetup:
      snapshot?.makesDecisions === true && port !== null ? () => setMode('setup') : undefined,
    surface:
      mode === null || port === null || person === null
        ? null
        : {
            mode,
            person: { id: person.id, name: person.name, roleKeys: person.roleKeys },
            port,
            proofKinds: proofKindsFor({ personalDevice, tenantAdmin, mayHaveOne: true }),
            owners,
            onDone: finish,
          },
  };
}

function isOwnerRole(roleKey: string): boolean {
  return roleKey === 'main_owner' || roleKey === 'store_owner';
}
