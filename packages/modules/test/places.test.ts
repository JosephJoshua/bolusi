// Which places a person sees is decided once and read by both the phone and the PC, so the two
// cannot drift. The phone once showed Belanja to a buyer who could not read the parts list.
import { describe, expect, test } from 'vitest';

import { INVENTORY_PERMISSION, opensParts, opensTransfers } from '../src/inventory/index.js';
import { MONEY_PERMISSION, managesPaymentMethods, opensKas } from '../src/money/index.js';
import { PURCHASING_PERMISSION, opensPurchasing } from '../src/purchasing/index.js';
import { REPAIR_PERMISSION, repairAbilities, repairSettingsAccess } from '../src/repair/index.js';

const holding = (...granted: string[]) => ({
  hasPermission: (id: string) => granted.includes(id),
});

describe('places', () => {
  test('Belanja needs the parts list as well as buying', () => {
    const buyer = holding(PURCHASING_PERMISSION.buy);
    expect(opensPurchasing(holding(), buyer)).toBe(false);
    expect(opensPurchasing(undefined, buyer)).toBe(false);
    expect(opensPurchasing(holding(INVENTORY_PERMISSION.read), buyer)).toBe(true);
    expect(opensPurchasing(holding(INVENTORY_PERMISSION.read), holding())).toBe(false);
    expect(opensParts(holding(INVENTORY_PERMISSION.read))).toBe(true);
  });

  test('Kiriman needs the parts list and sending or receiving', () => {
    const I = INVENTORY_PERMISSION;
    expect(opensTransfers(holding(I.read, I.transfer))).toBe(true);
    expect(opensTransfers(holding(I.read, I.receive))).toBe(true);
    expect(opensTransfers(holding(I.read))).toBe(false);
    expect(opensTransfers(holding(I.transfer, I.receive))).toBe(false);
  });

  test('Kas opens for counting alone; payment methods need receive too', () => {
    expect(opensKas(holding(MONEY_PERMISSION.countCash))).toBe(true);
    expect(opensKas(holding())).toBe(false);
    expect(managesPaymentMethods(holding(MONEY_PERMISSION.manageAccounts))).toBe(false);
    expect(
      managesPaymentMethods(
        holding(MONEY_PERMISSION.receive, MONEY_PERMISSION.manageCentralAccounts),
      ),
    ).toBe(true);
  });

  test('repair settings pages follow their permissions', () => {
    const access = repairSettingsAccess(
      repairAbilities(holding(REPAIR_PERMISSION.hideIntakeOptions).hasPermission),
    );
    expect(access).toEqual({
      intakeOptions: true,
      cancelFees: false,
      uncollected: false,
      printSettings: false,
    });
  });
});
