// The Electron main process: one locked-down window for the counter screens (drawing its own title
// bar, `window-chrome.ts`), and the offline core in its own utility process. The renderer gets no Node and no way to open other pages; the preload
// gives it a few narrow calls (`bridge.ts`): printing, updates and a port to the core. Only `wa.me`
// links open outside the app.
import {
  app,
  BrowserWindow,
  session,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { quitAfter, registerCore } from './core-process.js';
import { DeviceSettingsFile } from './device-settings.js';
import { opensExternally } from './external-links.js';
import { registerPrinting } from './printing.js';
import { registerUpdates } from './updater.js';
import { frameOptions, registerWindowChrome, reportFullscreen } from './window-chrome.js';

// The dev server is for development only; an installed app never loads a page from elsewhere.
const DEV_SERVER_URL = app.isPackaged ? undefined : process.env['BOLUSI_DESKTOP_DEV_URL'];
const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set(['clipboard-sanitized-write']);
const RENDERER_INDEX = fileURLToPath(new URL('../renderer/index.html', import.meta.url));
const PRELOAD = fileURLToPath(new URL('./preload.cjs', import.meta.url));
const BUILD_CONFIG = fileURLToPath(new URL('./build-config.json', import.meta.url));
// The seeded demo instead of the core, for previews and the screen tests (also against the installed
// app in the Windows CI job). It holds only made-up data in memory and opens nothing on disk.
const DEMO = process.env['BOLUSI_DESKTOP_DEMO'] === '1';
const API_BASE_URL = apiBaseUrl();

// A developer build or a test may keep its data elsewhere, so it never touches a real counter's.
const DATA_DIR_OVERRIDE = app.isPackaged ? undefined : process.env['BOLUSI_DESKTOP_DATA_DIR'];
if (DATA_DIR_OVERRIDE !== undefined) app.setPath('userData', join(DATA_DIR_OVERRIDE));

/**
 * Where this build syncs: `BOLUSI_API_URL` when the build ran (written beside main by the core's
 * build, so an installed app carries it), or from the shell when developing.
 */
function apiBaseUrl(): string {
  const fromShell = app.isPackaged ? undefined : process.env['BOLUSI_API_URL'];
  let built: string | undefined;
  try {
    const config = JSON.parse(readFileSync(BUILD_CONFIG, 'utf8')) as { apiBaseUrl?: unknown };
    if (typeof config.apiBaseUrl === 'string') built = config.apiBaseUrl;
  } catch {
    built = undefined;
  }
  return (fromShell ?? built ?? '').replace(/\/+$/, '');
}

/** The counter windows this process opened; only their own page may call in. */
const counterWindows = new Set<BrowserWindow>();

function trusted(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
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
    ...frameOptions(process.platform),
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
  reportFullscreen(window);

  // The app is one page: nothing navigates it or opens another window. A link to a listed host
  // opens outside it, in the browser or the app that handles it (WhatsApp Desktop for wa.me).
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (opensExternally(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
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
      ALLOWED_PERMISSIONS.has(permission) ||
        (counter(contents) && details.isMainFrame && camera(permission, kinds)),
    );
  });
  session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) => {
    const kind = details.mediaType;
    return (
      ALLOWED_PERMISSIONS.has(permission) ||
      (counter(contents) &&
        details.isMainFrame &&
        camera(permission, kind === undefined ? undefined : [kind]))
    );
  });
  registerPrinting(new DeviceSettingsFile(app.getPath('userData')), trusted);
  const pages = (): Electron.WebContents[] =>
    [...counterWindows].map((window) => window.webContents);
  registerUpdates(trusted, pages);
  registerWindowChrome(trusted);
  if (!DEMO && API_BASE_URL === '')
    console.error('BOLUSI_API_URL is not set: nothing to sync with');
  quitAfter(
    registerCore({
      dataDir: app.getPath('userData'),
      apiBaseUrl: API_BASE_URL,
      appVersion: app.getVersion(),
      demo: DEMO,
      unsealedSecretsForDev: !app.isPackaged && process.platform === 'linux',
      trusted,
      windows: pages,
    }),
  );
  createWindow();
});

app.on('window-all-closed', () => app.quit());
