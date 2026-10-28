// The PC over its offline core against a real server (the harness's production-auth server, the
// same one the phone's emulator lane uses): register the PC, sign in with a PIN, take a servisan in
// with webcam photos, send it, and see a colleague's change arrive from a second PC without asking.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

const ROOT = join(import.meta.dirname, '../../..');

interface Lane {
  readonly url: string;
  readonly credentials: {
    readonly ownerLogin: string;
    readonly oneTimePassword: string;
    readonly pin: string;
  };
}

let server: ChildProcess;
let lane: Lane;
const folders: string[] = [];
const apps: ElectronApplication[] = [];

// The installed app in the Windows job has no test server to talk to; this suite runs from source.
test.skip(process.env['BOLUSI_E2E_EXECUTABLE'] !== undefined, 'runs from the source tree only');
test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  server = spawn(process.execPath, ['scripts/harness-serve-lane.mjs', '--port', '0'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  lane = await new Promise<Lane>((resolve, reject) => {
    const lines = createInterface({ input: server.stdout! });
    lines.on('line', (line) => {
      const marker = 'BOLUSI_LANE_READY: ';
      if (line.startsWith(marker)) resolve(JSON.parse(line.slice(marker.length)) as Lane);
    });
    server.once('exit', (code) => reject(new Error(`the test server exited (${String(code)})`)));
  });
});

test.afterAll(async () => {
  for (const app of apps) await app.close().catch(() => undefined);
  server.kill('SIGTERM');
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

async function launchPc(): Promise<Page> {
  const dataDir = mkdtempSync(join(tmpdir(), 'bolusi-pc-'));
  folders.push(dataDir);
  const app = await electron.launch({
    args: ['--no-sandbox', '--use-fake-device-for-media-stream', join(import.meta.dirname, '..')],
    env: { ...process.env, BOLUSI_API_URL: lane.url, BOLUSI_DESKTOP_DATA_DIR: dataDir },
  });
  apps.push(app);
  return app.firstWindow();
}

async function registerAndSignIn(page: Page, name: string): Promise<void> {
  await page.getByTestId('enrol.identifier').fill(lane.credentials.ownerLogin);
  await page.getByTestId('enrol.password').fill(lane.credentials.oneTimePassword);
  await page.getByTestId('enrol.submit').click();
  await page.getByTestId('enrol.deviceName').fill(name);
  await page.getByTestId('enrol.bind').click();
  await page.getByTestId('enrol.finish').click();
  await page.getByTestId('switcher.person').first().click();
  await page.keyboard.type(lane.credentials.pin);
  await expect(page.getByTestId('repair.desk.board.newIntake')).toBeVisible();
}

let counter: Page;

test('registers the PC, signs in and takes a servisan in that reaches the server', async () => {
  counter = await launchPc();
  await registerAndSignIn(counter, 'PC Kasir');

  await counter.keyboard.press('F2');
  await counter.getByTestId('repair.desk.intake.name').fill('Yakobus Mandowen');
  await counter.getByTestId('repair.desk.intake.phone').fill('081344556677');
  await counter.getByRole('button', { name: 'Samsung' }).click();
  await counter.getByTestId('repair.desk.intake.model').fill('Galaxy A54');
  await counter.getByTestId('repair.desk.intake.complaint').fill('Layar bergaris');
  await counter.getByRole('radio', { name: 'Tidak ada' }).click();
  await counter.getByTestId('repair.desk.intake.restOk').click();
  const tiles = counter.locator('[data-testid^="repair.desk.intake.photo."]');
  for (let index = 0; index < (await tiles.count()); index++) {
    await tiles.nth(index).click();
    await counter.getByTestId('desktop.camera.shoot').click();
    await counter.getByTestId('desktop.camera.use').click();
    await expect(counter.getByTestId('desktop.camera')).toBeHidden();
  }
  await counter.getByTestId('repair.desk.intake.line.0.description').fill('LCD A54');
  await counter.getByTestId('repair.desk.intake.line.0.amount').fill('1250000');
  await counter.keyboard.press('Control+Enter');
  await expect(counter.getByTestId('repair.desk.ticket.customer')).toHaveText('Yakobus Mandowen');

  // The change and every photo reach the server.
  await expect(counter.getByTestId('desktop.sync')).toHaveAttribute('data-state', 'synced', {
    timeout: 60_000,
  });
});

test("a second PC gets the servisan, and the first sees the second's change live", async () => {
  const workshop = await launchPc();
  await registerAndSignIn(workshop, 'PC Bengkel');
  await workshop.getByText('Yakobus Mandowen').click();
  // Waiting for parts before the work starts is a rare move, kept under "Lainnya".
  await workshop.getByTestId('repair.desk.ticket.more').click();
  await workshop.getByRole('menuitem', { name: 'Tunggu sparepart' }).click();
  await workshop.getByRole('dialog').getByRole('button', { name: 'Tunggu sparepart' }).click();

  // No refresh and no "Kirim sekarang" on the counter: the server's nudge brings it in.
  await expect(
    counter.getByTestId('repair.desk.board.table').getByText('Tunggu sparepart', { exact: true }),
  ).toBeVisible({ timeout: 10_000 });
});

test('locks the screen and opens again only with the PIN', async () => {
  await counter.getByTestId('desktop.person').click();
  await counter.getByRole('menuitem', { name: 'Kunci layar' }).click();
  await expect(counter.getByTestId('switcher')).toBeVisible();
  await expect(counter.getByTestId('switcher.back')).toBeHidden();
  await counter.getByTestId('switcher.person').first().click();
  await counter.keyboard.type('000000');
  await expect(counter.getByTestId('pin.message')).not.toBeEmpty();
  await counter.keyboard.type(lane.credentials.pin);
  await expect(counter.getByTestId('desktop.shell')).toBeVisible();
});
