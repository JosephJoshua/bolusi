/**
 * Supplier bills driven through the real phone screens in a browser, over the in-memory demo
 * (`packages/modules/src/purchasing/demo.tsx`): an owner reads the Tagihan list, opens a bill billed
 * ahead of its parts, records one for an order and one on its own with terms, and voids one. A
 * screenshot per step into `artifacts/bills/`, each checked against the design guide.
 *
 * HONEST CEILING: a browser approximation of the phone. The number pad is device QA.
 */
import type { Page } from '@playwright/test';

import { expect, shoot as check, test } from './qa';

const shoot = (page: Page, name: string) => check(page, 'bills', name);

const tap = (page: Page, testID: string) => page.getByTestId(testID).first().click();

async function openBills(page: Page): Promise<void> {
  await page.goto('/?screen=repair&state=owner');
  await expect(page.getByTestId('repair.board')).toBeVisible();
  await page.getByLabel('Menu akun').first().click();
  await tap(page, 'shell-open-purchasing');
  await tap(page, 'purchasing.orders.filter.bills');
  await expect(billWith(page, 'Toko Abadi')).toBeVisible();
}

const billWith = (page: Page, text: string) =>
  page.locator('[data-testid^="purchasing.orders.bill."]').filter({ hasText: text }).first();

test('the Tagihan list, and a bill billed ahead of its parts', async ({ page }) => {
  await openBills(page);
  await expect(billWith(page, 'INV/MP/2611-B')).toContainText('Dibatalkan');
  await shoot(page, '01-list');

  await billWith(page, 'SJ-0912').click();
  await expect(page.getByTestId('purchasing.bill.check')).toBeVisible();
  await expect(page.getByText(/belum datang/).first()).toBeVisible();
  await shoot(page, '02-bill');
});

test('an owner records a bill on its own, with terms and ongkir', async ({ page }) => {
  await openBills(page);
  await tap(page, 'purchasing.orders.newBill');
  await expect(page.getByText('Pilih supplier dulu.')).toBeVisible();
  await tap(page, 'purchasing.billForm.supplier.sup-3');
  await tap(page, 'purchasing.billForm.addPart');
  await page.locator('[data-testid^="purchasing.pick.choice."]').first().click();
  await expect(page.getByText('Isi harga setiap barang.')).toBeVisible();
  await page.locator('[data-testid$=".price.field"]').first().fill('85000');
  await page.getByTestId('purchasing.billForm.supplierRef.field').first().fill('AB-77');
  await tap(page, 'purchasing.billForm.term.14');
  await expect(page.getByTestId('purchasing.billForm.due')).toContainText('Jatuh tempo');
  await page.getByTestId('purchasing.billForm.charges.field').first().fill('10000');
  await expect(page.getByTestId('purchasing.billForm.total')).toContainText('95.000');
  await shoot(page, '03-form');
  await page.getByText('Simpan tagihan', { exact: true }).last().click();

  await expect(page.getByTestId('purchasing.bill.notice')).toContainText('Tagihan dicatat.');
  await expect(page.getByTestId('purchasing.bill.total')).toContainText('95.000');
  await shoot(page, '04-recorded');
});

test('a bill for an order starts from its parts', async ({ page }) => {
  await openBills(page);
  await tap(page, 'purchasing.orders.filter.open');
  await page
    .locator('[data-testid^="purchasing.orders.row."]')
    .filter({ hasText: 'Dipesan' })
    .first()
    .click();
  await expect(page.getByTestId('purchasing.order.bills')).toBeVisible();
  await shoot(page, '05-order');
  await tap(page, 'purchasing.order.bills.new');
  await expect(page.getByTestId('purchasing.billForm.fromOrder')).toBeVisible();
  await expect(
    page.locator('[data-testid^="purchasing.billForm.line."][data-testid$=".price"]'),
  ).not.toHaveCount(0);
  await shoot(page, '06-order-form');
});

test('voiding a bill asks why, and keeps it in the history', async ({ page }) => {
  await openBills(page);
  await billWith(page, 'Toko Abadi').click();
  await tap(page, 'purchasing.bill.voidBill');
  await expect(page.getByText('Tulis alasannya dulu.')).toBeVisible();
  await page.getByTestId('purchasing.voidBill.reason.field').first().fill('Salah supplier');
  await shoot(page, '07-void');
  await page.getByText('Batalkan tagihan', { exact: true }).last().click();

  await expect(page.getByTestId('purchasing.bill.notice')).toContainText('Tagihan dibatalkan.');
  await expect(page.getByTestId('purchasing.bill.voided')).toContainText('Salah supplier');
  await expect(page.getByTestId('purchasing.bill.edit')).toHaveCount(0);
  await shoot(page, '08-voided');
});
