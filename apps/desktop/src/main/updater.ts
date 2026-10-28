// Updates from GitHub Releases: an installed app checks quietly in the background, downloads a
// new version while the counter keeps working, and installs it when the app closes or the counter
// has been quiet for a while (`update-policy.ts`). The title bar offers to restart now once it is
// ready. Offline is normal here, so a failed check just tries again later.
import { app, ipcMain, powerMonitor, type IpcMainInvokeEvent, type WebContents } from 'electron';
import electronUpdater from 'electron-updater';

import { UpdatePolicy } from './update-policy.js';

export interface UpdateDeps {
  readonly trusted: (event: IpcMainInvokeEvent) => boolean;
  readonly windows: () => readonly WebContents[];
  /** A print job is still on its way to the printer. */
  readonly printing: () => boolean;
  /** Close the core's database before the installer replaces the app. */
  readonly stopCore: () => Promise<void>;
}

export function registerUpdates(deps: UpdateDeps): void {
  const { autoUpdater } = electronUpdater;
  // The page says when it has a dialog open: someone is in the middle of something.
  let pageBusy = false;
  const policy = new UpdatePolicy({
    source: {
      check: () => autoUpdater.checkForUpdates().then(() => undefined),
      // Silent: the installer runs without its wizard and opens the app again.
      install: () => autoUpdater.quitAndInstall(true, true),
    },
    idleSeconds: () => powerMonitor.getSystemIdleTime(),
    busy: () => pageBusy || deps.printing(),
    stopCore: deps.stopCore,
    relaunch: () => {
      app.relaunch();
      app.exit(0);
    },
    onState: (state) => {
      for (const contents of deps.windows()) contents.send('updates:changed', state);
    },
  });

  ipcMain.handle('updates:version', (event) => {
    if (!deps.trusted(event)) throw new Error('updates:version: refused');
    return app.getVersion();
  });
  ipcMain.handle('updates:state', (event) => {
    if (!deps.trusted(event)) throw new Error('updates:state: refused');
    return policy.current();
  });
  ipcMain.handle('updates:install', (event) => {
    if (!deps.trusted(event)) throw new Error('updates:install: refused');
    return policy.install();
  });
  ipcMain.on('updates:busy', (event, busy: unknown) => {
    if (deps.trusted(event) && typeof busy === 'boolean') pageBusy = busy;
  });

  // A build run from the source tree has nothing to update.
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.on('update-available', () => policy.downloading());
  autoUpdater.on('update-downloaded', (info) => policy.downloaded(info.version));
  autoUpdater.on('error', (error) => {
    console.warn('update:', error.message);
    policy.failed();
  });
  // Windows is shutting down: an installer started now could be cut off half way, leaving an app
  // that does not open. It installs at the next close or quiet spell instead.
  app.on('browser-window-created', (_event, window) => {
    window.on('session-end', () => {
      autoUpdater.autoInstallOnAppQuit = false;
    });
  });
  policy.start();
}
