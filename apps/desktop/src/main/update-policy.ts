// When the counter PC looks for, and moves to, a new version. Kept apart from Electron so the rules
// can be tested: check quietly (never during start-up, which is the slowest moment on a 4 GB PC),
// retry soon after a failed download (flaky internet is normal), and install only when nobody is
// using the counter: when the app closes, or after a long quiet spell with no dialog open and no
// print on its way. The core closes its database before the installer starts, so an update never
// cuts a write.
import type { UpdateState } from './bridge.js';

export const FIRST_CHECK_MS = 60_000;
export const CHECK_EVERY_MS = 4 * 60 * 60_000;
export const RETRY_AFTER_FAILURE_MS = 30 * 60_000;
/** No keyboard or mouse on the PC for this long counts as nobody at the counter. */
export const IDLE_INSTALL_SECONDS = 15 * 60;
export const IDLE_POLL_MS = 60_000;
/** The installer closes the app within seconds; still running after this means it never started. */
export const INSTALL_STALL_MS = 30_000;

export interface UpdateSource {
  /** Ask for the latest release; a newer one downloads in the background. Rejects when offline. */
  check(): Promise<void>;
  /** Start the downloaded version's installer and quit; it opens the app again when done. */
  install(): void;
}

export interface UpdatePolicyDeps {
  readonly source: UpdateSource;
  /** Seconds since the last keyboard or mouse input anywhere on the PC. */
  readonly idleSeconds: () => number;
  /** A dialog is open on the counter (a camera, a phone handoff, a print) or a print is running. */
  readonly busy: () => boolean;
  /** Close the core's database and stop it. */
  readonly stopCore: () => Promise<void>;
  /** Start the app again, for when the installer did not take over. */
  readonly relaunch: () => void;
  readonly onState: (state: UpdateState) => void;
}

export class UpdatePolicy {
  private state: UpdateState = { kind: 'none' };
  private checkTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private installing = false;

  constructor(private readonly deps: UpdatePolicyDeps) {}

  current(): UpdateState {
    return this.state;
  }

  start(): void {
    this.scheduleCheck(FIRST_CHECK_MS);
  }

  /** The source found a newer version and started downloading it. */
  downloading(): void {
    if (this.state.kind === 'none') this.set({ kind: 'downloading' });
  }

  /** The new version is on disk: install it at the next quiet moment. */
  downloaded(version: string): void {
    this.clearCheck();
    this.set({ kind: 'ready', version });
    this.idleTimer ??= setInterval(() => {
      if (this.deps.idleSeconds() >= IDLE_INSTALL_SECONDS && !this.deps.busy()) {
        void this.install();
      }
    }, IDLE_POLL_MS);
  }

  /** A check or download failed (usually no internet): try again soon. */
  failed(): void {
    if (this.installing) {
      // The installer could not start after the core was closed: come back as we were.
      this.deps.relaunch();
      return;
    }
    if (this.state.kind === 'ready') return;
    if (this.state.kind === 'downloading') this.set({ kind: 'none' });
    this.scheduleCheck(RETRY_AFTER_FAILURE_MS);
  }

  /** Install now (a person chose to, or the counter is quiet). */
  async install(): Promise<void> {
    if (this.state.kind !== 'ready' || this.installing) return;
    this.installing = true;
    this.clearIdle();
    await this.deps.stopCore();
    setTimeout(() => this.deps.relaunch(), INSTALL_STALL_MS);
    this.deps.source.install();
  }

  private check(): void {
    if (this.state.kind === 'ready') return;
    this.deps.source.check().then(
      () => {
        if (this.state.kind !== 'ready') this.scheduleCheck(CHECK_EVERY_MS);
      },
      () => this.failed(),
    );
  }

  private scheduleCheck(ms: number): void {
    this.clearCheck();
    this.checkTimer = setTimeout(() => {
      this.checkTimer = null;
      this.check();
    }, ms);
  }

  private clearCheck(): void {
    if (this.checkTimer !== null) clearTimeout(this.checkTimer);
    this.checkTimer = null;
  }

  private clearIdle(): void {
    if (this.idleTimer !== null) clearInterval(this.idleTimer);
    this.idleTimer = null;
  }

  private set(next: UpdateState): void {
    this.state = next;
    this.deps.onState(next);
  }
}
