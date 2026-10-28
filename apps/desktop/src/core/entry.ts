// The utility process the main process starts: it receives its settings and a port to main, boots
// the core host, and then serves every window port main hands it. Secrets come from main (only main
// can reach safeStorage); everything else runs here, off the window's thread.
import type { MessagePortMain } from 'electron';

import type { AppStatePort, NetInfoPort } from '@bolusi/device/bootstrap/triggers';
import { consoleDiagnostics } from '@bolusi/device/ports/diagnostics';
import type { SecretsPort } from '@bolusi/device/ports/secret-keystores';

import { CORE_EVENTS } from './api.js';
import { MAIN_CALLS, MAIN_EVENTS, type CoreInit } from '../main/process-api.js';
import { mainPortChannel } from '../main/main-port.js';
import { connect, serve } from '../main/rpc.js';

import { createCoreHost, type CoreHost } from './host.js';

interface ParentMessage {
  readonly data: unknown;
  readonly ports: MessagePortMain[];
}

const parent = process.parentPort;
let host: CoreHost | null = null;
/** Windows that connected before the host existed wait for it. */
const waiting: MessagePortMain[] = [];

function serveWindow(core: CoreHost, port: MessagePortMain): void {
  const channel = mainPortChannel(port);
  const server = serve(channel, core.handlers);
  // A window that connects late (a reload) gets the state as it is now, then every change.
  server.emit(CORE_EVENTS.state, core.state());
  const stopState = core.onState((state) => server.emit(CORE_EVENTS.state, state));
  const stopRepair = core.onRepairChanged(() => server.emit(CORE_EVENTS.repairChanged, null));
  const stopHandoff = core.onHandoff((event) => server.emit(CORE_EVENTS.handoff, event));
  port.on('close', () => {
    stopState();
    stopRepair();
    stopHandoff();
    server.close();
  });
}

function start(init: CoreInit, mainPort: MessagePortMain): void {
  const main = connect(mainPortChannel(mainPort));
  const secrets: SecretsPort = {
    get: (name) => main.call<string | null>(MAIN_CALLS.secretGet, name),
    set: (name, value) => main.call<void>(MAIN_CALLS.secretSet, name, value),
    delete: (name) => main.call<void>(MAIN_CALLS.secretDelete, name),
  };

  // Connectivity as main's `net.isOnline()` sees it; a listener hears the current value at once
  // (the NetInfo contract the sync triggers rely on for the boot sync).
  let online = init.online;
  const netListeners = new Set<(connected: boolean) => void>();
  main.on(MAIN_EVENTS.online, (value) => {
    online = value === true;
    for (const listener of netListeners) listener(online);
  });
  const netInfo: NetInfoPort = {
    subscribe(listener) {
      netListeners.add(listener);
      listener(online);
      return () => netListeners.delete(listener);
    },
  };
  // A desktop app is never suspended the way a phone app is: it syncs and its idle lock runs while
  // it is minimised, so it always reports itself active.
  const appState: AppStatePort = { current: () => 'active', subscribe: () => () => undefined };

  const core = createCoreHost({
    dataDir: init.dataDir,
    apiBaseUrl: init.apiBaseUrl,
    appVersion: init.appVersion,
    secrets,
    netInfo,
    appState,
  });
  host = core;
  for (const port of waiting.splice(0)) serveWindow(core, port);
  main.on(MAIN_EVENTS.resumed, () => core.requestSync());
  main.on(MAIN_EVENTS.shutdown, () => {
    void core
      .stop()
      .catch((error: unknown) => {
        consoleDiagnostics.warn('core did not stop cleanly', {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => process.exit(0));
  });
  core.start().catch((error: unknown) => {
    consoleDiagnostics.warn('core failed to start', {
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

parent.on('message', (event: ParentMessage) => {
  const message = event.data as { kind?: string } | null;
  const [port] = event.ports;
  if (port === undefined) return;
  if (message?.kind === 'init' && host === null) start(message as CoreInit, port);
  else if (message?.kind === 'window') {
    if (host === null) waiting.push(port);
    else serveWindow(host, port);
  }
});
