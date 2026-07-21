// SEC-SECRET-01 (security-guide §10) — "no secret material in logs: a log-redaction test greps
// captured logs from a full enroll+auth+sync integration run for token values, PINs, and key bytes".
//
// The run is the real one: the production `@bolusi/server` in process (`HarnessServer`), a real
// `VirtualDevice` that enrols (its genesis `auth.device_enrolled` op), authenticates (a device
// bearer on every request), authors, pushes and pulls. The scanned surface is the server's OWN
// access-log sink — the production `accessLog` middleware writing production records — plus every
// outbound request body, captured by `FaultFetch` (the one surface that sees them all).
//
// FALSIFICATION (§2.11 / T-17), watched during development: the scan is only worth its green if it
// can go red, so the second test plants each secret into a log-shaped line and requires a hit, and
// the first test asserts the log is NON-EMPTY and DOES contain the non-secret fields (path, status,
// deviceId) — otherwise "found no token in the logs" would be satisfied by having no logs.
import { describe, expect, test } from 'vitest';

import { FakeClock, mulberry32 } from '@bolusi/test-support';

import { FaultFetch } from '../../src/fault-fetch.js';
import { VirtualDevice } from '../../src/device.js';
import { mintIdentities } from '../../src/identities.js';
import { privateKeyEncodings, leakedEncodings } from '../../src/key-leak-scan.js';
import { HarnessServer } from '../../src/server.js';

const PUSH = 'http://srv.test/v1/sync/push';
const PULL = 'http://srv.test/v1/sync/pull';
const SEED = 2810;
/** A PIN never transits the network by design (api/02-auth §3) — scanned to prove it stays so. */
const PIN = '424242';

describe('SEC-SECRET-01 no secret material reaches the logs', () => {
  test('SEC-SECRET-01 a full enroll, auth and sync run leaves no bearer token, PIN, or private-key byte in any server log line or request body', async () => {
    const server = await HarnessServer.boot();
    const identity = mintIdentities(SEED, 1).devices[0]!;
    const seeded = await server.seedDevice(identity);
    const device = await VirtualDevice.open({
      identity,
      clock: new FakeClock(1_726_100_000_000),
      prng: mulberry32(SEED),
    });
    const net = new FaultFetch(server.fetch);
    // The bearer VALUE — the exact string a log line must never carry (security-guide §10).
    const token = seeded.auth.replace(/^Bearer /, '');
    const headers = { Authorization: seeded.auth, 'Content-Type': 'application/json' };

    try {
      await device.createNote({ title: `note-${SEED}`, body: `body-${SEED}` });
      const ops = await device.wireOps();

      const pushRes = await net.fetch(PUSH, {
        method: 'POST',
        headers,
        body: JSON.stringify({ deviceId: identity.deviceId, ops }),
      });
      expect(pushRes.status).toBe(200);
      const pushBody = (await pushRes.json()) as { results: { status: string }[] };
      // Positive control that the run really happened — a vacuous run leaks nothing trivially.
      expect(pushBody.results.length).toBeGreaterThan(0);
      expect(pushBody.results.every((r) => r.status === 'accepted')).toBe(true);

      const pullRes = await net.fetch(PULL, {
        method: 'POST',
        headers,
        body: JSON.stringify({ cursor: 0, limit: 500, devicesDirectoryVersion: 0 }),
      });
      expect(pullRes.status).toBe(200);

      // ── denominators (T-14): a scan over an empty log set proves nothing ──────────────────────
      expect(
        server.accessLogs.length,
        'the server produced no access-log records',
      ).toBeGreaterThanOrEqual(2);
      expect(net.requests.length, 'no outbound request was captured').toBeGreaterThanOrEqual(2);
      const logText = server.accessLogs.join('\n');
      // The logs really are the production records — they carry exactly what api/00 §13 step 3
      // says they carry, so "no token found" is a statement about a populated log, not a blank one.
      expect(logText).toContain('/v1/sync/push');
      expect(logText).toContain(identity.deviceId);
      expect(logText).toContain('"status":200');

      // ── THE ASSERTION over the WHOLE captured set ─────────────────────────────────────────────
      const captured = [...server.accessLogs, ...net.requests.map((r) => r.bodyText)];
      for (const text of captured) {
        expect(text, 'a bearer token value reached a log line or request body').not.toContain(
          token,
        );
        expect(text, 'a PIN reached a log line or request body').not.toContain(PIN);
        expect(
          leakedEncodings(text, identity.seed),
          `private-key material leaked into: ${text.slice(0, 120)}…`,
        ).toEqual([]);
      }
      // The Authorization header itself is never logged (api/00 §13 step 3).
      expect(logText).not.toContain('Authorization');
      expect(logText).not.toContain('Bearer');
    } finally {
      await device.close();
      await server.close();
    }
  });

  test('SEC-SECRET-01 positive control: the redaction scan CATCHES a token, a PIN, and key bytes planted in a log-shaped line', () => {
    const identity = mintIdentities(SEED + 1, 1).devices[0]!;
    const token = 'bdt_harness_0000000f';
    const line = JSON.stringify({
      msg: 'access',
      path: '/v1/sync/push',
      authorization: `Bearer ${token}`,
      pin: PIN,
      seed: privateKeyEncodings(identity.seed)[0],
    });
    expect(line).toContain(token);
    expect(line).toContain(PIN);
    expect(leakedEncodings(line, identity.seed).length).toBeGreaterThan(0);
    // …and a clean line is not flagged (the scan is scoped to the secrets, not to any hex string).
    const clean = JSON.stringify({ msg: 'access', path: '/v1/sync/push', status: 200 });
    expect(clean).not.toContain(token);
    expect(leakedEncodings(clean, identity.seed)).toEqual([]);
  });
});
