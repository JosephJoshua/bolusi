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
    const execute = (): void => {
      runRef.current(runtime).then(
        (data) => {
          if (active) setState({ status: 'ready', data });
        },
        (error: unknown) => {
          if (!active) return;
          const code = errorCodeOrUnexpected(error);
          setState(
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
