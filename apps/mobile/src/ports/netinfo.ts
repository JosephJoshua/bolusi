// The production `NetInfoPort` — trigger (a), api/01-sync §5 — over `@react-native-community/netinfo`.
//
// NATIVE MODULE, INJECTED LIKE op-sqlite. `@react-native-community/netinfo` cannot load under Node, so
// this file is imported ONLY by `index.ts` (the one file no Node test loads) and handed downward. The
// trigger set and the sync client name only the `NetInfoPort` INTERFACE (bootstrap/triggers.ts); their
// tests drive it with a fake, so a real socket never reaches a test (T-6/T-7).
//
// `addEventListener` fires the listener ONCE immediately with the current state, then on every change,
// and returns the unsubscribe (12.0.1 docs) — exactly the `NetInfoPort` contract triggers.ts relies on
// for the boot sync. `isConnected` is `boolean | null`; `null` (state unknown) is treated as OFFLINE,
// the honest default (never a cheerful "online" a device has not confirmed — design-system §4).
import NetInfo from '@react-native-community/netinfo';

import type { NetInfoPort } from '../bootstrap/triggers.js';

export const netInfoPort: NetInfoPort = {
  subscribe(listener: (connected: boolean) => void): () => void {
    return NetInfo.addEventListener((state) => {
      listener(state.isConnected ?? false);
    });
  },
};
