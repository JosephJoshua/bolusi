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
const TILES = '[data-testid^="repair.desk.intake.photo."]:not([data-testid$=".all"])';

async function launch(flags: readonly string[] = FLAGS): Promise<void> {
  // No sandbox: CI runs as a user the Chromium sandbox helper refuses. The app's own window
  // settings are unchanged.
  // These screens run over the seeded demo; the live app has its own tests.
  const env = { ...process.env, BOLUSI_DESKTOP_DEMO: '1' };
  app = await electron.launch(
    INSTALLED === undefined
      ? { args: [...flags, `${import.meta.dirname}/..`], env }
      : { executablePath: INSTALLED, args: [...flags], env },
  );
  page = await app.firstWindow();
  // Electron shows no dialog for an unload the page holds back (the close guard); Playwright still
  // reports one, and answering it itself fails. Taking it over leaves the page's question alone.
  page.on('dialog', (dialog) => void dialog.dismiss().catch(() => undefined));
  await page.getByTestId('repair.desk.board').waitFor();
}

test.beforeEach(() => launch());

test.afterEach(async () => {
  // Quits outright: a test may end with a dialog open, which the close guard would ask about.
  // A test that closed the window itself has already quit the app.
  await app
    .evaluate(({ app: electronApp }) => setImmediate(() => electronApp.exit(0)))
    .catch(() => undefined);
  await app.close().catch(() => undefined);
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
  [1024, 600],
  [1024, 640],
  [1280, 720],
  [1366, 768],
  [1536, 864],
  [1920, 1080],
  [2560, 1440],
] as const) {
  test(`the board fits a ${String(width)}×${String(height)} screen, with and without a servisan open`, async () => {
    await page.setViewportSize({ width, height });
    const fits = async (paneOpen: boolean): Promise<void> => {
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
      // Every queue is in sight: the tabs wrap rather than scroll sideways.
      const views = page.getByTestId('repair.desk.board.views');
      expect(await views.evaluate((tabs) => tabs.scrollWidth <= tabs.clientWidth + 1)).toBe(true);
      await expect(page.getByTestId('repair.desk.board.views.active')).toBeInViewport({ ratio: 1 });
      // Every filter shows whole: none runs under the toolbar's faded edge.
      const filters = page.getByTestId('repair.desk.board.filters').locator('> div').first();
      expect(await filters.evaluate((row) => row.scrollWidth <= row.clientWidth + 1)).toBe(true);
      if (paneOpen) {
        // The servisan sits beside the table, never over part of it (its pane shows the total).
        const tableBox = (await table.boundingBox())!;
        const paneBox = (await page.getByTestId('repair.desk.ticket').boundingBox())!;
        expect(paneBox.x).toBeGreaterThanOrEqual(tableBox.x + tableBox.width - 1);
      } else {
        await expect(page.getByRole('columnheader', { name: 'Total' })).toBeInViewport({
          ratio: 1,
        });
      }
      // Only the table and the pane scroll; the window never does, so paging stays in reach.
      expect(
        await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight),
      ).toBe(true);
      await expect(page.getByTestId('repair.desk.board.pagination')).toBeInViewport({ ratio: 1 });
    };
    await fits(false);
    await page.getByText('Maria Kogoya').click();
    await expect(page.getByTestId('repair.desk.ticket.customer')).toBeVisible();
    await fits(true);
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

test('an owner sees every queue beside an open servisan on a 1366×768 screen', async () => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.getByTestId('desktop.person').click();
  await page.getByRole('menuitem', { name: 'Yosua Wonda' }).click();
  await page.getByTestId('repair.desk.board.views.cancelled').click();
  await page.getByText('Lince Wakerkwa').click();
  await expect(page.getByTestId('repair.desk.ticket.customer')).toBeVisible();
  const views = page.getByTestId('repair.desk.board.views');
  expect(await views.evaluate((tabs) => tabs.scrollWidth <= tabs.clientWidth + 1)).toBe(true);
  for (const view of ['active', 'cancelled']) {
    await expect(page.getByTestId(`repair.desk.board.views.${view}`)).toBeInViewport({ ratio: 1 });
  }
  // Nor is a filter cut off at the toolbar's edge.
  await expect(page.getByTestId('repair.desk.filter.priceWaiting')).toBeInViewport({ ratio: 1 });
  const toolbar = (await page.getByTestId('repair.desk.board.filters').boundingBox())!;
  const price = (await page.getByTestId('repair.desk.filter.priceWaiting').boundingBox())!;
  expect(price.x + price.width).toBeLessThanOrEqual(toolbar.x + toolbar.width);
});

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

test('the page gets only the narrow print, update, startup, camera, window and core calls, through the real preload', async () => {
  const shape = await page.evaluate(() => {
    const bridge = (window as { bolusi?: Record<string, Record<string, unknown>> }).bolusi;
    return {
      keys: bridge === undefined ? null : Object.keys(bridge).sort(),
      printers: bridge?.['printers'] === undefined ? null : Object.keys(bridge['printers']).sort(),
      core: bridge?.['core'] === undefined ? null : Object.keys(bridge['core']).sort(),
      window: bridge?.['window'] === undefined ? null : Object.keys(bridge['window']).sort(),
      startup: bridge?.['startup'] === undefined ? null : Object.keys(bridge['startup']).sort(),
      media: bridge?.['media'] === undefined ? null : Object.keys(bridge['media']).sort(),
      node: typeof (window as { require?: unknown }).require,
      process: typeof (window as { process?: unknown }).process,
    };
  });
  expect(shape).toEqual({
    keys: ['core', 'media', 'printers', 'startup', 'updates', 'window'],
    printers: ['choose', 'list', 'printPage', 'printRaw', 'setPaper', 'settings'],
    core: ['connect'],
    window: ['fullscreen', 'onFullscreenChange'],
    startup: ['get', 'set'],
    media: ['choices', 'choose'],
    node: 'undefined',
    process: 'undefined',
  });

  // The printer list comes from the OS through the main process; with none chosen, no test page.
  await page.getByTestId('nav.settings').click();
  await page.getByTestId('desktop.settings.nav.computer').click();
  await expect(page.getByTestId('repair.desk.printing')).toBeVisible();
  await expect(
    page
      .getByTestId('repair.desk.printing.none')
      .or(page.getByTestId('repair.desk.printing.printers')),
  ).toBeVisible();
  await expect(page.getByTestId('repair.desk.printing.test')).toBeDisabled();
  await expect(page.getByTestId('desktop.version')).toHaveText(/^\d+\.\d+\.\d+$/);
});

test('the paper picked in Settings is kept by the main process across a restart', async () => {
  await page.getByTestId('nav.settings').click();
  await page.getByTestId('desktop.settings.nav.computer').click();
  const a5 = page.getByTestId('repair.desk.printing.paper.a5');
  await a5.click();
  await expect(a5).toHaveAttribute('data-state', 'on');
  await app.close();
  await launch();
  await page.getByTestId('nav.settings').click();
  await page.getByTestId('desktop.settings.nav.computer').click();
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
  const tile = page.locator(TILES).first();
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

test('records the ownership video with the webcam and microphone, and plays it back', async () => {
  await page.keyboard.press('F2');
  await page.getByTestId('repair.desk.intake.repairTypes').getByText('Buka kunci / akun').click();
  const section = page.getByTestId('repair.desk.intake.video');
  await section.getByTestId('repair.desk.intake.video.clip.record').click();
  const recorder = page.getByTestId('desktop.video');
  await expect(recorder.getByTestId('desktop.video.start')).toBeEnabled();
  await recorder.getByTestId('desktop.video.start').click();
  await expect(recorder.getByTestId('desktop.video.timer')).toBeVisible();
  await page.waitForTimeout(1500);
  await recorder.getByTestId('desktop.video.stop').click();
  await expect(recorder.getByTestId('desktop.video.take')).toBeVisible();
  await recorder.getByTestId('desktop.video.use').click();
  await expect(recorder).toBeHidden();
  await expect(section.getByTestId('repair.desk.intake.video.clip.recorded')).toBeVisible();
  await section.getByTestId('repair.desk.intake.video.clip.play').click();
  const player = page.getByTestId('desktop.videoPlayer');
  await expect(player.getByTestId('desktop.videoPlayer.video')).toHaveAttribute('src', /^blob:/);
  // The page's own policy lets it play what it recorded.
  await expect
    .poll(() =>
      player
        .getByTestId('desktop.videoPlayer.video')
        .evaluate((video: HTMLVideoElement) => video.error?.code ?? 0),
    )
    .toBe(0);
  await player.getByTestId('desktop.videoPlayer.close').click();
  await expect(player).toBeHidden();
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

test('the pane lists each repair type with its warranty, and the counter changes them', async () => {
  await page.getByText('Maria Kogoya').click();
  const types = page.getByTestId('repair.desk.ticket.repairTypes');
  await expect(types).toContainText('Ganti konektor cas · garansi 30 hari');
  await expect(types).toContainText('Ganti baterai · garansi 30 hari');
  await page.getByTestId('repair.desk.ticket.action.repairTypes').click();
  const chips = page.getByTestId('repair.desk.repairTypes.chips');
  await chips.getByText('Ganti baterai').click();
  await chips.getByText('Ganti layar').click();
  await page.getByTestId('repair.desk.repairTypes.submit').click();
  await expect(page.getByTestId('repair.desk.repairTypes')).toBeHidden();
  await expect(types).not.toContainText('Ganti baterai');
  await expect(types).toContainText('Ganti layar · garansi 30 hari');
});

test('the intake offers the store’s repair types next to the complaint', async () => {
  await page.keyboard.press('F2');
  const chips = page.getByTestId('repair.desk.intake.repairTypes');
  await expect(chips).toContainText('Buka kunci / akun');
  const screen = chips.getByRole('button', { name: 'Ganti layar' });
  await screen.click();
  await expect(screen).toHaveAttribute('aria-pressed', 'true');
});

test('a phone back under warranty starts a claim from its servisan, with no types of its own', async () => {
  await page.getByTestId('repair.desk.board.search').fill('K7Q-0005');
  await page.getByText('Yakob Tabuni').click();
  await expect(page.getByTestId('repair.desk.ticket.repairTypes')).toContainText(
    /Ganti layar · garansi s\/d \d{2}\/\d{2}\/\d{4}/,
  );
  await page.getByTestId('repair.desk.ticket.action.warrantyClaim').click();
  await expect(page.getByTestId('repair.desk.intake')).toBeVisible();
  await expect(page.getByTestId('repair.desk.intake.claim')).toContainText('Dari K7Q-0005');
  await expect(page.getByTestId('repair.desk.intake')).toContainText('Yakob Tabuni');
  await expect(page.getByTestId('repair.desk.intake.repairTypes')).toHaveCount(0);
});

test('the title bar is ours, but minimise, maximise, close and snapping stay Windows’ own', async () => {
  const bar = page.getByTestId('desktop.titlebar');
  await expect(bar).toBeVisible();
  // Windows draws its caption buttons over the bar and says where they are; the bar's own
  // controls end before them, and the empty part drags the window (double click maximises).
  const layout = await page.evaluate(() => {
    const overlay = (
      navigator as Navigator & {
        windowControlsOverlay?: { visible: boolean; getTitlebarAreaRect(): DOMRect };
      }
    ).windowControlsOverlay;
    const header = document.querySelector('[data-testid="desktop.titlebar"]')!;
    const person = document.querySelector('[data-testid="desktop.person"]')!;
    const region = (element: Element): string =>
      getComputedStyle(element).getPropertyValue('-webkit-app-region') ||
      getComputedStyle(element).getPropertyValue('app-region');
    return {
      overlay: overlay?.visible ?? false,
      area: overlay?.getTitlebarAreaRect().toJSON() as { x: number; width: number } | undefined,
      barHeight: header.getBoundingClientRect().height,
      personRight: person.getBoundingClientRect().right,
      barRegion: region(header),
      personRegion: region(person.parentElement!),
    };
  });
  expect(layout.overlay).toBe(true);
  expect(layout.barHeight).toBe(40);
  expect(layout.personRight).toBeLessThanOrEqual(layout.area!.x + layout.area!.width);
  expect(layout.barRegion).toBe('drag');
  expect(layout.personRegion).toBe('no-drag');

  // Maximised keeps the bar; fullscreen (F11) has no caption buttons, so the bar takes the width.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.maximize());
  await expect(bar).toBeVisible();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setFullScreen(true));
  await expect(bar).toHaveAttribute('data-fullscreen', 'true');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setFullScreen(false));
  await expect(bar).not.toHaveAttribute('data-fullscreen');
});

test('closing the window with a dialog open asks first; "Tutup" closes it', async () => {
  await page.getByText('Maria Kogoya').click();
  await page.getByTestId('repair.desk.ticket.action.decidePrice').click();
  await expect(page.getByTestId('repair.desk.proposal')).toBeVisible();
  const closeWindow = (): Promise<void> =>
    app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());

  await closeWindow();
  await expect(page.getByTestId('desktop.closeGuard')).toContainText('Tutup Bolusi?');
  await page.getByTestId('desktop.closeGuard.cancel').click();
  await expect(page.getByTestId('repair.desk.proposal')).toBeVisible();

  await closeWindow();
  const closed = page.waitForEvent('close');
  await page.getByTestId('desktop.closeGuard.confirm').click();
  await closed;
});

test('closing the window with nothing open closes it at once', async () => {
  const closed = page.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await closed;
});
