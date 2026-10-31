/**
 * Belanja driven through the real phone screens in a browser, over the in-memory demo
 * (`packages/modules/src/purchasing/demo.ts`): an owner orders parts from a supplier and receives
 * them, and a technician is not offered it. A screenshot per flow into `artifacts/purchasing/`.
 *
 * HONEST CEILING: a browser approximation. WhatsApp, the share sheet and the camera scan are device QA.
 */
import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

const ARTIFACTS = path.join(__dirname, 'artifacts', 'purchasing');

async function shoot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join(ARTIFACTS, `${name}.png`), animations: 'disabled' });
}

const tap = (page: Page, testID: string) => page.getByTestId(testID).first().click();

async function openBuying(page: Page, role: 'owner' | 'technician'): Promise<void> {
  await page.goto(`/?screen=repair&state=${role}`);
  await expect(page.getByTestId('repair.board')).toBeVisible();
  await page.getByLabel('Menu akun').first().click();
}

/** The order row whose text holds `text`. */
const rowWith = (page: Page, text: string) =>
  page.locator('[data-testid^="purchasing.orders.row."]').filter({ hasText: text }).first();

test('an owner orders a part from a supplier and places it', async ({ page }) => {
  await openBuying(page, 'owner');
  await tap(page, 'shell-open-purchasing');
  await expect(rowWith(page, 'Diterima sebagian')).toBeVisible();

  await tap(page, 'purchasing.orders.new');
  // Nothing to save until there is a supplier and a part.
  await expect(page.getByText('Pilih supplier dan barangnya dulu.')).toBeVisible();
  await page.getByTestId('purchasing.form.supplier.sup-2').first().click();
  await tap(page, 'purchasing.form.addPart');
  await page.locator('[data-testid^="purchasing.pick.choice."]').first().click();
  await expect(page.locator('[data-testid^="purchasing.form.line."]').first()).toBeVisible();
  await shoot(page, '01-form');
  await page.getByText('Pesan', { exact: true }).last().click();

  await expect(page.getByTestId('purchasing.order.notice')).toContainText('Pesanan dipesan.');
  await expect(page.getByTestId('purchasing.order.stage')).toContainText('Dipesan');
  await expect(page.getByTestId('purchasing.order.send')).toBeVisible();
  await shoot(page, '02-placed');
});

test('receiving what came moves the order on and says the stock grew', async ({ page }) => {
  await openBuying(page, 'owner');
  await tap(page, 'shell-open-purchasing');
  await rowWith(page, 'Diterima sebagian').click();
  await tap(page, 'purchasing.order.receive');
  // It starts at what is still to come, so a full delivery is one tap.
  await expect(page.getByText('Dipesan 4, sudah datang 1')).toBeVisible();
  await shoot(page, '03-receive');
  await page.getByText('Simpan', { exact: true }).last().click();

  await expect(page.getByTestId('purchasing.order.notice')).toContainText('Stok sudah bertambah.');
  await expect(page.getByTestId('purchasing.order.stage')).toContainText('Diterima');
  await expect(page.getByTestId('purchasing.order.receive')).toHaveCount(0);
  await shoot(page, '04-received');
});

test('a technician is not offered Belanja', async ({ page }) => {
  await openBuying(page, 'technician');
  await expect(page.getByTestId('shell-open-settings')).toBeVisible();
  await expect(page.getByTestId('shell-open-purchasing')).toHaveCount(0);
});
