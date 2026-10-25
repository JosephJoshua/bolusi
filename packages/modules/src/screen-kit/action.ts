// Running a command from a screen: one at a time, with its failure kept as an error code the screen
// can show. A local command appends and projects in milliseconds, so screens await it and stay put
// on failure instead of navigating away from a change that never happened.
import { useCallback, useRef, useState } from 'react';

import { errorCodeOrUnexpected } from '@bolusi/core';

export interface ActionRunner {
  /** True while an action runs; a second `run` meanwhile is ignored (a double tap). */
  readonly busy: boolean;
  /** The last failure's error code, until the next run or `clearError`. */
  readonly errorCode: string | null;
  /** Run `action`; resolves its result, or `undefined` when it failed or another was running. */
  run<T>(action: () => Promise<T>): Promise<T | undefined>;
  clearError(): void;
}

export function useActionRunner(): ActionRunner {
  const [busy, setBusy] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const running = useRef(false);

  const run = useCallback(async <T>(action: () => Promise<T>): Promise<T | undefined> => {
    if (running.current) return undefined;
    running.current = true;
    setBusy(true);
    setErrorCode(null);
    try {
      return await action();
    } catch (error) {
      setErrorCode(errorCodeOrUnexpected(error));
      return undefined;
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, []);

  const clearError = useCallback(() => setErrorCode(null), []);
  return { busy, errorCode, run, clearError };
}

/**
 * Ask a live form whether the user may leave (design-system §8.1). The form runs its own
 * dirty-check and confirm, and calls `proceed` only once the user agrees.
 */
export type DiscardGuard = (proceed: () => void) => void;
