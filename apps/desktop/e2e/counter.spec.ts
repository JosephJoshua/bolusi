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

// The built app from the source tree, or an installed copy when BOLUSI_E2E_EXECUTABLE names its
// exe (the Windows CI job installs the fresh installer and runs these tests against it).
const INSTALLED = process.env['BOLUSI_E2E_EXECUTABLE'];
// Chromium's built-in test pattern stands in for a webcam; the app's own permission rules still
// decide whether the page may use it.
const FLAGS = ['--no-sandbox', '--use-fake-device-for-media-stream'];

async function launch(): Promise<void> {
  // No sandbox: CI runs as a user the Chromium sandbox helper refuses. The app's own window
  // settings are unchanged.
  app = await electron.launch(
    INSTALLED === undefined
      ? { args: [...FLAGS, `${import.meta.dirname}/..`] }
      : { executablePath: INSTALLED, args: FLAGS },
  );
  page = await app.firstWindow();
  await page.getByTestId('repair.desk.board').waitFor();
}

test.beforeEach(launch);

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
  [1536, 864],
  [1920, 1080],
  [2560, 1440],
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
      // Customer names show in full; only free text such as a complaint may be cut.
      const cutNames = await table.evaluate((grid) => {
        const headers = [...grid.querySelectorAll('[role="columnheader"]')];
        const column = headers.findIndex((header) => header.textContent?.trim() === 'Pelanggan');
        return [...grid.querySelectorAll('[role="row"]')]
          .slice(1)
          .map((row) => row.children[column]?.querySelector('.truncate'))
          .filter((name) => name != null && name.scrollWidth > name.clientWidth)
          .map((name) => name!.textContent);
      });
      expect(cutNames).toEqual([]);
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

test('the page gets only the narrow print and update calls, through the real preload', async () => {
  const shape = await page.evaluate(() => {
    const bridge = (window as { bolusi?: Record<string, Record<string, unknown>> }).bolusi;
    return {
      keys: bridge === undefined ? null : Object.keys(bridge).sort(),
      printers: bridge?.['printers'] === undefined ? null : Object.keys(bridge['printers']).sort(),
      node: typeof (window as { require?: unknown }).require,
      process: typeof (window as { process?: unknown }).process,
    };
  });
  expect(shape).toEqual({
    keys: ['printers', 'updates'],
    printers: ['choose', 'list', 'printPage', 'printRaw', 'setPaper', 'settings'],
    node: 'undefined',
    process: 'undefined',
  });

  // The printer list comes from the OS through the main process; with none chosen, no test page.
  await page.getByTestId('nav.settings').click();
  await expect(page.getByTestId('repair.desk.printing')).toBeVisible();
  await expect(
    page
      .getByTestId('repair.desk.printing.none')
      .or(page.getByTestId('repair.desk.printing.printers')),
  ).toBeVisible();
  await expect(page.getByTestId('repair.desk.printing.test')).toBeDisabled();
  await expect(page.getByTestId('desktop.version')).toHaveText(/^Versi aplikasi \d+\.\d+\.\d+$/);
});

test('the paper picked in Settings is kept by the main process across a restart', async () => {
  await page.getByTestId('nav.settings').click();
  const a5 = page.getByTestId('repair.desk.printing.paper.a5');
  await a5.click();
  await expect(a5).toHaveAttribute('data-state', 'on');
  await app.close();
  await launch();
  await page.getByTestId('nav.settings').click();
  await expect(page.getByTestId('repair.desk.printing.paper.a5')).toHaveAttribute(
    'data-state',
    'on',
  );
  // Back to the default for the next run on this machine.
  await page.getByTestId('repair.desk.printing.paper.continuous_half').click();
});

test('takes an intake photo with the webcam', async () => {
  await page.getByTestId('repair.desk.board.newIntake').click();
  await page.getByTestId('repair.desk.intake').waitFor();
  const tile = page.locator('[data-testid^="repair.desk.intake.photo."]').first();
  await tile.click();
  const camera = page.getByTestId('desktop.camera');
  await expect(camera.getByTestId('desktop.camera.shoot')).toBeEnabled();
  await camera.getByTestId('desktop.camera.shoot').click();
  await expect(camera.getByTestId('desktop.camera.shot')).toBeVisible();
  await camera.getByTestId('desktop.camera.use').click();
  await expect(camera).toBeHidden();
  // The tile now shows the photo just taken.
  await expect(tile.locator('img')).toHaveAttribute('src', /^blob:/);
});

test('takes the customer signature at handover, over the handover dialog', async () => {
  await page.getByTestId('repair.desk.board.views.pickup').click();
  await page.getByText('Ester Mandowen').click();
  await page.getByTestId('repair.desk.ticket.action.handover').click();
  await page.getByTestId('repair.desk.handover').waitFor();
  await page.getByTestId('repair.desk.handover.signature').click();
  const pad = page.getByTestId('desktop.signature.pad');
  await expect(page.getByTestId('desktop.signature.use')).toBeDisabled();
  const box = (await pad.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.6);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.3, { steps: 8 });
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.6, { steps: 8 });
  await page.mouse.up();
  await page.getByTestId('desktop.signature.use').click();
  await expect(page.getByTestId('desktop.signature')).toBeHidden();
  await expect(page.getByTestId('repair.desk.handover')).toBeVisible();
  await expect(page.getByTestId('repair.desk.handover.signature').locator('img')).toHaveAttribute(
    'src',
    /^blob:/,
  );
});
