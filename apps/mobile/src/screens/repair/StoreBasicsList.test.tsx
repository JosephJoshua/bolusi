// The store basics a new store still lacks, on the owner's new-phone setup: each row opens the
// setting that fills it, and someone who cannot change them sees none.
import { RepairRuntimeProvider, StoreBasicsList } from '@bolusi/modules/repair/screens';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  openRepairScreenHarness,
  press,
  render,
  repairRuntimeFor,
  settle,
  type RepairHarness,
} from '../../../test/repair-support.js';

let h: RepairHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

function mount(harness: RepairHarness, userId: string, onOpen = vi.fn()) {
  return render(
    <RepairRuntimeProvider runtime={repairRuntimeFor(harness, userId)}>
      <StoreBasicsList onOpen={onOpen} testID="basics" />
    </RepairRuntimeProvider>,
  );
}

describe('the store basics list', () => {
  test('lists what a new store lacks, each leading to its setting', async () => {
    h = await openRepairScreenHarness(92);
    const onOpen = vi.fn();
    const screen = mount(h, h.storeOwnerId, onOpen);
    await settle();
    expect(screen.query('basics.slipHeader')).not.toBeNull();
    expect(screen.query('basics.logo')).not.toBeNull();
    expect(screen.query('basics.terms')).not.toBeNull();
    expect(screen.query('basics.paymentMethods')).not.toBeNull();
    await press(screen, 'basics.logo');
    expect(onOpen).toHaveBeenLastCalledWith('printSettings');
    await press(screen, 'basics.paymentMethods');
    expect(onOpen).toHaveBeenLastCalledWith('paymentMethods');
  });

  test('shows nothing to someone who cannot change them', async () => {
    h = await openRepairScreenHarness(93);
    const screen = mount(h, h.technicianId);
    await settle();
    expect(screen.query('basics')).toBeNull();
  });
});
