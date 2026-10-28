// Metode pembayaran over a real runtime: a store owner adds and switches off the store's methods,
// the business owner adds one for every store, and a store owner cannot change that one.
import idMoneyCatalog from '@bolusi/modules/money/i18n/id.json';
import enMoneyCatalog from '@bolusi/modules/money/i18n/en.json';
import { registerMoneyCatalog, type MoneyRuntime } from '@bolusi/modules/money/screens';
import { servisanCustomers } from '@bolusi/modules/repair/screens';
import { afterEach, expect, test } from 'vitest';

import {
  ensureRepairCatalog,
  openRepairScreenHarness,
  press,
  render,
  repairRuntimeFor,
  settle,
  text,
  type,
  type RepairHarness,
  type RenderResult,
} from '../../../test/repair-support.js';

import { PaymentMethodsRoute } from './PaymentMethodsRoute.js';

let h: RepairHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

function moneyRuntimeFor(harness: RepairHarness, userId: string): MoneyRuntime {
  const repair = repairRuntimeFor(harness, userId);
  return {
    ...repair.money,
    subscribe: repair.subscribe,
    nameOf: () => null,
    customersOf: (documents) => servisanCustomers(repair, documents),
  };
}

async function mount(
  harness: RepairHarness,
  userId: string,
  onNav?: (nav: { handleBack: () => boolean } | null) => void,
): Promise<RenderResult> {
  ensureRepairCatalog();
  registerMoneyCatalog({ id: idMoneyCatalog, en: enMoneyCatalog });
  const screen = render(
    <PaymentMethodsRoute
      runtime={moneyRuntimeFor(harness, userId)}
      syncChip={null}
      onClose={() => undefined}
      onRegisterSurfaceNav={onNav}
    />,
  );
  await settle();
  return screen;
}

async function accounts(harness: RepairHarness, userId: string, includeInactive = false) {
  return (await harness.moneyQuery('paymentAccounts', { includeInactive }, userId)).rows as {
    id: string;
    name: string;
    kind: string;
    active: boolean;
    central: boolean;
  }[];
}

test('a store owner adds a method the counter can then take payments with', async () => {
  h = await openRepairScreenHarness(5501);
  const screen = await mount(h, h.storeOwnerId);
  expect(text(screen, 'money.methods.cash')).toContain('Tunai');
  expect(screen.query('money.methods.empty')).not.toBeNull();

  await press(screen, 'money.methods.primary');
  // Only the business owner adds one for every store.
  expect(screen.query('money.methodForm.central')).toBeNull();
  await press(screen, 'money.methodForm.primary');
  expect(text(screen, 'money.methodForm.name')).toContain('Isi namanya.');
  await press(screen, 'money.methodForm.kind.edc');
  type(screen, 'money.methodForm.name', 'EDC Mandiri');
  await settle();
  await press(screen, 'money.methodForm.primary');

  expect(screen.query('money.methodForm')).toBeNull();
  const [edc] = await accounts(h, h.cashierId);
  expect(edc).toMatchObject({ name: 'EDC Mandiri', kind: 'edc', active: true, central: false });
  expect(text(screen, `money.methods.row.${edc!.id}`)).toContain('EDC');
});

test('a method switched off is kept, last and marked, and no longer offered', async () => {
  h = await openRepairScreenHarness(5502);
  const { accountId } = (await h.money(
    'saveAccount',
    { kind: 'qris', name: 'QRIS lama' },
    h.storeOwnerId,
  )) as { accountId: string };
  await h.money('saveAccount', { kind: 'transfer', name: 'BRI toko' }, h.storeOwnerId);
  const screen = await mount(h, h.storeOwnerId);

  await press(screen, `money.methods.row.${accountId}`);
  // Its kind is fixed once payments may have gone through it.
  expect(screen.query('money.methodForm.kind.edc')).toBeNull();
  await press(screen, 'money.methodForm.active');
  await press(screen, 'money.methodForm.primary');

  expect(text(screen, `money.methods.row.${accountId}`)).toContain('Tidak dipakai');
  expect((await accounts(h, h.cashierId)).map((a) => a.name)).toEqual(['BRI toko']);
  expect((await accounts(h, h.storeOwnerId, true)).map((a) => a.name)).toContain('QRIS lama');
});

test('the business owner adds one for every store; a store owner cannot change it', async () => {
  h = await openRepairScreenHarness(5503);
  const owner = await mount(h, h.ownerId);
  await press(owner, 'money.methods.primary');
  await press(owner, 'money.methodForm.kind.transfer');
  type(owner, 'money.methodForm.name', 'BCA pusat');
  await settle();
  await press(owner, 'money.methodForm.central');
  await press(owner, 'money.methodForm.primary');
  const [central] = await accounts(h, h.cashierId);
  expect(central).toMatchObject({ name: 'BCA pusat', central: true });
  owner.unmount();

  const storeOwner = await mount(h, h.storeOwnerId);
  const row = storeOwner.all(`money.methods.row.${central!.id}`)[0]!;
  expect(text(storeOwner, `money.methods.row.${central!.id}`)).toContain('Semua toko');
  expect(row.props['onPress']).toBeUndefined();
});

test('back from a half-typed method asks before dropping it', async () => {
  h = await openRepairScreenHarness(5504);
  let nav: { handleBack: () => boolean } | null = null;
  const screen = await mount(h, h.storeOwnerId, (next) => {
    nav = next;
  });
  await press(screen, 'money.methods.primary');
  type(screen, 'money.methodForm.name', 'QRIS');
  await settle();
  expect(nav!.handleBack()).toBe(true);
  await settle();
  expect(screen.query('money.methodForm.discard')).not.toBeNull();
  await press(screen, 'money.methodForm.discard.confirm');
  expect(screen.query('money.methodForm')).toBeNull();
  expect(screen.query('money.methods')).not.toBeNull();
});
