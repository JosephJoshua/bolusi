// The Electron main process: one locked-down window for the counter screens. The renderer gets no
// Node and no way to open other pages; the preload gives it a few narrow calls (`bridge.ts`):
// printing and updates for now, the offline core next.
import { app, BrowserWindow, session, type IpcMainInvokeEvent } from 'electron';
import { fileURLToPath } from 'node:url';

import { DeviceSettingsFile } from './device-settings.js';
import { registerPrinting } from './printing.js';
import { registerUpdates } from './updater.js';

// The dev server is for development only; an installed app never loads a page from elsewhere.
const DEV_SERVER_URL = app.isPackaged ? undefined : process.env['BOLUSI_DESKTOP_DEV_URL'];
const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set(['clipboard-sanitized-write']);
const RENDERER_INDEX = fileURLToPath(new URL('../renderer/index.html', import.meta.url));
const PRELOAD = fileURLToPath(new URL('./preload.cjs', import.meta.url));

/** The counter windows this process opened; only their own page may call in. */
const counterWindows = new Set<BrowserWindow>();

function trusted(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  if (frame === null || frame !== event.sender.mainFrame) return false;
  return [...counterWindows].some((window) => window.webContents === event.sender);
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1366,
    height: 768,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
      preload: PRELOAD,
    },
  });
  counterWindows.add(window);
  window.on('closed', () => counterWindows.delete(window));
  window.once('ready-to-show', () => window.show());

  // The app is one page: nothing navigates it or opens another window. Opening a link in the
  // browser waits for a feature that needs it, with a list of the hosts it may open.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());

  if (DEV_SERVER_URL !== undefined) void window.loadURL(DEV_SERVER_URL);
  else void window.loadFile(RENDERER_INDEX);
}

// Indonesian for what Chromium draws itself, such as a date field's dd/mm/yyyy order.
app.commandLine.appendSwitch('lang', 'id');

// One counter window per PC: a second launch (a double click on the shortcut) brings the open one
// forward instead of starting a second copy over the same local data.
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
app.on('second-instance', () => {
  const [window] = BrowserWindow.getAllWindows();
  if (window === undefined) return;
  if (window.isMinimized()) window.restore();
  window.focus();
});

void app.whenReady().then(() => {
  if (!primary) return;
  // Only copying (a phone number) and the webcam are allowed: no microphone, location or other
  // device.
  const counter = (contents: Electron.WebContents | null): boolean =>
    contents !== null && [...counterWindows].some((window) => window.webContents === contents);
  // The webcam for intake and handover photos, video only and only for the counter's own page.
  const camera = (permission: string, kinds: readonly string[] | undefined): boolean =>
    permission === 'media' &&
    kinds !== undefined &&
    kinds.length > 0 &&
    kinds.every((kind) => kind === 'video');
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const kinds = 'mediaTypes' in details ? details.mediaTypes : undefined;
    callback(
      ALLOWED_PERMISSIONS.has(permission) || (counter(contents) && camera(permission, kinds)),
    );
  });
  session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) => {
    const kind = details.mediaType;
    return (
      ALLOWED_PERMISSIONS.has(permission) ||
      (counter(contents) && camera(permission, kind === undefined ? undefined : [kind]))
    );
  });
  registerPrinting(new DeviceSettingsFile(app.getPath('userData')), trusted);
  registerUpdates(trusted, () => [...counterWindows].map((window) => window.webContents));
  createWindow();
});

app.on('window-all-closed', () => app.quit());
