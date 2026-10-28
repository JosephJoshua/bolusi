// The window's frame: no Windows title bar, the page draws its own (the renderer's `TitleBar`), and
// Windows keeps drawing the minimise, maximise and close buttons over it. Those stay native on
// purpose: hovering maximise offers the snap layouts, they follow the system's DPI, a screen reader
// names them, and Alt+Space still opens the window menu. Main tells the page only one thing: when
// the window is fullscreen (F11), since those buttons are gone then.
import {
  BrowserWindow,
  ipcMain,
  type BrowserWindowConstructorOptions,
  type IpcMainInvokeEvent,
} from 'electron';

/** The bar's height and colours. The page's copy is `chromeColor` in ui-web's theme (tested equal). */
export const TITLE_BAR = Object.freeze({
  height: 40,
  color: '#0F172A',
  symbolColor: '#F8FAFC',
});

/** Windows' own caption buttons laid over the page's bar. */
export function frameOptions(
  platform: NodeJS.Platform,
): Pick<BrowserWindowConstructorOptions, 'titleBarStyle' | 'titleBarOverlay'> {
  // A developer's Mac keeps its traffic lights; the page leaves them room from the same CSS values.
  if (platform === 'darwin') return { titleBarStyle: 'hidden', titleBarOverlay: true };
  return { titleBarStyle: 'hidden', titleBarOverlay: { ...TITLE_BAR } };
}

export function registerWindowChrome(trusted: (event: IpcMainInvokeEvent) => boolean): void {
  ipcMain.handle('window:fullscreen', (event) => {
    if (!trusted(event)) throw new Error('window:fullscreen: refused');
    return BrowserWindow.fromWebContents(event.sender)?.isFullScreen() === true;
  });
}

/** Tells the window's page each time it enters or leaves fullscreen. */
export function reportFullscreen(window: BrowserWindow): void {
  const send = (fullscreen: boolean) => (): void => {
    if (!window.webContents.isDestroyed())
      window.webContents.send('window:fullscreen-changed', fullscreen);
  };
  window.on('enter-full-screen', send(true));
  window.on('leave-full-screen', send(false));
}
