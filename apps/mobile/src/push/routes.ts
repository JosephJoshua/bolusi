// Deep-link route map for push notifications (api/04-push §4). A tapped notification carries
// `data: { category, route, params }`; this resolves the `route` + entity ids to a navigation
// target. The screen then loads its data from local projections — the push carried NO business data
// (api/04-push §1/§4), only the id.
//
// v0 route registry (api/04-push §4): `conflicts` → conflict detail (`conflictId`); `devices` →
// device detail (`deviceId`). Any other `route` — including a `sync` data-only wake, which has no
// route at all — resolves to `null` and is safely ignored (never navigate on an unknown key).

/** A resolved navigation target from a push payload. */
export type PushNavigation =
  | { readonly screen: 'conflicts'; readonly params: { readonly conflictId: string } }
  | { readonly screen: 'devices'; readonly params: { readonly deviceId: string } };

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * Resolve a push `data` payload to a navigation target, or `null` when the route key is unknown /
 * the required id is absent. Total and defensive: a killed-app payload is untrusted input.
 */
export function resolvePushRoute(data: unknown): PushNavigation | null {
  const d = asRecord(data);
  const params = asRecord(d['params']);

  if (d['route'] === 'conflicts' && typeof params['conflictId'] === 'string') {
    return { screen: 'conflicts', params: { conflictId: params['conflictId'] } };
  }
  if (d['route'] === 'devices' && typeof params['deviceId'] === 'string') {
    return { screen: 'devices', params: { deviceId: params['deviceId'] } };
  }
  return null;
}
