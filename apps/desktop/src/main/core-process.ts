// The offline core's process: main starts it, answers its calls for the sealed secrets (only main
// can reach safeStorage), tells it when the PC goes online or wakes, and hands each counter page a
// port to it. On quit it is asked to close the database first, so an update never cuts a write.
import { fileURLToPath } from 'node:url';

import {
  app,
  ipcMain,
  MessageChannelMain,
  net,
  powerMonitor,
  utilityProcess,
  type IpcMainEvent,
  type UtilityProcess,
  type WebContents,
} from 'electron';

import type { CorePortMode } from './bridge.js';
import { mainPortChannel } from './main-port.js';
import { MAIN_CALLS, MAIN_EVENTS, type CoreInit } from './process-api.js';
import { serve } from './rpc.js';
import { createSecretStore } from './secret-store.js';

const CORE_ENTRY = fileURLToPath(new URL('./core.js', import.meta.url));
const ONLINE_POLL_MS = 5_000;
/** A core that keeps dying is not restarted forever; the page then says the app must restart. */
const MAX_RESTARTS = 3;
/** A core that ran this long before it died was not dying in a loop: it gets the full budget again. */
const STABLE_RUN_MS = 10 * 60_000;
/** How long a closing core may take to finish its last write before it is stopped anyway. */
const SHUTDOWN_GRACE_MS = 5_000;

export interface CoreProcessConfig {
  readonly dataDir: string;
  readonly apiBaseUrl: string;
  readonly appVersion: string;
  /** Seeded screens and no core, for previews and screen tests. */
  readonly demo: boolean;
  /** A development run on Linux without a keyring; see `createSecretStore`. */
  readonly unsealedSecretsForDev: boolean;
  readonly trusted: (event: IpcMainEvent) => boolean;
  readonly windows: () => readonly WebContents[];
}

export interface CoreProcess {
  /** Ask the core to close its database and exit; resolves once it has (or the grace ran out). */
  stop(): Promise<void>;
}

export function registerCore(config: CoreProcessConfig): CoreProcess {
  const secrets = createSecretStore(config.dataDir, config.unsealedSecretsForDev);
  let child: UtilityProcess | null = null;
  let emitToCore: ((name: string, payload: unknown) => void) | null = null;
  let restarts = 0;
  let stopping = false;
  let online = net.isOnline();

  const start = (): void => {
    const forked = utilityProcess.fork(CORE_ENTRY, [], { serviceName: 'Bolusi core' });
    const startedAt = Date.now();
    const { port1, port2 } = new MessageChannelMain();
    const server = serve(mainPortChannel(port1), {
      [MAIN_CALLS.secretGet]: (name: string) => secrets.get(name),
      [MAIN_CALLS.secretSet]: (name: string, value: string) => secrets.set(name, value),
      [MAIN_CALLS.secretDelete]: (name: string) => secrets.delete(name),
    });
    emitToCore = server.emit;
    const init: CoreInit = {
      kind: 'init',
      dataDir: config.dataDir,
      apiBaseUrl: config.apiBaseUrl,
      appVersion: config.appVersion,
      online,
    };
    forked.postMessage(init, [port2]);
    forked.on('exit', (code) => {
      server.close();
      if (child === forked) {
        child = null;
        emitToCore = null;
      }
      if (stopping) return;
      console.error(`core process exited with code ${String(code)}`);
      if (Date.now() - startedAt >= STABLE_RUN_MS) restarts = 0;
      if (restarts >= MAX_RESTARTS) return;
      restarts += 1;
      start();
      // Each page reconnects to the new core as it reloads.
      for (const contents of config.windows()) contents.reload();
    });
    child = forked;
  };

  const connectPage = (contents: WebContents): void => {
    const reply = (mode: CorePortMode, ports: Electron.MessagePortMain[] = []): void =>
      contents.postMessage('core:port', mode, ports);
    if (config.demo) return reply('demo');
    if (child === null) return reply('unavailable');
    const { port1, port2 } = new MessageChannelMain();
    child.postMessage({ kind: 'window' }, [port1]);
    reply('live', [port2]);
  };

  ipcMain.on('core:connect', (event) => {
    if (config.trusted(event)) connectPage(event.sender);
  });

  if (!config.demo) {
    const check = (): void => {
      const now = net.isOnline();
      if (now === online) return;
      online = now;
      emitToCore?.(MAIN_EVENTS.online, online);
    };
    setInterval(check, ONLINE_POLL_MS).unref();
    powerMonitor.on('resume', () => {
      check();
      emitToCore?.(MAIN_EVENTS.resumed, null);
    });
    start();
  }

  return {
    stop() {
      stopping = true;
      const running = child;
      if (running === null) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          running.kill();
          resolve();
        }, SHUTDOWN_GRACE_MS);
        running.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
        emitToCore?.(MAIN_EVENTS.shutdown, null);
      });
    },
  };
}

/** Quit only after the core has closed its database. */
export function quitAfter(core: CoreProcess): void {
  let closed = false;
  app.on('before-quit', (event) => {
    if (closed) return;
    event.preventDefault();
    void core.stop().then(() => {
      closed = true;
      app.quit();
    });
  });
}
