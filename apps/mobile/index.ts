import { registerRootComponent } from 'expo';
import { Platform } from 'react-native';

import { Root } from './src/bootstrap/Root.js';
import { fileLocaleStore } from './src/ports/locale-store.js';

/**
 * The registered root.
 *
 * `Root` (src/bootstrap/Root.tsx) is the composition root; its header states exactly what is real,
 * what is a seam, and what is not built yet — read it before wiring task 15. `App` is deliberately
 * NOT registered directly any more: it takes every input as a prop so it stays drivable from fakes,
 * which means something has to supply them, and that something is `Root`.
 *
 * DEVICE INFO IS EMPTY UNTIL ENROLLMENT, and that is honest rather than lazy. Every field except
 * `platform` is a fact the SERVER establishes: `api/02-auth` §4.3's enroll response carries the
 * deviceId, tenant and store, and §4.1 step 5 persists them. Reading a device name out of
 * `expo-constants` would put a plausible-looking value on the Settings screen that has nothing to do
 * with the device row an owner is about to revoke — and `expo-constants` is not pinned in 08 §2.2, so
 * adding it is a spec-table change requiring a stop-and-ask (CLAUDE.md §4/§6) for no gain. The
 * bootstrap (task 24 item 2) hands the persisted values in.
 */
function Bootstrapped(): React.JSX.Element | null {
  return Root({
    localeStore: fileLocaleStore,
    deviceInfo: {
      deviceId: '',
      deviceName: '',
      storeName: '',
      tenantName: '',
      platform: Platform.OS === 'ios' ? 'ios' : 'android',
      appVersion: '',
    },
  });
}

registerRootComponent(Bootstrapped);
