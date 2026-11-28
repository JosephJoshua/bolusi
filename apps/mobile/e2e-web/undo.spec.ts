/**
 * Batalkan driven through the real phone screens over the demo: a technician marks a servisan
 * waiting for parts by mistake and takes it back from the toast. A screenshot per step into
 * `artifacts/undo/`, each checked against the design guide.
 *
 * HONEST CEILING: a browser approximation of the phone; the server's checks are unit tested.
 */
import type { Page } from '@playwright/test';

import { expect, shoot as check, test } from './qa';
import { toServisan } from './shell.js';

const shoot = (page: Page, name: string) => check(page, 'undo', name);
const tap = (page: Page, testID: string) => page.getByTestId(testID).first().click();

test('a wrong Tunggu sparepart is taken back from the Batalkan toast', async ({ page }) => {
  await page.goto('/?screen=repair&state=technician');
  await toServisan(page);
  await tap(page, 'repair.board.row.t-2');
  await tap(page, 'repair.ticket.action.waitForParts');
  await page.getByTestId('repair.note.waitForParts.text.field').fill('Baterai');
  await tap(page, 'repair.note.waitForParts.primary');

  const toast = page.getByTestId('undo.toast');
  await expect(toast).toContainText('Ditandai tunggu sparepart.');
  await expect(page.getByTestId('repair.ticket.action.resume').first()).toBeVisible();
  await shoot(page, 'offered');

  await tap(page, 'undo.toast.action');
  await expect(toast).toHaveCount(0);
  await expect(page.getByTestId('repair.ticket.action.waitForParts').first()).toBeVisible();
  await shoot(page, 'taken-back');
});
