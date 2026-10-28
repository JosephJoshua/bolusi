// Updates from GitHub Releases: an installed app checks quietly in the background, downloads a
// new version while the counter keeps working, and installs it the next time the app closes. The
// sidebar offers to restart now once it is ready. Offline is normal here, so a failed check just
// waits for the next one.
import { app, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import electronUpdater from 'electron-updater';

import type { UpdateState } from './bridge.js';

// Not during start-up, which is the slowest moment on a 4 GB PC, and then a few times a day.
const FIRST_CHECK_MS = 60_000;
const CHECK_EVERY_MS = 4 * 60 * 60_000;

export function registerUpdates(
  trusted: (event: IpcMainInvokeEvent) => boolean,
  windows: () => readonly WebContents[],
): void {
  let state: UpdateState = { kind: 'none' };
  const set = (next: UpdateState): void => {
    state = next;
    for (const contents of windows()) contents.send('updates:changed', state);
  };

  ipcMain.handle('updates:version', (event) => {
    if (!trusted(event)) throw new Error('updates:version: refused');
    return app.getVersion();
  });
  ipcMain.handle('updates:state', (event) => {
    if (!trusted(event)) throw new Error('updates:state: refused');
    return state;
  });
  ipcMain.handle('updates:install', (event) => {
    if (!trusted(event)) throw new Error('updates:install: refused');
    if (state.kind !== 'ready') return;
    // Silent: the installer runs without its wizard and opens the app again.
    electronUpdater.autoUpdater.quitAndInstall(true, true);
  });

  // A build run from the source tree has nothing to update.
  if (!app.isPackaged) return;

  const { autoUpdater } = electronUpdater;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.on('update-available', () => set({ kind: 'downloading' }));
  autoUpdater.on('update-downloaded', (info) => set({ kind: 'ready', version: info.version }));
  autoUpdater.on('error', (error) => {
    console.warn('update:', error.message);
    if (state.kind === 'downloading') set({ kind: 'none' });
  });

  const check = (): void => {
    if (state.kind === 'ready') return;
    autoUpdater.checkForUpdates().catch(() => undefined);
  };
  setTimeout(check, FIRST_CHECK_MS);
  setInterval(check, CHECK_EVERY_MS);
}
