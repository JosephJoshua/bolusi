// The phone's over-the-air update check (expo-updates protocol 1), outside /v1: the app asks before
// it has a device token, and an update holds nothing secret (the repository is public). What makes
// it safe is the signature, checked on the phone (app-updates/releases.ts).
//
//   GET /updates/manifest   headers expo-platform, expo-runtime-version (expo-current-update-id)
//     200  the signed manifest (JSON, `expo-signature` header)
//     204  nothing newer for this native build
//     503  the update store could not be reached; the phone keeps what it runs and asks next time
import { Hono } from 'hono';

import { OTA_PLATFORMS, type OtaPlatform, type UpdateSource } from '../app-updates/releases.js';
import type { AppEnv } from '../env.js';

const PROTOCOL_HEADERS = { 'expo-protocol-version': '1', 'expo-sfv-version': '0' } as const;
const RUNTIME_VERSION = /^[\w.+-]{1,128}$/;

function isPlatform(value: string | undefined): value is OtaPlatform {
  return (OTA_PLATFORMS as readonly string[]).includes(value ?? '');
}

export function createAppUpdatesRouter(source: UpdateSource | undefined) {
  return new Hono<AppEnv>().get('/manifest', async (c) => {
    const platform = c.req.header('expo-platform');
    const runtimeVersion = c.req.header('expo-runtime-version') ?? '';
    if (!isPlatform(platform) || !RUNTIME_VERSION.test(runtimeVersion)) {
      return c.body(null, 400, PROTOCOL_HEADERS);
    }
    // A server without an update store has nothing newer to offer.
    if (source === undefined) return c.body(null, 204, PROTOCOL_HEADERS);

    let update;
    try {
      update = await source.latest(platform, runtimeVersion);
    } catch (error) {
      console.warn('app updates:', error instanceof Error ? error.message : error);
      return c.body(null, 503, { ...PROTOCOL_HEADERS, 'retry-after': '300' });
    }
    if (update === null || update.id === c.req.header('expo-current-update-id')) {
      return c.body(null, 204, PROTOCOL_HEADERS);
    }
    return c.body(update.manifest, 200, {
      ...PROTOCOL_HEADERS,
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'private, max-age=0',
      'expo-signature': update.signature,
    });
  });
}
