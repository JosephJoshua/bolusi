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

import { toServisan } from './shell.js';

const ARTIFACTS = path.join(__dirname, 'artifacts', 'categories');

async function shoot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join(ARTIFACTS, `${name}.png`), animations: 'disabled' });
}

const tap = (page: Page, testID: string) => page.getByTestId(testID).first().click();

async function openCategories(page: Page): Promise<void> {
  await page.goto('/?screen=repair&state=owner');
  await toServisan(page);
  await tap(page, 'shell-tabs.items');
  // Category setup is with the filters, not in the chip row.
  await tap(page, 'inventory.list.filter');
  await tap(page, 'inventory.filterStep.categories');
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
  await expect(
    page
      .getByText(/^Kategori disimpan\./)
      .filter({ visible: true })
      .first(),
  ).toBeVisible();
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
  // Saved from the top of the form, the format below the fold is brought clear of the bottom action.
  await page.getByTestId('inventory.categoryForm.name.field').first().focus();
  await page.getByTestId('inventory.categoryForm.name.field').first().blur();
  await page.mouse.wheel(0, -5000);
  await tap(page, 'inventory.categoryForm.primary');
  await expect(
    page.getByText('Format menyebut kolom yang tidak ada: Warna.').first(),
  ).toBeVisible();
  await expect(async () => {
    const field = await page.getByTestId('inventory.categoryForm.format').first().boundingBox();
    const action = await page.getByTestId('inventory.categoryForm.primary').first().boundingBox();
    expect(field!.y + field!.height).toBeLessThanOrEqual(action!.y);
  }).toPass();
  await shoot(page, 'format-problem');
  await page.getByTestId('inventory.categoryForm.format.field').first().fill('Speaker {Posisi}');
  await tap(page, 'inventory.categoryForm.primary');
  await expect(
    page.getByText('Kategori disimpan.').filter({ visible: true }).first(),
  ).toBeVisible();
  await expect(page.getByText('Speaker').first()).toBeVisible();
});

test('archiving and restoring a category say so', async ({ page }) => {
  await openCategories(page);
  await tap(page, 'inventory.categories.row.cat-bat');
  await tap(page, 'inventory.categoryForm.archive');
  await tap(page, 'inventory.categoryForm.archiveSheet.confirm');
  await expect(
    page.getByText('Kategori diarsipkan.').filter({ visible: true }).first(),
  ).toBeVisible();
  await tap(page, 'inventory.categories.row.cat-bat');
  await tap(page, 'inventory.categoryForm.restore');
  await expect(
    page.getByText('Kategori aktif kembali.').filter({ visible: true }).first(),
  ).toBeVisible();
});
