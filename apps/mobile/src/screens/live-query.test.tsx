// The shared live read every module screen uses (screen-kit/live.ts), driven by hand so the order
// in which reads finish is the test's choice, not the database's.
import { useLiveQuery, type QueryState } from '@bolusi/modules/screen-kit';
import { act } from 'react';
import { afterEach, describe, expect, test } from 'vitest';

import { render, type RenderResult } from '../../../../packages/ui/test/render.js';

/** A runtime whose every read waits until the test resolves it. */
function manualSource() {
  const listeners = new Set<() => void>();
  const reads: Array<{ resolve: (value: string) => void; reject: (error: unknown) => void }> = [];
  return {
    reads,
    runtime: {
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    run: () =>
      new Promise<string>((resolve, reject) => {
        reads.push({ resolve, reject });
      }),
    change() {
      for (const listener of listeners) listener();
    },
  };
}

const seen: Array<QueryState<string>> = [];
function Probe({
  source,
  run,
  queryKey,
}: {
  readonly source: { subscribe(listener: () => void): () => void };
  readonly run: () => Promise<string>;
  readonly queryKey: string;
}): null {
  seen.push(useLiveQuery(source, run, queryKey));
  return null;
}

const flush = () =>
  act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
const last = () => seen[seen.length - 1];

let screen: RenderResult | null = null;
afterEach(() => {
  screen?.unmount();
  screen = null;
  seen.length = 0;
});

describe('useLiveQuery', () => {
  test('a burst of changes during a read costs one more read, and the newest result wins', async () => {
    const source = manualSource();
    screen = render(<Probe source={source.runtime} run={source.run} queryKey="k" />);
    await flush();
    expect(source.reads).toHaveLength(1);

    // A pull lands five ops while the first read is out.
    for (let i = 0; i < 5; i += 1) source.change();
    await flush();
    expect(source.reads).toHaveLength(1);

    source.reads[0]!.resolve('old');
    await flush();
    expect(last()).toEqual({ status: 'ready', data: 'old' });
    // Exactly one queued re-read, started only after the first finished.
    expect(source.reads).toHaveLength(2);

    source.reads[1]!.resolve('new');
    await flush();
    expect(last()).toEqual({ status: 'ready', data: 'new' });
    expect(source.reads).toHaveLength(2);
  });

  test('a read that throws before returning a promise does not stop later reads', async () => {
    const source = manualSource();
    let calls = 0;
    const run = (): Promise<string> => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('boom'), { code: 'UNEXPECTED' });
      return source.run();
    };
    screen = render(<Probe source={source.runtime} run={run} queryKey="k" />);
    await flush();
    expect(last()?.status).toBe('error');

    source.change();
    await flush();
    source.reads[0]!.resolve('back');
    await flush();
    expect(last()).toEqual({ status: 'ready', data: 'back' });
  });

  test('a read still out when the key changes never lands', async () => {
    const source = manualSource();
    screen = render(<Probe source={source.runtime} run={source.run} queryKey="a" />);
    await flush();
    screen.rerender(<Probe source={source.runtime} run={source.run} queryKey="b" />);
    await flush();
    expect(source.reads).toHaveLength(2);

    source.reads[1]!.resolve('for b');
    await flush();
    source.reads[0]!.resolve('for a');
    await flush();
    expect(last()).toEqual({ status: 'ready', data: 'for b' });
  });
});
