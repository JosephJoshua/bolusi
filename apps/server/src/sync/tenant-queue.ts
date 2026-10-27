// One push at a time per tenant, and only a few tenants' pushes at once, queued in this process
// BEFORE a database connection is taken.
//
// Every push transaction locks its tenant's `tenant_op_counters` row (oplog/server-seq.ts), so pushes
// in one tenant already run one after another. Without this queue the waiting pushes each hold a
// pooled connection while they wait on that row lock, and a burst in one business (a franchise's
// stores reconnecting after an outage) drains the whole pool: pulls, bundles and every other tenant's
// pushes then queue behind it. Across tenants the same happens without any lock: when many businesses
// push at once (everyone reconnecting after a server restart), long push transactions take every
// pooled connection and a pull waits half a minute for one. So at most `maxRunning` pushes run at
// once, which leaves the rest of the pool to reads. The sync load test measured both
// (docs/development.md).
//
// The database lock stays the correctness guarantee (it also orders pushes across server processes);
// this queue only keeps the waiting in memory, where it costs nothing.

export type TenantQueue = <T>(tenantId: string, task: () => Promise<T>) => Promise<T>;

/** Concurrent push transactions per server process; pg.Pool holds 10 connections by default. */
export const PUSH_CONCURRENCY = 6;

export function createTenantQueue(maxRunning = PUSH_CONCURRENCY): TenantQueue {
  const tails = new Map<string, Promise<unknown>>();
  let running = 0;
  const waiting: (() => void)[] = [];

  async function limited<T>(task: () => Promise<T>): Promise<T> {
    if (running < maxRunning) running += 1;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await task();
    } finally {
      // Hand the slot straight to the longest-waiting push, or free it.
      const next = waiting.shift();
      if (next === undefined) running -= 1;
      else next();
    }
  }

  return (tenantId, task) => {
    const previous = tails.get(tenantId) ?? Promise.resolve();
    // Run after the previous push settles either way; a failed push must not wedge the tenant.
    const start = () => limited(task);
    const run = previous.then(start, start);
    const tail = run.catch(() => undefined);
    tails.set(tenantId, tail);
    void tail.then(() => {
      // Forget an idle tenant so the map does not grow with every tenant ever seen.
      if (tails.get(tenantId) === tail) tails.delete(tenantId);
    });
    return run;
  };
}
