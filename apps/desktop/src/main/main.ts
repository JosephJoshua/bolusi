// The Electron main process: one locked-down window for the counter screens. The renderer gets no
// Node, no preload API yet and no way to open other pages; the offline core moves into a utility
// process behind a narrow IPC port in the next step.
import { app, BrowserWindow, session } from 'electron';
import { fileURLToPath } from 'node:url';

// The dev server is for development only; an installed app never loads a page from elsewhere.
const DEV_SERVER_URL = app.isPackaged ? undefined : process.env['BOLUSI_DESKTOP_DEV_URL'];
const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set(['clipboard-sanitized-write']);
const RENDERER_INDEX = fileURLToPath(new URL('../renderer/index.html', import.meta.url));

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
    },
  });
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
  // Only copying (a phone number) is allowed. No camera, microphone or other device until the
  // capture step asks for one deliberately.
  const allowed = (permission: string): boolean => ALLOWED_PERMISSIONS.has(permission);
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) =>
    callback(allowed(permission)),
  );
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => allowed(permission));
  createWindow();
});

app.on('window-all-closed', () => app.quit());
