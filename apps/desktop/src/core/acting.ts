// Who a window call may act as: the person signed in and unlocked on this PC now. Every PIN and
// staff call names its person, and a call for anyone else (a stale screen after a switch, a call
// while the screen is locked) is refused before it reaches the shared session.
import { DomainError, StaffAdminError } from '@bolusi/core';
import type { AppSessionController } from '@bolusi/device/bootstrap/session';

export function actingSession(
  session: AppSessionController | null,
  userId: string,
): AppSessionController {
  const snapshot = session?.snapshot();
  if (session === null || snapshot?.session?.userId !== userId || snapshot.locked) {
    throw new DomainError('NOT_AUTHENTICATED');
  }
  return session;
}

/** The same, for "Karyawan": only someone who may add staff here; the server decides each change. */
export function actingStaffAdmin(
  session: AppSessionController | null,
  userId: string,
): AppSessionController {
  const current = actingSession(session, userId);
  if (!current.snapshot().canManageStaff) throw new StaffAdminError('denied');
  return current;
}

/** The same, for renaming this PC: only someone who may register devices here. */
export function actingDeviceAdmin(
  session: AppSessionController | null,
  userId: string,
): AppSessionController {
  const current = actingSession(session, userId);
  if (!current.snapshot().canRenameDevice) throw new StaffAdminError('denied');
  return current;
}
