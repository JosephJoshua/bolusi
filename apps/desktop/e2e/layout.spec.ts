// Every main PC screen at the sizes counters use, checked against the design guide's layout rules
// (packages/test-support/src/layout-audit.ts): nothing cut off, overlapping or off the type scale,
// one filled primary in view. Screenshots go to e2e/artifacts/layout/.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

// A fresh profile for this file, so a setting saved by an earlier run (the sidebar left expanded)
// never changes the layout these tests measure. Restarts within the file keep it.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'bolusi-e2e-'));

import { expectCleanLayout } from '@bolusi/test-support/layout-audit';
import { desktopType, themeVariables } from '@bolusi/ui-web/theme';

const ARTIFACTS = path.join(import.meta.dirname, 'artifacts', 'layout');
const LADDER = Object.values(desktopType).map((style) => style.size);
const INSTALLED = process.env['BOLUSI_E2E_EXECUTABLE'];

let app: ElectronApplication;
let page: Page;

test.afterEach(async () => {
  await app
    .evaluate(({ app: electronApp }) => setImmediate(() => electronApp.exit(0)))
    .catch(() => undefined);
  await app.close().catch(() => undefined);
});

async function check(name: string): Promise<void> {
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(ARTIFACTS, `${name}.png`) });
  await expectCleanLayout(
    page,
    {
      ladder: LADDER,
      fontScale: 1,
      minTarget: 24,
      primaryFill: themeVariables()['--b-primary'] ?? '',
    },
    name,
  );
}

for (const [width, height] of [
  [1024, 520],
  [1366, 768],
  [1920, 1080],
] as const) {
  test(`the main screens keep the layout rules at ${String(width)}×${String(height)}`, async () => {
    const env = { ...process.env, BOLUSI_DESKTOP_DEMO: '1', BOLUSI_DESKTOP_DATA_DIR: DATA_DIR };
    const args = ['--no-sandbox'];
    app = await electron.launch(
      INSTALLED === undefined
        ? { args: [...args, `${import.meta.dirname}/..`], env }
        : { executablePath: INSTALLED, args, env },
    );
    page = await app.firstWindow();
    page.on('dialog', (dialog) => void dialog.dismiss().catch(() => undefined));
    await page.setViewportSize({ width, height });
    await page.getByTestId('repair.desk.board').waitFor();
    // The installed app ignores BOLUSI_DESKTOP_DATA_DIR: wipe its page settings (the sidebar) too.
    await page.evaluate(() => window.localStorage.clear());
    await page.reload();
    await page.getByTestId('repair.desk.board').waitFor();
    const size = `${String(width)}x${String(height)}`;

    await check(`board-${size}`);
    await page.getByText('Maria Kogoya').click();
    await expect(page.getByTestId('repair.desk.ticket.customer')).toBeVisible();
    await check(`ticket-${size}`);
    await page.keyboard.press('Escape');

    await page.keyboard.press('F2');
    await expect(page.getByTestId('repair.desk.intake')).toBeVisible();
    await check(`intake-${size}`);
    await page.keyboard.press('Escape');

    for (const place of ['Kas', 'Barang', 'Pengaturan']) {
      await page
        .getByRole('navigation')
        .getByRole('button', { name: place, exact: true })
        .first()
        .click();
      await check(`${place.toLowerCase()}-${size}`);
    }

    // The owner's pages under Barang: Belanja and Kiriman, each with its first row open.
    await page.getByTestId('desktop.person').click();
    await page.getByRole('menuitem', { name: 'Andi Pratama' }).click();
    await page.getByTestId('repair.desk.board').waitFor();
    for (const [place, row] of [
      ['Belanja', 'purchasing.desk.table'],
      ['Kiriman', 'inventory.desk.transfers.table'],
    ] as const) {
      await page
        .getByRole('navigation')
        .getByRole('button', { name: place, exact: true })
        .first()
        .click();
      await page.getByTestId(row).getByRole('row').nth(1).click();
      await check(`${place.toLowerCase()}-${size}`);
    }
  });
}
