// When to ask for the notification permission (Android 13+ POST_NOTIFICATIONS, iOS alert permission).
//
// The app never asked, so on Android 13+ every sync-conflict and device notification was silently
// blocked. Asking at boot, before the person has seen the app, gets a reflexive "Don't allow". So the
// shell asks ONCE, after someone unlocks on an enrolled device, with a sheet that says why first; the
// OS prompt only follows "Nyalakan". "Nanti saja" is final too: the app never asks again on its own,
// and the Settings notification rows (which open the OS settings) remain the way back. Android 12 and
// older grant it at install, so they report `granted` and are never asked.
//
// Node-safe: `expo-notifications` is bound at index.ts behind this port, like the tap router.

/** One OS permission (notifications, the camera), as the shell and the new-phone setup ask it. */
export interface PermissionPort {
  /** The OS answer so far. `canAskAgain` is false once the OS will no longer show its prompt. */
  status(): Promise<{ readonly granted: boolean; readonly canAskAgain: boolean }>;
  /** Shows the OS prompt. */
  request(): Promise<void>;
}

export interface NotificationPermissionPort extends PermissionPort {
  /** Whether this device already showed our sheet, whatever the answer. */
  readAsked(): Promise<boolean>;
  writeAsked(): Promise<void>;
}

/** True only for a device that never saw the sheet and whose OS can still prompt. Never throws. */
export async function shouldAskForNotifications(
  port: NotificationPermissionPort,
): Promise<boolean> {
  try {
    if (await port.readAsked()) return false;
    const { granted, canAskAgain } = await port.status();
    return !granted && canAskAgain;
  } catch {
    return false;
  }
}

/** Records the answer first, so a failing OS prompt can never turn into a sheet on every unlock. */
export async function answerNotificationAsk(
  port: NotificationPermissionPort,
  allow: boolean,
): Promise<void> {
  try {
    await port.writeAsked();
    if (allow) await port.request();
  } catch {
    // Best-effort, like push itself: a refused or failed prompt leaves the app fully usable.
  }
}
