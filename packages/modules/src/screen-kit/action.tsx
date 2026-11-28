// Running a command from a screen: one at a time, with its failure kept as an error code the screen
// can show. A local command appends and projects in milliseconds, so screens await it and stay put
// on failure instead of navigating away from a change that never happened.
import { useCallback, useEffect, useRef, useState } from 'react';

import { errorCodeOrUnexpected, refusalKeyOf } from '@bolusi/core';

export interface ActionRunner {
  /** True while an action runs; a second `run` meanwhile is ignored (a double tap). */
  readonly busy: boolean;
  /**
   * The last failure, until the next run or `clearError`: the rule's refusal key when a change
   * type's rule refused it, else the error code. Render it with `translateFailure`.
   */
  readonly errorCode: string | null;
  /** Run `action`; resolves its result, or `undefined` when it failed or another was running. */
  run<T>(action: () => Promise<T>): Promise<T | undefined>;
  clearError(): void;
}

export function useActionRunner(): ActionRunner {
  const [busy, setBusy] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const running = useRef(false);

  const run = useCallback(async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
    if (running.current) return undefined;
    running.current = true;
    setBusy(true);
    setErrorCode(null);
    try {
      return await action();
    } catch (error) {
      setErrorCode(refusalKeyOf(error) ?? errorCodeOrUnexpected(error));
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
 * A camera, signature pad or player opened through the step's runner: one thing at a time, and a
 * failure shows where the step's failures do, but `busy` stays false so the step's own button does
 * not spin under the camera as if it were saving.
 */
export function useCapture(runner: ActionRunner): {
  readonly busy: boolean;
  readonly capture: <T>(take: () => Promise<T>) => Promise<T | undefined>;
} {
  const [capturing, setCapturing] = useState(false);
  const capture = useCallback(
    async <T,>(take: () => Promise<T>): Promise<T | undefined> => {
      setCapturing(true);
      try {
        return await runner.run(take);
      } finally {
        setCapturing(false);
      }
    },
    [runner],
  );
  return { busy: runner.busy && !capturing, capture };
}

/**
 * Ask a live form whether the user may leave (design-system §8.1). The form runs its own
 * dirty-check and confirm, and calls `proceed` only once the user agrees.
 */
export type DiscardGuard = (proceed: () => void) => void;

/**
 * A screen's own step back for hardware back (design-system §8.1): it closes an open step or moves
 * a wizard back one step and returns `true`, or returns `false` when it is already at its first
 * step and the surface should leave the screen instead.
 */
export type StepBack = () => boolean;

/**
 * A place's open step (a part, an order, a form), published to the shell so hardware back closes
 * it and the place's tabs hide while it owns the screen. A place publishes `null` on its own list.
 */
export interface PlaceStep {
  /** Step back one level; a step with something typed asks first. */
  readonly back: () => void;
  /** The place's list is still on screen beside the step (a wide tablet), so its tabs stay. */
  readonly listBeside: boolean;
}

/**
 * Another place asking this one to show something: Perlu dicek opening a servisan's request, or
 * Barang's stock below zero. Each ask carries a new `nonce`, so asking for the same thing twice
 * opens it twice.
 */
export interface PlaceOpen<Target> {
  readonly nonce: number;
  readonly target: Target;
}

/** Runs `apply` once for each new ask, however often the place re-renders. */
export function usePlaceOpen<Target>(
  open: PlaceOpen<Target> | null | undefined,
  apply: (target: Target) => void,
): void {
  const seen = useRef<number | null>(null);
  const applyRef = useRef(apply);
  applyRef.current = apply;
  useEffect(() => {
    if (open === null || open === undefined || seen.current === open.nonce) return;
    seen.current = open.nonce;
    applyRef.current(open.target);
  }, [open]);
}
