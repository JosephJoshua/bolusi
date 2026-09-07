#!/usr/bin/env node
// Test stub for the lane driver's `LANE_MAESTRO_BIN`. Ignores its args (`test --test-output-dir=… .maestro/`)
// and exits with `STUB_MAESTRO_EXIT` (default 0), so `harness-lane-e2e.test.ts` can host-prove the driver
// propagates maestro's exit code and tears the lane server down — WITHOUT a real emulator or maestro.
process.exit(Number(process.env.STUB_MAESTRO_EXIT ?? '0'));
