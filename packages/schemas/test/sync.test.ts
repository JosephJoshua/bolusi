import { describe, expect, test } from 'vitest';

import {
  zDeviceInfo,
  zPullRequest,
  zPullResponse,
  zPushRequest,
  zPushResult,
  zPushResponse,
} from '../src/index.js';
import { validDeviceInfo, validOp } from './fixtures.js';

describe('push request (api/01 §3) — request-direction: strict', () => {
  test('a batch of two ops parses', () => {
    const result = zPushRequest.safeParse({
      deviceId: 'c3d4e5f6-a7b8-4c9d-8e0f-2a3b4c5d6e7f',
      ops: [validOp(), { ...validOp(), seq: 8, id: '0197a1b2-c3d4-7e5f-8a6b-1c2d3e4f5a77' }],
    });
    expect(result.success).toBe(true);
  });

  test('a batch of exactly 500 ops parses (boundary)', () => {
    const result = zPushRequest.safeParse({
      deviceId: 'c3d4e5f6-a7b8-4c9d-8e0f-2a3b4c5d6e7f',
      ops: Array.from({ length: 500 }, () => validOp()),
    });
    expect(result.success).toBe(true);
  });

  test('a batch of 501 ops fails (max 500)', () => {
    const result = zPushRequest.safeParse({
      deviceId: 'c3d4e5f6-a7b8-4c9d-8e0f-2a3b4c5d6e7f',
      ops: Array.from({ length: 501 }, () => validOp()),
    });
    expect(result.success).toBe(false);
  });

  test('a missing deviceId fails', () => {
    expect(zPushRequest.safeParse({ ops: [validOp()] }).success).toBe(false);
  });

  test('an unknown key on the push request fails', () => {
    const result = zPushRequest.safeParse({
      deviceId: 'c3d4e5f6-a7b8-4c9d-8e0f-2a3b4c5d6e7f',
      ops: [validOp()],
      compression: 'gzip',
    });
    expect(result.success).toBe(false);
  });
});

describe('push results (api/01 §3) — response-direction: tolerant', () => {
  test('an accepted result with serverSeq parses', () => {
    const result = zPushResult.safeParse({
      id: '0197a1b2-c3d4-7e5f-8a6b-1c2d3e4f5a6b',
      status: 'accepted',
      serverSeq: 9101,
    });
    expect(result.success).toBe(true);
  });

  test('a duplicate result parses', () => {
    const result = zPushResult.safeParse({
      id: '0197a1b2-c3d4-7e5f-8a6b-1c2d3e4f5a88',
      status: 'duplicate',
    });
    expect(result.success).toBe(true);
  });

  test('a rejected result with code and reason parses', () => {
    const result = zPushResult.safeParse({
      id: '0197a1b2-c3d4-7e5f-8a6b-1c2d3e4f5a99',
      status: 'rejected',
      code: 'BAD_SIGNATURE',
      reason: 'signature does not verify against device pubkey',
    });
    expect(result.success).toBe(true);
  });

  test('an unknown status fails', () => {
    const result = zPushResult.safeParse({
      id: '0197a1b2-c3d4-7e5f-8a6b-1c2d3e4f5aaa',
      status: 'deferred',
    });
    expect(result.success).toBe(false);
  });

  test('a push response with an extra unknown field still parses (api/00 §4)', () => {
    const result = zPushResponse.safeParse({
      results: [{ id: '0197a1b2-c3d4-7e5f-8a6b-1c2d3e4f5abb', status: 'accepted', serverSeq: 42 }],
      serverTime: 1752483000111,
      compressionHint: 'gzip',
    });
    expect(result.success).toBe(true);
  });
});

describe('pull request (api/01 §4) — request-direction: strict', () => {
  test('a full pull request parses', () => {
    const result = zPullRequest.safeParse({ cursor: 0, limit: 500, devicesDirectoryVersion: 0 });
    expect(result.success).toBe(true);
  });

  test('a negative cursor fails', () => {
    const result = zPullRequest.safeParse({ cursor: -1, limit: 500, devicesDirectoryVersion: 3 });
    expect(result.success).toBe(false);
  });

  test('a non-integer devicesDirectoryVersion fails', () => {
    const result = zPullRequest.safeParse({ cursor: 10, limit: 500, devicesDirectoryVersion: 2.5 });
    expect(result.success).toBe(false);
  });

  test('an absent limit is filled with the endpoint default of 500 (api/00 §10)', () => {
    const result = zPullRequest.safeParse({ cursor: 250, devicesDirectoryVersion: 4 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(500);
    }
  });

  test('a limit above the hard max fails', () => {
    const result = zPullRequest.safeParse({ cursor: 11, limit: 501, devicesDirectoryVersion: 5 });
    expect(result.success).toBe(false);
  });

  test('an unknown key on the pull request fails', () => {
    const result = zPullRequest.safeParse({
      cursor: 12,
      limit: 100,
      devicesDirectoryVersion: 6,
      scope: 'all-stores',
    });
    expect(result.success).toBe(false);
  });
});

describe('pull response + devices sidecar (api/01 §4–4.1)', () => {
  test('a pull response with ops and sidecar parses', () => {
    const result = zPullResponse.safeParse({
      ops: [validOp()],
      nextCursor: 9102,
      hasMore: false,
      serverTime: 1752483200222,
      devices: [validDeviceInfo()],
      devicesDirectoryVersion: 7,
    });
    expect(result.success).toBe(true);
  });

  test('a pull response without the sidecar parses (version matched)', () => {
    const result = zPullResponse.safeParse({
      ops: [],
      nextCursor: 9103,
      hasMore: true,
      serverTime: 1752483300333,
    });
    expect(result.success).toBe(true);
  });

  test('a pull response with an extra unknown field still parses (api/00 §4)', () => {
    const result = zPullResponse.safeParse({
      ops: [],
      nextCursor: 9104,
      hasMore: false,
      serverTime: 1752483400444,
      staleHint: 'fresh',
    });
    expect(result.success).toBe(true);
  });

  test('a pulled op with an extra key on the signed core fails (quarantine input, api/01 §4.2)', () => {
    const result = zPullResponse.safeParse({
      ops: [{ ...validOp(), injected: true }],
      nextCursor: 9105,
      hasMore: false,
      serverTime: 1752483500555,
    });
    expect(result.success).toBe(false);
  });
});

describe('DeviceInfo (api/01 §4.1)', () => {
  test('kind member parses', () => {
    expect(zDeviceInfo.safeParse({ ...validDeviceInfo(), kind: 'member' }).success).toBe(true);
  });

  test('kind system parses', () => {
    expect(
      zDeviceInfo.safeParse({ ...validDeviceInfo(), kind: 'system', storeId: null }).success,
    ).toBe(true);
  });

  test('a kind outside member|system fails', () => {
    expect(zDeviceInfo.safeParse({ ...validDeviceInfo(), kind: 'observer' }).success).toBe(false);
  });

  test('a revoked device row parses — revoked devices stay listed', () => {
    const result = zDeviceInfo.safeParse({
      ...validDeviceInfo(),
      id: 'e5f6a7b8-c9d0-4e1f-8a2b-4c5d6e7f8a9b',
      status: 'revoked',
      revokedAt: 1752484000666,
    });
    expect(result.success).toBe(true);
  });

  test('revokedAt is nullable-present: absent fails', () => {
    const device: Record<string, unknown> = validDeviceInfo();
    delete device['revokedAt'];
    expect(zDeviceInfo.safeParse(device).success).toBe(false);
  });

  test('a status outside active|revoked fails (03-state-machines §5)', () => {
    expect(zDeviceInfo.safeParse({ ...validDeviceInfo(), status: 'suspended' }).success).toBe(
      false,
    );
  });
});
