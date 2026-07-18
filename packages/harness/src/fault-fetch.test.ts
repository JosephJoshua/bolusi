// FaultFetch unit tests (testing-guide §3.5 acceptance: "F1–F5 semantics each unit-tested").
// F1/F2 are fetch-boundary faults implemented here; F3/F4/F5 are client-CRASH semantics this
// wrapper only SCHEDULES (a fetch cannot express a transaction rollback) and the device models —
// so here we assert the wrapper fires them at the right request index for the device to observe.
import { describe, expect, test } from 'vitest';

import { FaultFetch, NetworkDroppedError, type FetchLike } from './fault-fetch.js';

function okFetch(seen: string[]): FetchLike {
  return (input, init) => {
    seen.push(`${init.method ?? 'GET'} ${input}`);
    return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
  };
}

describe('FaultFetch', () => {
  test('captures every outbound request body + authorization (the SEC-DEV-05 surface)', async () => {
    const inner = okFetch([]);
    const net = new FaultFetch(inner);
    await net.fetch('http://s/v1/sync/push', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{"a":1}',
    });
    expect(net.requests).toHaveLength(1);
    expect(net.requests[0]).toMatchObject({
      index: 0,
      method: 'POST',
      url: 'http://s/v1/sync/push',
      bodyText: '{"a":1}',
      authorization: 'Bearer t',
    });
  });

  test('F1 — request never reaches the server (throws, inner NOT called)', async () => {
    const seen: string[] = [];
    const net = new FaultFetch(okFetch(seen), [{ atIndex: 0, point: 'F1' }]);
    await expect(net.fetch('http://s', { method: 'POST', headers: {} })).rejects.toBeInstanceOf(
      NetworkDroppedError,
    );
    expect(seen).toEqual([]); // the request never left
  });

  test('F2 — server processes fully, response lost (inner IS called, then throws)', async () => {
    const seen: string[] = [];
    const net = new FaultFetch(okFetch(seen), [{ atIndex: 1, point: 'F2' }]);
    await net.fetch('http://s/first', { method: 'POST', headers: {} }); // index 0 — fine
    await expect(net.fetch('http://s/second', { method: 'POST', headers: {} })).rejects.toThrow(
      /F2/,
    );
    // BOTH requests reached the inner server — F2's whole point is the request WAS processed.
    expect(seen).toEqual(['POST http://s/first', 'POST http://s/second']);
  });

  test('F3/F4/F5 — scheduled client-crash points fire at their index for the device to model', async () => {
    const net = new FaultFetch(okFetch([]), [
      { atIndex: 0, point: 'F3' },
      { atIndex: 2, point: 'F5' },
    ]);
    for (let i = 0; i < 3; i += 1) await net.fetch('http://s', { method: 'POST', headers: {} });
    expect(net.firedClientCrashes).toEqual([
      { index: 0, point: 'F3' },
      { index: 2, point: 'F5' },
    ]);
    // The inner server still ran for all three (a crash is client-side, after the response).
    expect(net.requestCount).toBe(3);
  });

  test('log lines are captured alongside requests (the whole scan set, T-14)', () => {
    const net = new FaultFetch(okFetch([]));
    net.record('access-log line 1');
    expect(net.logLines).toEqual(['access-log line 1']);
  });
});
