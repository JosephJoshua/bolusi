// The counter screens in the real Electron window: the parts jsdom cannot judge, namely keyboard
// handling across dialogs and how the board fits common counter PC screens.
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

let app: ElectronApplication;
let page: Page;

test.beforeEach(async () => {
  // No sandbox: CI runs as a user the Chromium sandbox helper refuses. The app's own window
  // settings are unchanged.
  app = await electron.launch({ args: ['--no-sandbox', `${import.meta.dirname}/..`] });
  page = await app.firstWindow();
  await page.getByTestId('repair.desk.board').waitFor();
});

test.afterEach(async () => {
  await app.close();
});

test('Escape closes the dialog and keeps the servisan open; a second Escape closes it', async () => {
  await page.getByText('Maria Kogoya').click();
  await page.getByTestId('repair.desk.ticket.action.decidePrice').click();
  await expect(page.getByTestId('repair.desk.proposal')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('repair.desk.proposal')).toBeHidden();
  await expect(page.getByTestId('repair.desk.ticket.customer')).toHaveText('Maria Kogoya');

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('repair.desk.ticket.customer')).toBeHidden();
});

test('F2 does not start an intake while a dialog is open', async () => {
  await page.getByText('Maria Kogoya').click();
  await page.getByTestId('repair.desk.ticket.action.decidePrice').click();
  await page.keyboard.press('F2');
  await expect(page.getByTestId('repair.desk.intake')).toBeHidden();
});

for (const [width, height] of [
  [1024, 640],
  [1280, 720],
  [1366, 768],
  [1920, 1080],
] as const) {
  test(`the board fits a ${String(width)}×${String(height)} screen, with and without a servisan open`, async () => {
    await page.setViewportSize({ width, height });
    const fits = async (): Promise<void> => {
      const table = page.getByTestId('repair.desk.board.table');
      const overflow = await table.evaluate((grid) =>
        [...grid.querySelectorAll('[role="row"]')].some(
          (row) => row.scrollWidth > row.clientWidth + 1,
        ),
      );
      expect(overflow).toBe(false);
      await expect(page.getByRole('columnheader', { name: 'Total' })).toBeInViewport({ ratio: 1 });
    };
    await fits();
    await page.getByText('Maria Kogoya').click();
    await expect(page.getByTestId('repair.desk.ticket.customer')).toBeVisible();
    await fits();
  });
}
