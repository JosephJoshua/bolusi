/**
 * Supplier bills driven through the real phone screens in a browser, over the in-memory demo
 * (`packages/modules/src/purchasing/demo.tsx`): an owner reads the Tagihan list, opens a bill billed
 * ahead of its parts, records one for an order and one on its own with terms, voids one, and pays
 * what is left on an overdue one and cancels that payment. A screenshot per step into `artifacts/bills/`, each checked against the design guide.
 *
 * HONEST CEILING: a browser approximation of the phone. The number pad is device QA.
 */
import type { Page } from '@playwright/test';

import { expect, shoot as check, test } from './qa';
import { toServisan } from './shell.js';

const shoot = (page: Page, name: string) => check(page, 'bills', name);

const tap = (page: Page, testID: string) => page.getByTestId(testID).first().click();

async function openBills(page: Page): Promise<void> {
  await page.goto('/?screen=repair&state=owner');
  await toServisan(page);
  await tap(page, 'shell-tabs.items');
  await tap(page, 'items.sections.orders');
  await tap(page, 'purchasing.orders.filter.bills');
  await expect(billWith(page, /SJ.0912/)).toBeVisible();
}

/** One of the bill list's views: Belum lunas (the default), Jatuh tempo, Semua. */
const showBills = (page: Page, view: 'unpaid' | 'overdue' | 'all') =>
  tap(page, `purchasing.orders.billFilter.${view}`);

const billWith = (page: Page, text: string | RegExp) =>
  page.locator('[data-testid^="purchasing.orders.bill."]').filter({ hasText: text }).first();

test('the Tagihan list, and a bill billed ahead of its parts', async ({ page }) => {
  await openBills(page);
  // Belum lunas leaves out what is paid off or void.
  await expect(billWith(page, /INV\/MP\/2611.B/)).toHaveCount(0);
  await shoot(page, '01-list');
  await showBills(page, 'all');
  await expect(billWith(page, /INV\/MP\/2611.B/)).toContainText('Dibatalkan');
  await expect(billWith(page, 'Toko Abadi')).toContainText('Lunas');
  await shoot(page, '01b-list-all');
  await showBills(page, 'unpaid');

  await billWith(page, /SJ.0912/).click();
  await expect(page.getByTestId('purchasing.bill.check')).toBeVisible();
  await expect(page.getByText(/belum datang/).first()).toBeVisible();
  await shoot(page, '02-bill');
});

test('an owner records a bill on its own, with terms and ongkir', async ({ page }) => {
  await openBills(page);
  await tap(page, 'purchasing.orders.newBill');
  await expect(page.getByText('Pilih supplier terlebih dahulu.')).toBeVisible();
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
  await showBills(page, 'all');
  await billWith(page, 'Toko Abadi').click();
  await tap(page, 'purchasing.bill.voidBill');
  await expect(page.getByText('Tulis alasan terlebih dahulu.')).toBeVisible();
  await page.getByTestId('purchasing.voidBill.reason.field').first().fill('Salah supplier');
  await shoot(page, '07-void');
  await page.getByText('Batalkan tagihan', { exact: true }).last().click();

  await expect(page.getByTestId('purchasing.bill.notice')).toContainText('Tagihan dibatalkan.');
  await expect(page.getByTestId('purchasing.bill.voided')).toContainText('Salah supplier');
  await expect(page.getByTestId('purchasing.bill.edit')).toHaveCount(0);
  await shoot(page, '08-voided');
});

test('paying what is left on an overdue bill, then cancelling that payment', async ({ page }) => {
  await openBills(page);
  await showBills(page, 'overdue');
  const overdue = billWith(page, /INV\/MP\/2611(?!-)/);
  await expect(overdue).toContainText('Lewat jatuh tempo');
  await shoot(page, '09-overdue');
  await overdue.click();
  await expect(page.getByTestId('purchasing.bill.balance')).toContainText('540.000');
  await shoot(page, '10-bill-partly-paid');

  await tap(page, 'purchasing.bill.pay');
  const amount = page.getByTestId('purchasing.pay.amount.field').first();
  await expect(amount).toHaveValue('540.000');
  await amount.fill('600000');
  await expect(page.getByTestId('purchasing.pay.above')).toBeVisible();
  await page.getByTestId('purchasing.pay.source').getByText('BCA Toko').click();
  await expect(page.getByTestId('purchasing.pay.reference').first()).toBeVisible();
  await shoot(page, '11-pay-above-bank');
  await amount.fill('540000');
  await tap(page, 'purchasing.pay.source.cash');
  await expect(page.getByTestId('purchasing.pay.reference')).toHaveCount(0);
  await shoot(page, '12-pay-cash');
  await page.getByText('Bayar Rp\u00a0540.000', { exact: true }).last().click();

  await expect(page.getByTestId('purchasing.bill.notice')).toContainText('Pembayaran dicatat.');
  await expect(page.getByTestId('purchasing.bill.settled')).toBeVisible();
  await expect(page.getByTestId('purchasing.bill.pay')).toHaveCount(0);
  await shoot(page, '13-paid');

  await page
    .locator('[data-testid^="purchasing.bill.payment."][data-testid$=".void"]')
    .last()
    .click();
  await expect(page.getByText('Tulis alasan terlebih dahulu.')).toBeVisible();
  await page.getByTestId('purchasing.voidPayment.reason.field').first().fill('Salah tagihan');
  await shoot(page, '14-void-payment');
  await page.getByText('Batalkan pembayaran', { exact: true }).last().click();

  await expect(page.getByTestId('purchasing.bill.notice')).toContainText('Pembayaran dibatalkan.');
  await expect(page.getByText('Dibatalkan: Salah tagihan')).toBeVisible();
  await expect(page.getByTestId('purchasing.bill.pay').first()).toBeVisible();
  await shoot(page, '15-payment-voided');
});
