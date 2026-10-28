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
      // Only the table and the pane scroll; the window never does, so paging stays in reach.
      expect(
        await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight),
      ).toBe(true);
      await expect(page.getByTestId('repair.desk.board.pagination')).toBeInViewport({ ratio: 1 });
    };
    await fits();
    await page.getByText('Maria Kogoya').click();
    await expect(page.getByTestId('repair.desk.ticket.customer')).toBeVisible();
    await fits();
  });
}

for (const [width, height, sidebar] of [
  [1024, 640, 'expanded'],
  [1024, 640, 'collapsed'],
  [1366, 768, 'expanded'],
  [2560, 1440, 'expanded'],
] as const) {
  test(`the intake fits a ${String(width)}×${String(height)} screen with the sidebar ${sidebar}`, async () => {
    await page.setViewportSize({ width, height });
    await page.evaluate((state) => localStorage.setItem('bolusi.sidebar', state), sidebar);
    await page.reload();
    await page.getByTestId('repair.desk.board').waitFor();
    await expect(page.getByTestId('desktop.shell')).toHaveAttribute('data-sidebar', sidebar);
    await page.keyboard.press('F2');
    await expect(page.getByTestId('repair.desk.intake')).toBeVisible();
    // Nothing sticks out sideways or spills out of its box, such as the save button's label.
    const spilled = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="repair.desk.intake"] *')]
        .filter((el) => {
          const box = el.getBoundingClientRect();
          return box.width > 0 && (box.right > window.innerWidth + 1 || box.left < -1);
        })
        .map((el) => el.outerHTML.slice(0, 80)),
    );
    expect(spilled).toEqual([]);
    const save = page.getByTestId('repair.desk.intake.save');
    expect(
      await save.evaluate((button) =>
        [button, ...button.querySelectorAll('*')].every(
          (el) => el.scrollWidth <= el.clientWidth + 1,
        ),
      ),
    ).toBe(true);
  });
}

test('a phone nobody collected shows in its own list, and the message opens WhatsApp outside the app', async () => {
  // Stands in for the OS: records what the app asked to open instead of starting a browser.
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as { opened?: string[] }).opened = opened;
    shell.openExternal = (url: string) => {
      opened.push(url);
      return Promise.resolve();
    };
  });
  await page.getByTestId('repair.desk.board.views.uncollected').click();
  await page.getByText('Markus Yikwa').click();
  await expect(page.getByTestId('repair.desk.ticket.customer')).toHaveText('Markus Yikwa');
  await page.getByTestId('repair.desk.ticket.action.message').click();
  await expect
    .poll(() => app.evaluate(() => (globalThis as { opened?: string[] }).opened ?? []))
    .toEqual([expect.stringMatching(/^https:\/\/wa\.me\/6281344556677\?text=/)]);
  // The app itself stays on its one page.
  expect(app.windows()).toHaveLength(1);
});
