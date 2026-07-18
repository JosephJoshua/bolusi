// SEC-DEV-05 (security-guide §219) — "private key never leaves device". The enrollment-payload leg
// ships in apps/server/test/security/sec-dev.test.ts; the OUTSTANDING leg — the one owned here —
// is the outbound-request interception across a full enroll + sync cycle. The harness's FaultFetch
// (§3.5) is the ONLY surface in the repo that sees every outbound request, which is why the id lives
// with task 26. This asserts the WHOLE captured set (T-14 — every request body + every server log
// line), not a sample.
//
// Falsification (§2.11): the leak scan is proven load-bearing by a positive control that feeds it a
// body deliberately carrying the private seed and watches it go RED — a scan that could never fire
// is worthless (T-17: a fence needs a positive control).
import { describe, expect, test } from 'vitest';

import { FakeClock, mulberry32 } from '@bolusi/test-support';

import { FaultFetch } from '../src/fault-fetch.js';
import { VirtualDevice } from '../src/device.js';
import { mintIdentities } from '../src/identities.js';
import { leakedEncodings, privateKeyEncodings } from '../src/key-leak-scan.js';
import { HarnessServer } from '../src/server.js';

const PUSH = 'http://srv.test/v1/sync/push';
const PULL = 'http://srv.test/v1/sync/pull';

describe('SEC-DEV-05 private key never leaves the device', () => {
  test('SEC-DEV-05 no private-key bytes appear in any outbound request body or server log line across a full enroll and sync cycle', async () => {
    const server = await HarnessServer.boot();
    const identity = mintIdentities(205, 1).devices[0]!;
    const seeded = await server.seedDevice(identity);
    const device = await VirtualDevice.open({
      identity,
      clock: new FakeClock(1_726_100_000_000),
      prng: mulberry32(205),
    });
    // Every outbound request the "device" makes goes through FaultFetch (no sockets) — the only
    // surface that sees them all.
    const net = new FaultFetch(server.fetch);
    const headers = { Authorization: seeded.auth, 'Content-Type': 'application/json' };

    try {
      // Enroll + author, then SYNC: push the whole chain (genesis auth.device_enrolled + notes),
      // then pull. This is the full cycle §219 names.
      await device.createNote({ title: 'note-205-a', body: 'body-205-a' });
      await device.createNote({ title: 'note-205-b', body: 'body-205-b' });
      const ops = await device.wireOps();

      const pushRes = await net.fetch(PUSH, {
        method: 'POST',
        headers,
        body: JSON.stringify({ deviceId: identity.deviceId, ops }),
      });
      const pushBody = (await pushRes.json()) as { results: { status: string }[] };
      // Positive control that the cycle REALLY happened (a vacuous cycle would trivially "leak
      // nothing", T-17): the ops were accepted by the real server.
      expect(pushRes.status).toBe(200);
      expect(pushBody.results.every((r) => r.status === 'accepted')).toBe(true);

      const pullRes = await net.fetch(PULL, {
        method: 'POST',
        headers,
        body: JSON.stringify({ cursor: 0, limit: 500, devicesDirectoryVersion: 0 }),
      });
      expect(pullRes.status).toBe(200);

      // Denominator: the interception surface is non-empty (a scan over zero requests is vacuous).
      expect(net.requests.length).toBeGreaterThanOrEqual(2);

      // THE ASSERTION — over the WHOLE captured set (every request body + every server log line).
      const captured = [...net.requests.map((r) => r.bodyText), ...server.accessLogs];
      for (const text of captured) {
        const leaks = leakedEncodings(text, identity.seed);
        expect(leaks, `private-key material leaked into: ${text.slice(0, 120)}…`).toEqual([]);
      }

      // Sanity: the request bodies are NOT empty — we scanned real content, and the PUBLIC key IS
      // present (in the genesis payload), proving the scan is not merely "found nothing anywhere".
      const allBodies = net.requests.map((r) => r.bodyText).join('');
      expect(allBodies).toContain(identity.publicKeyBase64);
    } finally {
      await device.close();
      await server.close();
    }
  });

  test('SEC-DEV-05 positive control: the leak scan CATCHES a body that carries the private seed', () => {
    const identity = mintIdentities(206, 1).devices[0]!;
    const [hex] = privateKeyEncodings(identity.seed);
    const leakyBody = JSON.stringify({ oops: hex });
    // If the scan could not fire, the assertion above would be worthless.
    expect(leakedEncodings(leakyBody, identity.seed).length).toBeGreaterThan(0);
    // And a body with only the PUBLIC key is NOT flagged (the scan is scoped to the secret).
    const publicOnly = JSON.stringify({ devicePublicKeyB64: identity.publicKeyBase64 });
    expect(leakedEncodings(publicOnly, identity.seed)).toEqual([]);
  });
});
