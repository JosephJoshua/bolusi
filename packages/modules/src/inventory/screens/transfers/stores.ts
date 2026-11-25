// The business's other stores for the transfer screens, as the device last heard of them.
import { useEffect, useState } from 'react';

import { useInventoryRuntime } from '../../runtime.js';
import type { StoreChoice } from '../../transfers/form.js';

/** The other stores by name; empty until read, or where the runtime knows none. */
export function useStores(): readonly StoreChoice[] {
  const runtime = useInventoryRuntime();
  const [stores, setStores] = useState<readonly StoreChoice[]>([]);
  useEffect(() => {
    let live = true;
    void (runtime.otherStores?.() ?? Promise.resolve([]))
      .then((rows) => {
        if (live) setStores(rows);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [runtime]);
  return stores;
}
