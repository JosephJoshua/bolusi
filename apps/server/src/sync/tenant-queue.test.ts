import { describe, expect, it } from 'vitest';

import { createTenantQueue } from './tenant-queue.js';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('createTenantQueue', () => {
  it('runs one task at a time per tenant, in arrival order', async () => {
    const queue = createTenantQueue();
    const started: string[] = [];
    const first = deferred();
    const second = deferred();
    const a = queue('t1', async () => {
      started.push('a');
      await first.promise;
      return 'a';
    });
    const b = queue('t1', async () => {
      started.push('b');
      await second.promise;
      return 'b';
    });
    await tick();
    expect(started).toEqual(['a']);
    first.resolve();
    await expect(a).resolves.toBe('a');
    await tick();
    expect(started).toEqual(['a', 'b']);
    second.resolve();
    await expect(b).resolves.toBe('b');
  });

  it('runs different tenants concurrently', async () => {
    const queue = createTenantQueue();
    const held = deferred();
    const started: string[] = [];
    void queue('t1', async () => {
      started.push('t1');
      await held.promise;
    });
    const other = queue('t2', async () => {
      started.push('t2');
      return 2;
    });
    await expect(other).resolves.toBe(2);
    expect(started).toEqual(['t1', 't2']);
    held.resolve();
  });

  it('a failed task rejects its own caller and does not block the next one', async () => {
    const queue = createTenantQueue();
    const failing = queue('t1', () => Promise.reject(new Error('boom')));
    const next = queue('t1', () => Promise.resolve('next'));
    await expect(failing).rejects.toThrow('boom');
    await expect(next).resolves.toBe('next');
  });

  it('runs at most maxRunning tenants at once, handing a freed slot to the next tenant', async () => {
    const queue = createTenantQueue(2);
    const holds = [deferred(), deferred(), deferred()];
    const started: string[] = [];
    const runs = ['t1', 't2', 't3'].map((tenant, i) =>
      queue(tenant, async () => {
        started.push(tenant);
        await holds[i]!.promise;
      }),
    );
    await tick();
    expect(started).toEqual(['t1', 't2']);
    holds[0]!.resolve();
    await runs[0];
    await tick();
    expect(started).toEqual(['t1', 't2', 't3']);
    holds[1]!.resolve();
    holds[2]!.resolve();
    await Promise.all(runs);
    // All slots are free again.
    await expect(queue('t4', () => Promise.resolve(4))).resolves.toBe(4);
  });
});
