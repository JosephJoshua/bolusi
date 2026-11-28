/**
 * Several cash drawers on the phone: an owner adds one in Metode pembayaran and limits it to a role,
 * Kas then switches between the drawers, and Pindah kas moves cash from one to the other.
 */
import type { Page } from '@playwright/test';

import { expect, shoot as check, test } from './qa';
import { toServisan } from './shell';

const tap = (page: Page, testID: string) => page.getByTestId(testID).first().click();
const fill = (page: Page, testID: string, text: string) =>
  page.getByTestId(`${testID}.field`).fill(text);
const shoot = (page: Page, name: string) => check(page, 'drawers', name);

test('an owner adds a drawer for the Manajer, then moves cash into it from Kas', async ({
  page,
}) => {
  await page.goto('/?screen=repair&state=owner');
  await toServisan(page);
  await tap(page, 'ui.avatarButton');
  await tap(page, 'shell-open-settings');
  await tap(page, 'settings-payment-methods');
  await expect(page.getByTestId('money.methods.drawer.cash')).toContainText('Semua jabatan');
  await shoot(page, 'methods-one-drawer');

  await tap(page, 'money.methods.addDrawer');
  await fill(page, 'money.drawerForm.name', 'Laci aksesoris');
  await tap(page, 'money.drawerForm.scope.some');
  await tap(page, 'money.drawerForm.role.role-manajer');
  await shoot(page, 'drawer-form');
  await tap(page, 'money.drawerForm.primary');
  await expect(page.getByText('Laci aksesoris disimpan.')).toBeVisible();
  await shoot(page, 'methods-two-drawers');

  // Back out of Metode pembayaran and Settings to the tabs.
  const kasTab = page.getByTestId('shell-tabs.kas');
  for (let step = 0; step < 3 && !(await kasTab.isVisible()); step += 1) {
    await page.getByRole('button', { name: 'Kembali' }).first().click();
  }
  await kasTab.click();
  await expect(page.getByTestId('money.kas.drawers')).toBeVisible();
  await shoot(page, 'kas-main-drawer');

  await tap(page, 'money.kas.move');
  await tap(page, 'money.move.kind.transfer');
  await expect(page.getByTestId('money.move.targets')).toContainText('Laci aksesoris');
  await fill(page, 'money.move.amount', '50000');
  await fill(page, 'money.move.reason', 'Uang kembalian');
  await shoot(page, 'move-transfer');
  await tap(page, 'money.move.primary');

  await page.getByTestId('money.kas.drawers').getByText('Laci aksesoris').click();
  await expect(page.getByTestId('money.kas.expected')).toContainText('50.000');
  await shoot(page, 'kas-accessories-drawer');
});
