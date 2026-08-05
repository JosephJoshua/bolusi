import { useCallback, useRef } from 'react';

/**
 * A STABLE-identity wrapper that always calls the LATEST `fn`.
 *
 * `Root` hands `<App>` fresh inline-arrow callbacks every render, and `App` is not memoized, so it
 * re-renders on every Root `bump()` (a sync tick, a pulled op, a flow's own `finally` emit). A callback
 * threaded straight into an effect/submit dependency therefore re-fires that effect on unrelated
 * renders. Wrapping it here yields a `[]`-stable identity that still dispatches to the current prop, so
 * an effect keyed on the wrapper fires only when its OWN inputs change — never on the parent's arrow
 * churn. This is the pattern the task 186b-1 review fix introduced; `test/app-unlock-load.test.tsx`
 * (the owner-picker load must fire ONCE per entry) is its guard.
 *
 * Writing `ref.current` in the render body is the standard latest-ref idiom: the ref is READ only inside
 * the returned callback (post-commit), never during render, so a discarded concurrent render cannot feed
 * a stale value.
 */
export function useLatestCallback<A extends unknown[], R>(
  fn: (...args: A) => R,
): (...args: A) => R {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: A) => ref.current(...args), []);
}
