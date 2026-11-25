/**
 * The business owner's categories on the phone, in a browser over the in-memory demo: renaming a
 * field carries its place in the name format, a format naming a field the category lacks is
 * refused, and a new category is saved with its choices. A screenshot per step into
 * `artifacts/categories/`. The PC lays out the same rules (`useCategoryForm`).
 *
 * HONEST CEILING: a browser approximation. The keyboard and drag to reorder are device QA.
 */
import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

const ARTIFACTS = path.join(__dirname, 'artifacts', 'categories');

async function shoot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join(ARTIFACTS, `${name}.png`), animations: 'disabled' });
}

const tap = (page: Page, testID: string) => page.getByTestId(testID).first().click();

async function openCategories(page: Page): Promise<void> {
  await page.goto('/?screen=repair&state=owner');
  await expect(page.getByTestId('repair.board')).toBeVisible();
  await tap(page, 'shell-tabs.items');
  await tap(page, 'inventory.list.categories');
  await expect(page.getByTestId('inventory.categories.row.cat-lcd').first()).toBeVisible();
}

test('renaming a field carries its place in the name format', async ({ page }) => {
  await openCategories(page);
  await shoot(page, 'list');
  await tap(page, 'inventory.categories.row.cat-bat');
  await tap(page, 'inventory.categoryForm.field.q');
  await page.getByTestId('inventory.categoryForm.field.q.label.field').first().fill('Grade');
  await expect(page.getByTestId('inventory.categoryForm.format.field').first()).toHaveValue(
    'Baterai {HP} {Grade}',
  );
  await shoot(page, 'edit-field');
  await tap(page, 'inventory.categoryForm.primary');
  await expect(page.getByText(/^Kategori disimpan\./).first()).toBeVisible();
});

test('a new category needs a format that names only its fields', async ({ page }) => {
  await openCategories(page);
  await tap(page, 'inventory.categories.primary');
  await page.getByTestId('inventory.categoryForm.name.field').first().fill('Speaker');
  await tap(page, 'inventory.categoryForm.addField');
  await page.getByPlaceholder('Contoh: Kualitas').first().fill('Posisi');
  await page.getByLabel('Pilihan baru').first().fill('Atas');
  await page.getByLabel('Pilihan baru').first().press('Enter');
  await expect(page.getByTestId('inventory.categoryForm.example').first()).toContainText(
    'Speaker Atas',
  );
  await page
    .getByTestId('inventory.categoryForm.format.field')
    .first()
    .fill('Speaker {Posisi} {Warna}');
  await tap(page, 'inventory.categoryForm.primary');
  await expect(
    page.getByText('Format menyebut isian yang tidak ada: Warna.').first(),
  ).toBeVisible();
  await shoot(page, 'format-problem');
  await page.getByTestId('inventory.categoryForm.format.field').first().fill('Speaker {Posisi}');
  await tap(page, 'inventory.categoryForm.primary');
  await expect(page.getByText('Kategori disimpan.').first()).toBeVisible();
  await expect(page.getByText('Speaker').first()).toBeVisible();
});
