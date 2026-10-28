// One device for the repair journey test (repair-journey.test.ts), in its own worker thread: the
// client database allows one connection per process, as on a phone, so each device gets its own
// module graph. The worker runs the real offline core and a network the test can switch off or
// make drop requests, and answers over the app's own window-to-core protocol.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';

import type { AppStatePort, NetInfoPort } from '@bolusi/device/bootstrap/triggers';
import type { SecretsPort } from '@bolusi/device/ports/secret-keystores';

import { createCoreHost } from '../src/core/host.js';
import { serve, type Channel } from '../src/main/rpc.js';

/** How a request is cut off: before it reaches the server, or after the server answered it. */
export type Drop = 'beforeServer' | 'afterServer';

export interface JourneyDeviceData {
  readonly dataDir: string;
  readonly apiBaseUrl: string;
  /** Start with the network off (a device switched on again where there is no signal). */
  readonly offline?: boolean;
}

const data = workerData as JourneyDeviceData;
let online = data.offline !== true;
const netListeners = new Set<(connected: boolean) => void>();
const drops: { match: RegExp; how: Drop }[] = [];
/** Requests cut off so far, so the test can show each fault really fired. */
const dropped: string[] = [];

const netInfo: NetInfoPort = {
  subscribe(listener) {
    netListeners.add(listener);
    listener(online);
    return () => netListeners.delete(listener);
  },
};

const networkFetch: typeof fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (!online) throw new TypeError('fetch failed (offline)');
  const path = new URL(url).pathname;
  const index = drops.findIndex((drop) => drop.match.test(path));
  if (index === -1) return fetch(input, init);
  const [drop] = drops.splice(index, 1);
  dropped.push(`${drop!.how} ${path}`);
  if (drop!.how === 'afterServer') await (await fetch(input, init)).arrayBuffer();
  throw new TypeError('fetch failed (connection reset)');
};

// The sealed secrets live next to the database, so a device started again over the same folder
// (after a power cut) opens its data as the PC's DPAPI store would let it.
const secretsFile = join(data.dataDir, 'test-secrets.json');
const values = new Map<string, string>(
  existsSync(secretsFile)
    ? Object.entries(JSON.parse(readFileSync(secretsFile, 'utf8')) as Record<string, string>)
    : [],
);
function saveSecrets(): Promise<void> {
  writeFileSync(secretsFile, JSON.stringify(Object.fromEntries(values)));
  return Promise.resolve();
}
const secrets: SecretsPort = {
  get: (name) => Promise.resolve(values.get(name) ?? null),
  set: (name, value) => {
    values.set(name, value);
    return saveSecrets();
  },
  delete: (name) => {
    values.delete(name);
    return saveSecrets();
  },
};

const appState: AppStatePort = { current: () => 'active', subscribe: () => () => undefined };

const core = createCoreHost({
  dataDir: data.dataDir,
  apiBaseUrl: data.apiBaseUrl,
  appVersion: '0.0.0-test',
  secrets,
  netInfo,
  appState,
  fetchImpl: networkFetch,
});

const port = parentPort!;
const channel: Channel = {
  send: (message) => port.postMessage(message),
  listen(onMessage) {
    port.on('message', onMessage);
    return () => port.off('message', onMessage);
  },
};

serve(channel, {
  ...core.handlers,
  'test.start': () => core.start(),
  'test.stop': () => core.stop(),
  'test.state': () => core.state(),
  'test.requestSync': () => core.requestSync(),
  'test.setOnline'(next: boolean) {
    online = next;
    for (const listener of netListeners) listener(next);
  },
  'test.dropNext'(match: RegExp, how: Drop) {
    drops.push({ match, how });
  },
  'test.dropped': () => [...dropped],
});
