// The counter page's only door into the main process. A sandboxed preload runs as CommonJS, hence
// `.cts`. Each call is a fixed IPC channel with plain data; the page never sees `ipcRenderer`.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- a sandboxed preload is CommonJS
import electron = require('electron');

import type { CorePortMode, DesktopBridge, UpdateState } from './bridge.js';

// Duplicated from bridge.ts: a sandboxed preload can require only `electron`, not its own modules.
const CORE_PORT_MESSAGE = 'bolusi:core-port';

// A port cannot cross the context bridge as a value; posting it to the page's own window is the
// documented way. The page accepts it only from its own window (see the renderer's core client).
const page = globalThis as unknown as {
  postMessage(message: unknown, targetOrigin: string, transfer: readonly unknown[]): void;
};
electron.ipcRenderer.on('core:port', (event, mode: CorePortMode) => {
  page.postMessage({ type: CORE_PORT_MESSAGE, mode }, '*', event.ports);
});

const bridge: DesktopBridge = {
  printers: {
    list: () => electron.ipcRenderer.invoke('printers:list'),
    settings: () => electron.ipcRenderer.invoke('printers:settings'),
    choose: (printer) => electron.ipcRenderer.invoke('printers:choose', printer),
    setPaper: (paper) => electron.ipcRenderer.invoke('printers:set-paper', paper),
    printRaw: (bytes, jobName) => electron.ipcRenderer.invoke('printers:raw', bytes, jobName),
    printPage: (html, paper) => electron.ipcRenderer.invoke('printers:page', html, paper),
  },
  updates: {
    version: () => electron.ipcRenderer.invoke('updates:version'),
    state: () => electron.ipcRenderer.invoke('updates:state'),
    onChange: (listener) => {
      const relay = (_event: unknown, state: UpdateState): void => listener(state);
      electron.ipcRenderer.on('updates:changed', relay);
      return () => electron.ipcRenderer.removeListener('updates:changed', relay);
    },
    install: () => electron.ipcRenderer.invoke('updates:install'),
  },
  window: {
    fullscreen: () => electron.ipcRenderer.invoke('window:fullscreen'),
    onFullscreenChange: (listener) => {
      const relay = (_event: unknown, fullscreen: boolean): void => listener(fullscreen);
      electron.ipcRenderer.on('window:fullscreen-changed', relay);
      return () => electron.ipcRenderer.removeListener('window:fullscreen-changed', relay);
    },
  },
  core: {
    connect: () => electron.ipcRenderer.send('core:connect'),
  },
};

electron.contextBridge.exposeInMainWorld('bolusi', bridge);
