// The window's view of the core: connect once, then hold the latest state the core pushes.
import { useEffect, useState } from 'react';

import { CORE_EVENTS, type CoreState } from '../core/api.js';
import type { Client } from '../main/rpc.js';

import { connectToCore, hasCoreBridge, latestCoreState } from './core-client.js';

export type CoreView =
  | { readonly mode: 'connecting' }
  | { readonly mode: 'demo' }
  | { readonly mode: 'unavailable' }
  | { readonly mode: 'live'; readonly client: Client; readonly state: CoreState | null };

export function useCore(): CoreView {
  // The demo needs no connection, so it shows on the first paint.
  const [view, setView] = useState<CoreView>(() =>
    hasCoreBridge() ? { mode: 'connecting' } : { mode: 'demo' },
  );
  useEffect(() => {
    if (!hasCoreBridge()) return;
    let live = true;
    let stop: (() => void) | null = null;
    void connectToCore().then((connection) => {
      if (!live) return;
      if (connection.mode !== 'live') {
        setView({ mode: connection.mode });
        return;
      }
      const { client } = connection;
      setView({ mode: 'live', client, state: latestCoreState() });
      const off = client.on(CORE_EVENTS.state, (state) =>
        setView({ mode: 'live', client, state: state as CoreState }),
      );
      // The connection lives as long as the page; only this listener goes.
      stop = off;
    });
    return () => {
      live = false;
      stop?.();
    };
  }, []);
  return view;
}
