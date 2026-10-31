// @vitest-environment node
// The main process's windows and menu, over a stand-in Electron. An installed app gives no one at
// the counter a way into the developer tools (a console on the page could drive `window.bolusi` and
// the core directly, also behind the PIN screen): no Toggle Developer Tools or reload in the menu
// and devtools off in every window, while F11, zoom and the editing keys keep working.
import { afterEach, describe, expect, it, vi } from 'vitest';

interface FakeWindow {
  readonly options: Electron.BrowserWindowConstructorOptions;
  readonly webContents: { readonly mainFrame: object };
}

const electron = vi.hoisted(() => ({
  isPackaged: true,
  windows: [] as FakeWindow[],
  menus: [] as unknown[],
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock('electron', () => {
  class BrowserWindow {
    static getAllWindows = (): unknown[] => [];
    readonly webContents = {
      mainFrame: {},
      setWindowOpenHandler: (): void => undefined,
      on: (): void => undefined,
      isDestroyed: (): boolean => false,
      send: (): void => undefined,
      getPrintersAsync: () => Promise.resolve([{ name: 'Slip', displayName: 'Slip' }]),
      print: (_options: unknown, done: (success: boolean) => void): void => done(true),
    };
    constructor(readonly options: Electron.BrowserWindowConstructorOptions) {
      electron.windows.push(this);
    }
    on(): void {}
    once(): void {}
    destroy(): void {}
    loadFile(): Promise<void> {
      return Promise.resolve();
    }
    loadURL(): Promise<void> {
      return Promise.resolve();
    }
  }
  const app = {
    get isPackaged(): boolean {
      return electron.isPackaged;
    },
    commandLine: { appendSwitch: (): void => undefined },
    requestSingleInstanceLock: (): boolean => true,
    on: (): void => undefined,
    whenReady: (): Promise<void> => Promise.resolve(),
    getPath: (): string => '/nonexistent/bolusi-test',
    setPath: (): void => undefined,
    getVersion: (): string => '0.0.0',
    quit: (): void => undefined,
  };
  const session = {
    defaultSession: {
      setPermissionRequestHandler: (): void => undefined,
      setPermissionCheckHandler: (): void => undefined,
    },
  };
  const Menu = {
    buildFromTemplate: (template: unknown) => ({ template }),
    setApplicationMenu: (menu: unknown) => electron.menus.push(menu),
  };
  const ipcMain = {
    handle: (channel: string, run: (event: unknown, ...args: unknown[]) => Promise<unknown>) =>
      electron.handlers.set(channel, run),
  };
  const screen = { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1040 } }) };
  return { app, BrowserWindow, Menu, ipcMain, screen, session, shell: {} };
});
vi.mock('../src/main/core-process.js', () => ({
  quitAfter: (): void => undefined,
  registerCore: () => ({}),
}));
vi.mock('../src/main/updater.js', () => ({ registerUpdates: (): void => undefined }));
vi.mock('../src/main/device-settings.js', () => ({
  isPrinterName: (): boolean => true,
  DeviceSettingsFile: class {
    read(): Promise<{ printer: string; paper: null }> {
      return Promise.resolve({ printer: 'Slip', paper: null });
    }
  },
}));
vi.mock('../src/main/window-chrome.js', () => ({
  frameOptions: () => ({}),
  registerWindowChrome: (): void => undefined,
  reportFullscreen: (): void => undefined,
  windowSize: () => ({}),
}));

/** Starts main as an installed or a developer's app; resolves with its counter window. */
async function start(isPackaged: boolean): Promise<FakeWindow> {
  electron.isPackaged = isPackaged;
  vi.resetModules();
  await import('../src/main/main.js');
  await vi.waitFor(() => expect(electron.windows).toHaveLength(1));
  return electron.windows[0]!;
}

function roles(menu: unknown): string[] {
  const found: string[] = [];
  const walk = (items: Electron.MenuItemConstructorOptions[]): void => {
    for (const item of items) {
      if (item.role !== undefined) found.push(item.role);
      if (Array.isArray(item.submenu)) walk(item.submenu);
    }
  };
  walk((menu as { template: Electron.MenuItemConstructorOptions[] }).template);
  return found;
}

afterEach(() => {
  electron.windows.length = 0;
  electron.menus.length = 0;
  electron.handlers.clear();
});

describe('the installed counter app', () => {
  it('replaces the default menu with one that has no developer tools or reload', async () => {
    await start(true);
    expect(electron.menus).toHaveLength(1);
    const kept = roles(electron.menus[0]);
    for (const role of ['toggleDevTools', 'reload', 'forceReload', 'viewMenu', 'windowMenu']) {
      expect(kept).not.toContain(role);
    }
    expect(kept).toEqual(
      expect.arrayContaining(['editMenu', 'togglefullscreen', 'zoomIn', 'zoomOut', 'resetZoom']),
    );
  });

  it('turns devtools off in the counter window, which stays locked down', async () => {
    const prefs = (await start(true)).options.webPreferences!;
    expect(prefs.devTools).toBe(false);
    expect(prefs.contextIsolation).toBe(true);
    expect(prefs.sandbox).toBe(true);
    expect(prefs.nodeIntegration).toBe(false);
  });

  it('turns devtools off in the hidden window that prints a page', async () => {
    const counter = await start(true);
    const sender = counter.webContents;
    const page = electron.handlers.get('printers:page')!;
    const result = await page({ sender, senderFrame: sender.mainFrame }, '<p>Nota</p>', {
      widthMm: 80,
      heightMm: 200,
    });
    expect(result).toEqual({ ok: true });
    expect(electron.windows).toHaveLength(2);
    const print = electron.windows[1]!.options;
    expect(print.show).toBe(false);
    expect(print.webPreferences!.devTools).toBe(false);
  });
});

describe("a developer's build", () => {
  it('keeps the default menu and devtools', async () => {
    const counter = await start(false);
    expect(electron.menus).toHaveLength(0);
    expect(counter.options.webPreferences!.devTools).toBe(true);
  });
});
