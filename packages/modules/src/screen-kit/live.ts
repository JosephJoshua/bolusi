// Live reads for module screens (04 §7): a query that re-runs, without flashing loading, whenever the
// runtime reports a projection change, so a pulled remote op re-renders the mounted screen in place.
import { useEffect, useRef, useState } from 'react';

import { errorCodeOrUnexpected } from '@bolusi/core';

/** Anything that can report projection changes. Every module runtime port has this. */
export interface LiveSource {
  subscribe(listener: () => void): () => void;
}

/** The four screen states (design-system §5) a read can be in. */
export type QueryState<TData> =
  | { readonly status: 'loading' }
  /** A `PERMISSION_DENIED` read: the Unauthorized state, never an empty list (FR-1036). */
  | { readonly status: 'unauthorized' }
  | { readonly status: 'error'; readonly code: string }
  | { readonly status: 'ready'; readonly data: TData };

/**
 * Run `run` against `runtime` and keep it live. `key` is the dependency identity: the query re-runs
 * when it changes (a filter toggles) and on every change the runtime reports. A
 * `PERMISSION_DENIED` throw becomes `unauthorized`; any other throw becomes `error` with its code.
 */
export function useLiveQuery<R extends LiveSource, TData>(
  runtime: R,
  run: (runtime: R) => Promise<TData>,
  key: string,
): QueryState<TData> {
  const [state, setState] = useState<QueryState<TData>>({ status: 'loading' });

  // The latest selector, so a new inline `run` each render does not re-subscribe.
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    let active = true;
    // One read at a time. A pull applies ops one by one and each reports a change, so a burst of
    // changes queues a single re-read after the one in flight instead of a read per op, and an
    // older read can never land after a newer one and put stale rows back on screen.
    let running = false;
    let again = false;
    const settle = (next: QueryState<TData>): void => {
      running = false;
      if (!active) return;
      // Shown even when a change arrived meanwhile: during a long pull the screen keeps filling in
      // rather than waiting for the pull to end. The queued read then brings it up to date.
      setState(next);
      if (again) {
        again = false;
        execute();
      }
    };
    const execute = (): void => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      runRef.current(runtime).then(
        (data) => settle({ status: 'ready', data }),
        (error: unknown) => {
          const code = errorCodeOrUnexpected(error);
          settle(
            code === 'PERMISSION_DENIED' ? { status: 'unauthorized' } : { status: 'error', code },
          );
        },
      );
    };

    execute();
    const unsubscribe = runtime.subscribe(execute);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [runtime, key]);

  return state;
}
