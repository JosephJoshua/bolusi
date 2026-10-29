// The camera and microphone this PC's photos and videos use, chosen in Settings or the setup guide
// and kept with the printer in this PC's settings file.
import { ipcMain, type IpcMainInvokeEvent } from 'electron';

import { isMediaInputChoice, type DeviceSettingsFile } from './device-settings.js';

export function registerMediaChoice(
  settings: DeviceSettingsFile,
  trusted: (event: IpcMainInvokeEvent) => boolean,
): void {
  ipcMain.handle('media:choices', async (event) => {
    if (!trusted(event)) throw new Error('media:choices: refused');
    const { camera, microphone } = await settings.read();
    return { camera, microphone };
  });
  ipcMain.handle('media:choose', async (event, kind: unknown, choice: unknown) => {
    if (!trusted(event)) throw new Error('media:choose: refused');
    if (kind !== 'camera' && kind !== 'microphone') throw new Error('media:choose: bad kind');
    if (choice !== null && !isMediaInputChoice(choice)) throw new Error('media:choose: bad choice');
    await settings.update({
      [kind]: choice === null ? null : { deviceId: choice.deviceId, label: choice.label },
    });
  });
}
