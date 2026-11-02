// Opening with Windows: a counter PC is switched on in the morning and the app should be waiting,
// not looked for. Windows' own login item is the only record, so Task Manager's Startup tab and
// this setting always agree. Only an installed app on Windows has one.
import { app, ipcMain, type IpcMainInvokeEvent } from 'electron';

function supported(): boolean {
  return process.platform === 'win32' && app.isPackaged;
}

export function registerStartup(trusted: (event: IpcMainInvokeEvent) => boolean): void {
  ipcMain.handle('startup:get', (event) => {
    if (!trusted(event)) throw new Error('startup:get: refused');
    return supported() ? app.getLoginItemSettings().openAtLogin : null;
  });
  ipcMain.handle('startup:set', (event, open: unknown) => {
    if (!trusted(event)) throw new Error('startup:set: refused');
    if (typeof open !== 'boolean') throw new Error('startup:set: not a yes or no');
    if (supported()) app.setLoginItemSettings({ openAtLogin: open });
  });
}
