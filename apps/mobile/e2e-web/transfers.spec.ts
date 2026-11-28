/**
 * Kiriman driven through the real phone screens in a browser, over the in-memory demo
 * (`packages/modules/src/inventory/transfers/demo.ts`): an owner receives parts sent here, sends
 * parts to another store, and settles one that came short and one that came over. A screenshot per
 * step, at phone, tablet and PC widths and at both font sizes, each checked against the design guide.
 *
 * HONEST CEILING: a browser approximation. The hardware back and a real device font are device QA.
 */
import type { Page } from '@playwright/test';

import { expect, shoot as check, test } from './qa';
import { toServisan } from './shell.js';

const SIZES = {
  phone: { width: 360, height: 640 },
  tablet: { width: 800, height: 1280 },
  landscape: { width: 960, height: 600 },
  pc: { width: 1280, height: 800 },
} as const;

const shoot = (page: Page, name: string) => check(page, 'transfers', name);

const tap = (page: Page, testID: string) => page.getByTestId(testID).first().click();

async function openTransfers(page: Page): Promise<void> {
  await page.goto('/?screen=repair&state=owner');
  await toServisan(page);
  await tap(page, 'shell-tabs.items');
  await tap(page, 'items.sections.transfers');
  await expect(page.getByTestId('inventory.transfers')).toBeVisible();
}

/** The transfer row whose text holds `text`. */
const rowWith = (page: Page, text: string) =>
  page.locator('[data-testid^="inventory.transfers.row."]').filter({ hasText: text }).first();

for (const [size, viewport] of Object.entries(SIZES)) {
  test(`the open transfers read at a glance (${size})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openTransfers(page);
    await expect(rowWith(page, 'Dalam perjalanan')).toBeVisible();
    await expect(rowWith(page, 'Sebagian sampai')).toBeVisible();
    await expect(rowWith(page, 'Perlu diperiksa')).toBeVisible();
    await shoot(page, `${size}-01-list`);
    await rowWith(page, 'Sebagian sampai').click();
    await expect(page.getByTestId('inventory.transfer.stage')).toContainText('Sebagian sampai');
    await shoot(page, `${size}-02-detail`);
  });
}

test('parts sent here are received into stock', async ({ page }) => {
  await openTransfers(page);
  await rowWith(page, 'Dalam perjalanan').click();
  await tap(page, 'inventory.transfer.receive');
  await expect(page.getByTestId('inventory.receiveTransfer')).toBeVisible();
  await shoot(page, 'phone-03-receive');
  await page.getByText('Masukkan ke stok', { exact: true }).last().click();
  await expect(page.getByTestId('inventory.transfer.notice')).toContainText(
    'Barang masuk ke stok.',
  );
  await expect(page.getByTestId('inventory.transfer.stage')).toContainText('Selesai');
  await shoot(page, 'phone-04-received');
});

test('an owner sends parts to another store', async ({ page }) => {
  await openTransfers(page);
  await tap(page, 'inventory.transfers.new');
  await expect(page.getByText('Pilih toko tujuan dan sparepart terlebih dahulu.')).toBeVisible();
  await tap(page, 'inventory.send.store.store-jayapura');
  await tap(page, 'inventory.send.addPart');
  await page.locator('[data-testid^="inventory.send.pick.choice."]').first().click();
  await expect(page.locator('[data-testid^="inventory.send.line."]').first()).toBeVisible();
  await shoot(page, 'phone-05-send');
  await page.getByText('Kirim', { exact: true }).last().click();
  await expect(page.getByTestId('inventory.transfer.notice')).toContainText('Sparepart dikirim.');
  await expect(page.getByTestId('inventory.transfer.stage')).toContainText('Dalam perjalanan');
  await expect(page.getByTestId('inventory.transfer.cancel')).toBeVisible();
  await shoot(page, 'phone-06-sent');
});

test('what never arrived is settled, and a write-off asks for its reason', async ({ page }) => {
  await openTransfers(page);
  await rowWith(page, 'Sebagian sampai').click();
  await tap(page, 'inventory.transfer.settle');
  await expect(page.getByTestId('inventory.settle')).toBeVisible();
  await expect(page.getByText('Belum sampai 1')).toBeVisible();
  // Writing it off instead of taking it back asks why.
  const line = page.locator('[data-testid^="inventory.settle.line."]').first();
  await line.locator('[data-testid$=".back"] [aria-label="Kurangi"]').first().click();
  await line.locator('[data-testid$=".lost"] [aria-label="Tambah"]').first().click();
  await expect(page.getByTestId('inventory.settle.reason')).toBeVisible();
  await expect(page.getByText('Tulis alasan terlebih dahulu.')).toBeVisible();
  await shoot(page, 'phone-07-settle-lost');
  await page
    .getByTestId('inventory.settle.reason')
    .locator('textarea, input')
    .first()
    .fill('Jatuh di jalan.');
  await page.getByText('Simpan', { exact: true }).last().click();
  await expect(page.getByTestId('inventory.transfer.notice')).toContainText(
    'Kiriman diselesaikan.',
  );
  await expect(page.getByTestId('inventory.transfer.stage')).toContainText('Selesai');
  await shoot(page, 'phone-08-settled');
});

test('an excess counted in at the other store is settled as arrived', async ({ page }) => {
  await openTransfers(page);
  await rowWith(page, 'Perlu diperiksa').click();
  await expect(page.getByTestId('inventory.transfer.overHint')).toBeVisible();
  await tap(page, 'inventory.transfer.settle');
  await expect(page.getByText('Lebih 1')).toBeVisible();
  await shoot(page, 'phone-09-settle-over');
  await page.getByText('Simpan', { exact: true }).last().click();
  await expect(page.getByTestId('inventory.transfer.stage')).toContainText('Selesai');
});
