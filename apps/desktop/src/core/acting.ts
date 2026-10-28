// Who a window call may act as: the person signed in and unlocked on this PC now. Every PIN and
// staff call names its person, and a call for anyone else (a stale screen after a switch, a call
// while the screen is locked) is refused before it reaches the shared session.
import { DomainError, StaffAdminError } from '@bolusi/core';
import type { AppSessionController } from '@bolusi/device/bootstrap/session';

function isActing(session: AppSessionController | null, userId: string): boolean {
  const snapshot = session?.snapshot();
  return snapshot !== undefined && snapshot.session?.userId === userId && !snapshot.locked;
}

export function actingSession(
  session: AppSessionController | null,
  userId: string,
): AppSessionController {
  if (session === null || !isActing(session, userId)) throw new DomainError('NOT_AUTHENTICATED');
  return session;
}

/**
 * Read something for `userId` and keep it only if they are still the one acting when the read
 * lands. A switch or a lock can happen while it runs: a result read for the person who just left
 * must never be installed for the screens of the person who came in.
 */
export async function readForActing<T>(
  current: () => AppSessionController | null,
  userId: string,
  read: (userId: string) => Promise<T | null>,
): Promise<T | null> {
  const value = await read(userId);
  return value !== null && isActing(current(), userId) ? value : null;
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
