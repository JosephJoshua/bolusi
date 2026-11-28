// The phone's cancellation fees form over the real offline core, sharing its hook with the PC: a
// save from another device that syncs in while the form is open fills in the fee the owner has not
// touched and keeps the one they typed, and saving then sends only their edit on top.
import { afterEach, expect, test, vi } from 'vitest';

import {
  openRepairScreenHarness,
  press,
  render,
  repairRuntimeFor,
  settle,
  type,
  type RepairHarness,
  type RenderResult,
} from '../../../test/repair-support.js';

import { RepairSettingsRoute } from './RepairSettingsRoute.js';

let h: RepairHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

function fieldValue(screen: RenderResult, testID: string): unknown {
  return screen.get(`${testID}.field`).props['value'];
}

test('an open fees form follows a save from elsewhere and keeps what the owner typed', async () => {
  h = await openRepairScreenHarness(5802);
  const runtime = repairRuntimeFor(h, h.ownerId);
  await runtime.run('setCancelFees', { beforeWork: 10_000, afterWork: 20_000 });
  const screen = render(
    <RepairSettingsRoute page="cancelFees" runtime={runtime} syncChip={null} onClose={vi.fn()} />,
  );
  await settle();

  type(screen, 'repair.fees.afterWork', '45000');
  await settle();
  // Another device changes both fees; the live read brings them in.
  await runtime.run('setCancelFees', { beforeWork: 15_000, afterWork: 30_000 });
  await settle();

  expect(fieldValue(screen, 'repair.fees.beforeWork')).toBe('Rp 15.000');
  expect(fieldValue(screen, 'repair.fees.afterWork')).toBe('Rp 45.000');

  await press(screen, 'repair.fees.primary');
  await settle();
  const saved = (await runtime.query('cancelFees', {})).rows[0]!;
  expect(saved).toMatchObject({ beforeWork: 15_000, afterWork: 45_000 });
});
