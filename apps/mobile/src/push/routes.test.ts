// Deep-link route map (api/04-push §4). Pure resolver over an untrusted payload — no native module.
import { describe, expect, test } from 'vitest';

import { resolvePushRoute } from './routes.js';

const CONFLICT_ID = '018f4e2a-1111-7abc-8def-000000000001';
const DEVICE_ID = '018f4e2a-2222-7abc-8def-000000000002';

describe('resolvePushRoute (api/04-push §4)', () => {
  test('conflict route resolves to the conflicts screen with conflictId', () => {
    expect(
      resolvePushRoute({
        category: 'conflict',
        route: 'conflicts',
        params: { conflictId: CONFLICT_ID },
      }),
    ).toEqual({ screen: 'conflicts', params: { conflictId: CONFLICT_ID } });
  });

  test('device route resolves to the devices screen with deviceId', () => {
    expect(
      resolvePushRoute({ category: 'device', route: 'devices', params: { deviceId: DEVICE_ID } }),
    ).toEqual({ screen: 'devices', params: { deviceId: DEVICE_ID } });
  });

  test('a sync data-only payload (no route) resolves to null', () => {
    expect(resolvePushRoute({ category: 'sync' })).toBeNull();
  });

  test('an unknown route key is safely ignored (null), never navigated', () => {
    expect(resolvePushRoute({ route: 'payments', params: { id: 'x' } })).toBeNull();
  });

  test('a known route missing its required id resolves to null', () => {
    expect(resolvePushRoute({ route: 'conflicts', params: {} })).toBeNull();
    expect(resolvePushRoute({ route: 'devices' })).toBeNull();
  });

  test('a malformed / non-object payload resolves to null', () => {
    expect(resolvePushRoute(null)).toBeNull();
    expect(resolvePushRoute('conflicts')).toBeNull();
    expect(resolvePushRoute(undefined)).toBeNull();
  });
});
