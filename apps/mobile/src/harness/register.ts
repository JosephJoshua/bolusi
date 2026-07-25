// Flag-gated registration of the harness root (task 27a/175 deliverable #3). `apps/mobile/index.ts`
// imports this for its side effect so the `BolusiHarness` component EXISTS in the one JS bundle that
// BOTH MainActivity ("main") and HarnessActivity ("BolusiHarness") load — RN apps have a single JS
// entry, so the bundle must register both.
//
// Gated by `harnessEnabled()`: a production/preview bundle (flag unset) never registers it — the SAME
// runtime lock loadHarness() uses. HarnessActivity is ALSO only injected into `test`-profile builds by
// the config plugin (which reads the same env at prebuild), so the harness is double-locked: no flag →
// no component AND no activity. The import of HarnessApp is a value import, but it reaches the native
// emitter only LAZILY (emit.ts calls requireNativeModule inside emit(), not at load), so importing this
// from index.ts cannot crash a build.
import { AppRegistry } from 'react-native';

import { HARNESS_COMPONENT_NAME } from './contract.js';
import { harnessEnabled } from './flag.js';
import { HarnessApp } from './HarnessApp.js';

if (harnessEnabled()) {
  AppRegistry.registerComponent(HARNESS_COMPONENT_NAME, () => HarnessApp);
}
