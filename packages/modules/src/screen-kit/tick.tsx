// A count that goes up as time passes, for a read that depends on the clock rather than on data: a
// board left open overnight still moves a phone into "not collected" when its day comes.
import { useEffect, useState } from 'react';

/** Goes up by one every `everyMs`; put it in a live query's key to re-read on that beat. */
export function useTick(everyMs: number): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return tick;
}
