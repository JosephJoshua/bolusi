// The production `AppStatePort` — trigger (c) foreground interval, api/01-sync §5 — over RN `AppState`.
//
// NATIVE, injected like op-sqlite/NetInfo: imported ONLY by `index.ts`. RN's `AppState` reports
// `active | background | inactive | unknown | extension`; the trigger set only distinguishes
// foreground (`active`) from not, so this narrows to `AppStatus` ('active' | 'inactive' | 'background')
// — anything that is not clearly `active`/`background` counts as `inactive` (the interval disarms).
import { AppState, type AppStateStatus } from 'react-native';

import type { AppStatePort, AppStatus } from '../bootstrap/triggers.js';

function narrow(status: AppStateStatus): AppStatus {
  if (status === 'active') return 'active';
  if (status === 'background') return 'background';
  return 'inactive';
}

export const appStatePort: AppStatePort = {
  current(): AppStatus {
    return narrow(AppState.currentState);
  },
  subscribe(listener: (status: AppStatus) => void): () => void {
    const subscription = AppState.addEventListener('change', (status) => {
      listener(narrow(status));
    });
    return () => {
      subscription.remove();
    };
  },
};
