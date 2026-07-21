// The budget-constants guard (task 27a acceptance; CLAUDE.md §2.11). This re-states testing-guide
// §4.2 and the SEED-200K spec by HAND and asserts the pinned constants equal them, so a silently
// widened budget — the "make the red gate pass by moving the line" move — reds this Node lane on
// every PR instead of shipping. The gates themselves run on the physical device (27b); the CONSTANTS
// live here now, version-controlled.
import { describe, expect, test } from 'vitest';

import { SEED_200K } from '@bolusi/test-support';

import { PART_C_BUDGETS } from './budgets.js';

describe('Part C budget constants mirror testing-guide §4.2 verbatim', () => {
  test('P-1 cold start', () => {
    expect(PART_C_BUDGETS.p1ColdStartMaxMs).toBe(3_000);
    expect(PART_C_BUDGETS.p1ColdLaunches).toBe(5);
  });

  test('P-2 rebuild + memory', () => {
    expect(PART_C_BUDGETS.p2RebuildMaxSeconds).toBe(300);
    expect(PART_C_BUDGETS.p2PeakPssMaxMb).toBe(400);
    expect(PART_C_BUDGETS.p2PssSampleEverySeconds).toBe(5);
    expect(PART_C_BUDGETS.p2MinProgressFps).toBe(1);
    // 300 s over 200k ops = the 667 ops/s floor (§4.2 rounds 666.67 up to 667).
    expect(Math.round(SEED_200K.totalOps / PART_C_BUDGETS.p2RebuildMaxSeconds)).toBe(
      PART_C_BUDGETS.writeThroughputFloorOpsPerSecond,
    );
  });

  test('P-3 backlog sync', () => {
    expect(PART_C_BUDGETS.p3BacklogMaxSeconds).toBe(60);
    expect(PART_C_BUDGETS.p3PullOps).toBe(3_500);
    expect(PART_C_BUDGETS.p3PullBatches).toBe(7);
    expect(PART_C_BUDGETS.p3PushOps).toBe(500);
    expect(PART_C_BUDGETS.p3PushBatches).toBe(1);
  });

  test('P-4 argon2id verify + params (default and documented floor)', () => {
    expect(PART_C_BUDGETS.p4VerifyP95MaxMs).toBe(300);
    expect(PART_C_BUDGETS.p4Runs).toBe(20);
    expect(PART_C_BUDGETS.p4DefaultParams).toEqual({ memKiB: 32_768, timeCost: 3, parallelism: 1 });
    expect(PART_C_BUDGETS.p4FloorParams).toEqual({ memKiB: 19_456, timeCost: 2, parallelism: 1 });
  });

  test('P-5 command local latency', () => {
    expect(PART_C_BUDGETS.p5ExecuteP95MaxMs).toBe(100);
    expect(PART_C_BUDGETS.p5Runs).toBe(200);
  });

  test('P-6 per-op crypto micro-gate', () => {
    expect(PART_C_BUDGETS.p6CryptoP95MaxMs).toBe(5);
    expect(PART_C_BUDGETS.p6Iterations).toBe(1_000);
  });

  test('write-throughput floor', () => {
    expect(PART_C_BUDGETS.writeThroughputFloorOpsPerSecond).toBe(667);
  });
});
