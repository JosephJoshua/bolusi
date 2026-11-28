// The repair price list on the phone: the counter looks a price up from the Harga section, the
// business owner adds rows one after another, and a store owner prices this store apart.
import type { Page } from '@playwright/test';

import { expect, shoot as check, test } from './qa';

type Role = 'owner' | 'counter' | 'storeOwner';

async function openPrices(page: Page, role: Role, tablet = false): Promise<void> {
  await page.goto(`/?screen=repair&state=${role}${tablet ? '&frame=tablet' : ''}`);
  await expect(page.getByTestId('repair.board')).toBeVisible();
  await tap(page, 'repair.sections.prices');
  await expect(page.getByTestId('repair.prices.items')).toBeVisible();
}

const tap = (page: Page, testID: string) => page.getByTestId(testID).first().click();
const fill = (page: Page, testID: string, text: string) =>
  page.getByTestId(`${testID}.field`).first().fill(text);
const shoot = (page: Page, name: string) => check(page, 'prices', name);

test('the counter finds a price by a phone typed loosely, and narrows to one repair', async ({
  page,
}) => {
  await openPrices(page, 'counter');
  await shoot(page, 'list-counter');
  await fill(page, 'repair.prices.search', 'redmi not 10');
  const first = page.locator('[data-testid^="repair.prices.row."]').first();
  await expect(first).toContainText('Redmi Note 10');
  await shoot(page, 'list-search');
  // The counter only reads the list: its rows are not buttons.
  await expect(page.getByRole('button', { name: /Redmi Note 10/ })).toHaveCount(0);

  await fill(page, 'repair.prices.search', '');
  await tap(page, 'repair.prices.type.battery');
  const rows = page.locator(
    '[data-testid^="repair.prices.row."]:not([data-testid$=".amount"]):not([data-testid$=".storePrice"])',
  );
  await expect(rows.first()).toContainText('Ganti baterai');
  for (const row of await rows.all()) await expect(row).toContainText('Ganti baterai');
  await shoot(page, 'list-battery');
});

test('the owner adds a price, then the next one for the same phones', async ({ page }) => {
  await openPrices(page, 'owner');
  await tap(page, 'repair.prices.add');
  await expect(page.getByTestId('repair.priceForm')).toBeVisible();
  await tap(page, 'repair.priceForm.type.screen');
  await fill(page, 'repair.priceForm.models.search', 'Galaxy A15');
  await tap(page, 'repair.priceForm.models.typed');
  await fill(page, 'repair.priceForm.quality', 'Ori');
  await fill(page, 'repair.priceForm.amount', '560000');
  await shoot(page, 'form-new');

  await tap(page, 'repair.priceForm.another');
  // The type and phones stay for the next quality; the price is empty again.
  await expect(page.getByTestId('repair.priceForm.models.picked.0')).toContainText('Galaxy A15');
  await expect(page.getByTestId('repair.priceForm.amount.field')).toHaveValue('');
  await fill(page, 'repair.priceForm.quality', 'KW');
  await fill(page, 'repair.priceForm.amount', '320000');
  await shoot(page, 'form-another');
  await tap(page, 'repair.priceForm.primary');

  await expect(page.getByTestId('repair.prices.notice')).toBeVisible();
  await fill(page, 'repair.prices.search', 'a15');
  await expect(page.locator('[data-testid^="repair.prices.row."]').first()).toContainText(
    'Galaxy A15',
  );
  await shoot(page, 'list-added');
});

test('a phone already priced for the repair and quality is named before saving', async ({
  page,
}) => {
  await openPrices(page, 'owner');
  await tap(page, 'repair.prices.add');
  await tap(page, 'repair.priceForm.type.screen');
  await fill(page, 'repair.priceForm.models.search', 'Redmi Note 10');
  await tap(page, 'repair.priceForm.models.typed');
  await fill(page, 'repair.priceForm.quality', 'Ori');
  await fill(page, 'repair.priceForm.amount', '600000');
  await expect(page.getByTestId('repair.priceForm.modelsProblem')).toContainText('Redmi Note 10');
  await shoot(page, 'form-repeated');
});

test('a store owner prices this store apart from the list', async ({ page }) => {
  await openPrices(page, 'storeOwner');
  await expect(page.getByTestId('repair.prices.add')).toHaveCount(0);
  await fill(page, 'repair.prices.search', 'redmi 9a');
  const found = page.locator('[data-testid^="repair.prices.row."]').first();
  await expect(found).toContainText('Redmi 9A');
  await found.click();
  await expect(page.getByTestId('repair.priceForm')).toContainText('Redmi 9A');
  await expect(page.getByTestId('repair.priceForm')).toBeVisible();
  await tap(page, 'repair.priceForm.storeOwn');
  await fill(page, 'repair.priceForm.storeAmount', '275000');
  await shoot(page, 'form-store');
  await tap(page, 'repair.priceForm.primary');
  await expect(page.getByTestId('repair.prices.notice')).toBeVisible();
  await expect(
    page.locator('[data-testid^="repair.prices.row."][data-testid$=".storePrice"]').first(),
  ).toBeVisible();
  await shoot(page, 'list-store');
});

test('on a tablet the price list has room for every phone', async ({ page }) => {
  await openPrices(page, 'owner', true);
  await shoot(page, 'list-tablet');
});
