// The demo shell after a sign-in: whoever answers requests (owners, Manajer) opens on Perlu dicek,
// so a spec about the board goes to Servisan through the tabs, as the person would.
import { expect, type Page } from '@playwright/test';

export async function toServisan(page: Page): Promise<void> {
  await expect(
    page.getByTestId('repair.board').or(page.getByTestId('attention')).first(),
  ).toBeVisible();
  if (await page.getByTestId('attention').isVisible())
    await page.getByTestId('shell-tabs.repair').first().click();
  await expect(page.getByTestId('repair.board')).toBeVisible();
}
