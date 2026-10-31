// The production `UpdatesPort` over expo-updates. NATIVE, so imported only by `index.ts`.
import * as Updates from 'expo-updates';

import type { UpdatesPort } from '../bootstrap/app-updates.js';

export const expoUpdatesPort: UpdatesPort = {
  isEnabled: Updates.isEnabled,
  // The native state, so an update the start-up check downloaded counts too.
  pending: () => Updates.latestContext.isUpdatePending,
  async downloadNewer() {
    const found = await Updates.checkForUpdateAsync();
    if (found.isAvailable) await Updates.fetchUpdateAsync();
  },
  reload: () => Updates.reloadAsync(),
};
