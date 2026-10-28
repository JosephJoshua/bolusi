// The counter page's only door into the main process. A sandboxed preload runs as CommonJS, hence
// `.cts`. Each call is a fixed IPC channel with plain data; the page never sees `ipcRenderer`.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- a sandboxed preload is CommonJS
import electron = require('electron');

import type { DesktopBridge, HandoffEvent, UpdateState } from './bridge.js';

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
  handoff: {
    open: (kind, labels) => electron.ipcRenderer.invoke('handoff:open', kind, labels),
    cancel: (id) => electron.ipcRenderer.invoke('handoff:cancel', id),
    onEvent: (listener) => {
      const relay = (_event: unknown, event: HandoffEvent): void => listener(event);
      electron.ipcRenderer.on('handoff:event', relay);
      return () => electron.ipcRenderer.removeListener('handoff:event', relay);
    },
  },
};

electron.contextBridge.exposeInMainWorld('bolusi', bridge);
