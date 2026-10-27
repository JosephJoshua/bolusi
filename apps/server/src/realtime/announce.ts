// Tell devices that something they pull changed (api/00 §12.1 `sync.poke`; api/04-push §6 `sync` wake).
// ONE path for every writer: the sync push announces its accepted ops' scopes, and a directory write
// (a user added, re-roled, deactivated, a PIN set, a tenant setting) announces the tenant, so a
// colleague added on one phone reaches the others' switchers within seconds instead of the next poll.
//
// Live devices get the poke; devices with no live connection get a data-only `sync` wake, dispatched
// FIRE-AND-FORGET so an Expo outage never slows the request that made the change (§1/§6). Neither is
// load-bearing: a missed one costs only latency until the device's own poll (api/01-sync §8).
import type { DeliveryDispatcher } from '../push/dispatcher.js';
import { sendSyncWake, type PushDeliveryDeps } from '../push/fanout.js';

import type { PokeHub, PokeScope } from './poke-hub.js';

export interface AnnounceDeps {
  readonly pokeHub: PokeHub;
  /** Absent (with `deliveryDispatcher`) ⇒ poke only, no wake — the pipeline-only test deps. */
  readonly pushDelivery?: PushDeliveryDeps | undefined;
  readonly deliveryDispatcher?: DeliveryDispatcher | undefined;
}

/** Call AFTER the change committed: a device woken earlier could pull the old state. */
export function announceChange(deps: AnnounceDeps, scopes: readonly PokeScope[]): void {
  deps.pokeHub.publish(scopes);
  if (deps.pushDelivery === undefined || deps.deliveryDispatcher === undefined) return;
  const pushDelivery = deps.pushDelivery;
  const dispatcher = deps.deliveryDispatcher;
  const seen = new Set<string>();
  for (const scope of scopes) {
    const key = `${scope.tenantId}|${scope.storeId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dispatcher.dispatch(() =>
      sendSyncWake(pushDelivery, { tenantId: scope.tenantId, opStoreId: scope.storeId }),
    );
  }
}

/** The directory every device of the tenant mirrors (users, roles, PINs, settings) changed. */
export function announceDirectoryChange(deps: AnnounceDeps, tenantId: string): void {
  announceChange(deps, [{ tenantId, storeId: null }]);
}
