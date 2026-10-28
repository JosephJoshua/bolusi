import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

export interface RuntimeContext<R> {
  readonly Provider: (props: {
    readonly runtime: R;
    readonly children: ReactNode;
  }) => React.JSX.Element;
  /** The runtime for the current screen. Throws when mounted outside the provider (a wiring bug). */
  readonly useRuntime: () => R;
}

/** A context for one module's screen runtime port, named in the wiring-bug error. */
export function createRuntimeContext<R>(moduleName: string): RuntimeContext<R> {
  const Context = createContext<R | null>(null);
  return {
    Provider: ({ runtime, children }) => (
      <Context.Provider value={runtime}>{children}</Context.Provider>
    ),
    useRuntime: () => {
      const runtime = useContext(Context);
      if (runtime === null) {
        throw new Error(
          `a ${moduleName} screen was mounted without its runtime provider (04 §7 wiring).`,
        );
      }
      return runtime;
    },
  };
}
