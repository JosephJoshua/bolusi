// When a phone moves to a downloaded over-the-air update (docs/app-updates.md). expo-updates checks
// on every start and downloads in the background; the new version then runs from the next start,
// never under someone mid-intake. Store phones keep the app open for days, so a phone back in the
// app after a long break (its idle lock has long since asked for a PIN, and drafts survive a
// restart) also checks, and restarts into a version that is already downloaded.
import type { AppStatePort } from '@bolusi/device/bootstrap/triggers';

/** Away from the app this long counts as a break that a restart will not interrupt. */
export const BREAK_MS = 30 * 60_000;

/** The slice of expo-updates this needs; bound to the real module in `src/ports/updates.ts`. */
export interface UpdatesPort {
  /** False in development and test builds, which run the code they were built from. */
  readonly isEnabled: boolean;
  /** A newer update is downloaded and waits for the next start (including one fetched at start). */
  pending(): boolean;
  /** Ask the server and download a newer update, if there is one. */
  downloadNewer(): Promise<void>;
  /** Restart the app into the downloaded update. */
  reload(): Promise<void>;
}

export interface AppUpdaterDeps {
  readonly updates: UpdatesPort;
  readonly appState: AppStatePort;
  readonly now: () => number;
  readonly onError?: (error: unknown) => void;
}

/** What "Cek pembaruan" found: a restart into a new version, or nothing newer yet. */
export type UpdateCheckResult = 'restarting' | 'none';

/** Fetch a newer update now and restart into it; the person asked, so nobody is mid-task. */
export async function updateNow(updates: UpdatesPort): Promise<UpdateCheckResult> {
  if (!updates.pending()) await updates.downloadNewer();
  if (!updates.pending()) return 'none';
  await updates.reload();
  return 'restarting';
}

/** Start watching for breaks; returns the stop. */
export function startAppUpdates(deps: AppUpdaterDeps): () => void {
  if (!deps.updates.isEnabled) return () => undefined;
  let leftAt: number | null = deps.appState.current() === 'active' ? null : deps.now();
  let checking = false;

  const check = async (): Promise<void> => {
    if (checking) return;
    checking = true;
    try {
      await deps.updates.downloadNewer();
    } catch (error) {
      // Offline or the server is away: the next start or break asks again.
      deps.onError?.(error);
    } finally {
      checking = false;
    }
  };

  return deps.appState.subscribe((status) => {
    if (status !== 'active') {
      leftAt ??= deps.now();
      return;
    }
    const away = leftAt === null ? 0 : deps.now() - leftAt;
    leftAt = null;
    if (away < BREAK_MS) return;
    // Restart before anyone has touched anything; a download started now waits for the next break.
    if (deps.updates.pending()) {
      deps.updates.reload().catch((error: unknown) => deps.onError?.(error));
      return;
    }
    void check();
  });
}
