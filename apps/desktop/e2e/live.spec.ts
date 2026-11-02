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
/** The intake's photo tiles, not its "take them all" button. */
const TILES = '[data-testid^="repair.desk.intake.photo."]:not([data-testid$=".all"])';

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

async function launchPc(options: { webcam: boolean } = { webcam: true }): Promise<Page> {
  const dataDir = mkdtempSync(join(tmpdir(), 'bolusi-pc-'));
  folders.push(dataDir);
  const app = await electron.launch({
    args: [
      '--no-sandbox',
      ...(options.webcam ? ['--use-fake-device-for-media-stream'] : []),
      join(import.meta.dirname, '..'),
    ],
    env: { ...process.env, BOLUSI_API_URL: lane.url, BOLUSI_DESKTOP_DATA_DIR: dataDir },
  });
  apps.push(app);
  return app.firstWindow();
}

/**
 * A store phone's browser, played by a plain window of the same Electron (no extra browser to
 * install on CI). It opens the page on the server from the address in the PC's QR.
 */
async function phoneOpening(
  app: ElectronApplication,
  url: string,
  size = { width: 390, height: 844 },
): Promise<Page> {
  const opening = app.waitForEvent('window');
  await app.evaluate(
    ({ BrowserWindow }, { address, size }) => {
      void new BrowserWindow({ ...size, show: true }).loadURL(address);
    },
    { address: url, size },
  );
  const phone = await opening;
  await phone.setViewportSize(size);
  await phone.waitForLoadState();
  return phone;
}

/** A JPEG as a phone camera would hand the page, made in the phone's own window. */
async function jpegOn(phone: Page): Promise<Buffer> {
  const bytes = await phone.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 2400;
    canvas.height = 1800;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#2a6';
    context.fillRect(0, 0, 2400, 1800);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.9),
    );
    return [...new Uint8Array(await blob!.arrayBuffer())];
  });
  return Buffer.from(bytes);
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
  // The owner who registered the PC is offered its setup first; it can wait.
  await page.getByTestId('desktop.setup.next').click();
  await expect(page.getByTestId('desktop.setup.capture')).toBeVisible();
  await page.getByTestId('desktop.setup.later').click();
  await expect(page.getByTestId('repair.desk.board.newIntake')).toBeVisible();
}

/** A new servisan and a handover offer the slip first; these runs print nothing. */
async function skipPrint(page: Page): Promise<void> {
  const print = page.getByTestId('repair.desk.print');
  await print.getByRole('button', { name: 'Kembali' }).click();
  await expect(print).toBeHidden();
}

let counter: Page;
/** The PC without a webcam, and the store phone paired to it. */
let pc: Page;
let phone: Page;
let jpeg: Buffer;

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
  const tiles = counter.locator(TILES);
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
  await skipPrint(counter);

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

  // No refresh and no "Sinkronkan sekarang" on the counter: the server's nudge brings it in.
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

test('a PC without a webcam takes every intake photo on one paired phone, through the server', async () => {
  pc = await launchPc({ webcam: false });
  const app = apps.at(-1)!;
  await registerAndSignIn(pc, 'PC Tanpa Kamera');
  await pc.keyboard.press('F2');
  await pc.getByTestId('repair.desk.intake.name').fill('Ruth Wanggai');
  await pc.getByTestId('repair.desk.intake.phone').fill('081355667788');
  await pc.getByRole('button', { name: 'Oppo' }).click();
  await pc.getByTestId('repair.desk.intake.model').fill('A78');
  await pc.getByTestId('repair.desk.intake.complaint').fill('Tidak bisa dicas');
  await pc.getByRole('radio', { name: 'Tidak ada' }).click();
  await pc.getByTestId('repair.desk.intake.restOk').click();
  const tiles = pc.locator(TILES);
  const count = await tiles.count();
  await pc.getByTestId('repair.desk.intake.photo.all').click();
  // No webcam: straight to the QR, which points at the server, not this PC.
  const url = (await pc.getByTestId('desktop.handoff.url').textContent())!;
  expect(url.startsWith(`${lane.url}/h/`)).toBe(true);

  phone = await phoneOpening(app, url);
  await expect(pc.getByTestId('desktop.handoff.onPhone')).toBeVisible();
  jpeg = await jpegOn(phone);
  // One scan, then each angle shows up on the phone by itself.
  for (let n = 0; n < count; n += 1) {
    await expect(phone.locator('#photo-title')).toBeVisible();
    expect(await tiles.nth(n).textContent()).toContain(
      await phone.locator('#photo-title').textContent(),
    );
    await phone.locator('#file').setInputFiles({
      name: 'shot.jpg',
      mimeType: 'image/jpeg',
      buffer: jpeg,
    });
    await expect(phone.locator('#preview')).toBeVisible();
    await phone.locator('#photo-send').click();
    await expect(tiles.nth(n).locator('img')).toBeVisible();
  }
  await expect(phone.locator('#waiting')).toBeVisible();
  await expect(pc.getByTestId('desktop.handoff')).toBeHidden();

  await pc.getByTestId('repair.desk.intake.line.0.description').fill('Port cas');
  await pc.getByTestId('repair.desk.intake.line.0.amount').fill('150000');
  await pc.keyboard.press('Control+Enter');
  await expect(pc.getByTestId('repair.desk.ticket.customer')).toHaveText('Ruth Wanggai');
  await skipPrint(pc);
  // The phone's photos are this PC's own: they upload with the servisan.
  await expect(pc.getByTestId('desktop.sync')).toHaveAttribute('data-state', 'synced', {
    timeout: 60_000,
  });
});

/** The paired phone takes the photo the PC just asked for. */
async function photoOnPhone(): Promise<void> {
  await expect(phone.locator('#photo-title')).toBeVisible();
  await phone
    .locator('#file')
    .setInputFiles({ name: 'shot.jpg', mimeType: 'image/jpeg', buffer: jpeg });
  await phone.locator('#photo-send').click();
  await expect(pc.getByTestId('desktop.handoff')).toBeHidden();
}

test('the same phone takes the work photos, and the customer signs on it turned on its side', async () => {
  // Before and after photos go to the phone still paired from the intake: no new code.
  for (const [action, confirm] of [
    ['start', 'Mulai kerjakan'],
    ['markRepaired', 'Selesai dikerjakan'],
  ] as const) {
    await pc.getByTestId(`repair.desk.ticket.action.${action}`).click();
    const dialog = pc.getByRole('dialog');
    await dialog
      .getByRole('button', { name: /Ambil foto/ })
      .first()
      .click();
    await expect(pc.getByTestId('desktop.handoff.qr')).toBeHidden();
    await photoOnPhone();
    await dialog.getByRole('button', { name: confirm }).click();
    await expect(dialog).toBeHidden();
  }

  await pc.getByTestId('repair.desk.ticket.action.handover').click();
  await pc.getByTestId('repair.desk.handover.checks').waitFor();
  for (const line of await pc.getByTestId('repair.desk.handover.checks').getByRole('button').all())
    await line.click();
  await pc.getByTestId('repair.desk.handover.photo').click();
  await photoOnPhone();
  await pc.getByTestId('repair.desk.handover.signature').click();
  await expect(pc.getByTestId('desktop.handoff.onPhone')).toBeVisible();
  // Held upright, the page asks to turn the phone; on its side, most of the screen is pad.
  await expect(phone.locator('#rotate')).toBeVisible();
  await expect(phone.locator('#pad')).toBeHidden();
  await phone.setViewportSize({ width: 844, height: 390 });
  const pad = phone.locator('#pad');
  await expect(pad).toBeVisible();
  const box = (await pad.boundingBox())!;
  expect(box.width).toBeGreaterThan(560);
  await phone.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.6);
  await phone.mouse.down();
  await phone.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.3, { steps: 8 });
  await phone.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.6, { steps: 8 });
  await phone.mouse.up();
  await phone.locator('#sign-send').click();
  await expect(pc.getByTestId('desktop.handoff')).toBeHidden();
  await expect(pc.getByTestId('repair.desk.handover.signature').locator('img')).toBeVisible();
  await pc.getByTestId('repair.desk.handover').getByRole('button', { name: 'Serahkan HP' }).click();
  await expect(pc.getByTestId('repair.desk.handover')).toBeHidden();
  await skipPrint(pc);
  await expect(pc.getByTestId('desktop.sync')).toHaveAttribute('data-state', 'synced', {
    timeout: 60_000,
  });
});

/**
 * The phone window has no camera of its own (the PC was started without the fake webcam), so its
 * browser is handed a drawn picture and a tone, as a phone's camera and microphone would give.
 */
async function cameraOn(page: Page): Promise<void> {
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 1280;
      canvas.height = 720;
      const context = canvas.getContext('2d')!;
      let frame = 0;
      setInterval(() => {
        frame += 1;
        context.fillStyle = `hsl(${String((frame * 4) % 360)} 55% 45%)`;
        context.fillRect(0, 0, 1280, 720);
      }, 33);
      const stream = canvas.captureStream(30);
      const audio = new AudioContext();
      const tone = audio.createOscillator();
      const out = audio.createMediaStreamDestination();
      tone.connect(out);
      tone.start();
      for (const track of out.stream.getAudioTracks()) stream.addTrack(track);
      return Promise.resolve(stream);
    };
  });
}

test('the same phone records the ownership video for a PC without a webcam', async () => {
  await phone.setViewportSize({ width: 390, height: 844 });
  await cameraOn(phone);
  await pc.keyboard.press('F2');
  await pc.getByTestId('repair.desk.intake.repairTypes').getByText('Buka kunci / akun').click();
  const section = pc.getByTestId('repair.desk.intake.video');
  await section.getByTestId('repair.desk.intake.video.clip.record').click();
  // Still paired: the step goes to the phone, with what the clip must say.
  await expect(pc.getByTestId('desktop.handoff.onPhone')).toContainText('Rekam videonya di HP');
  await expect(phone.locator('#clip-hint')).toContainText('bahwa HP ini miliknya');
  await phone.locator('#rec-start').click();
  await expect(phone.locator('#clock-text')).toContainText('/ 1:00');
  await phone.waitForTimeout(1500);
  await phone.screenshot({ path: test.info().outputPath('phone-video-recording.png') });
  await phone.locator('#rec-stop').click();
  await expect(phone.locator('#clip-send')).toBeVisible();
  await expect(phone.locator('#rec-retake')).toBeVisible();
  await phone.screenshot({ path: test.info().outputPath('phone-video-review.png') });
  await phone.locator('#clip-send').click();
  await expect(pc.getByTestId('desktop.handoff')).toBeHidden();
  await expect(phone.locator('#waiting')).toBeVisible();
  await expect(section.getByTestId('repair.desk.intake.video.clip.recorded')).toBeVisible();
  // The clip from the phone is this PC's own now, and plays here.
  await section.getByTestId('repair.desk.intake.video.clip.play').click();
  const player = pc.getByTestId('desktop.videoPlayer');
  await expect(player.getByTestId('desktop.videoPlayer.video')).toHaveAttribute('src', /^blob:/);
  await pc.screenshot({ path: test.info().outputPath('pc-video-from-phone.png') });
  await player.getByTestId('desktop.videoPlayer.close').click();
  await expect(player).toBeHidden();
});

test('the owner adds a cashier with a first PIN, and changes their own PIN, on the PC alone', async () => {
  await counter.getByTestId('nav.settings').click();
  await counter.getByTestId('desktop.settings.nav.staff').click();
  await counter.getByTestId('desktop.settings.staff.add').click();
  await counter.getByTestId('desktop.staff.add.name').fill('Maria Kambu');
  await counter.getByTestId('desktop.staff.add.role.cashier').click();
  await counter.getByTestId('desktop.staff.add.save').click();
  await counter.getByTestId('desktop.staff.added.makePin').click();
  await counter.getByTestId('desktop.resetPin.proceed').click();
  await counter.keyboard.type('135790');
  await counter.keyboard.type('135790');
  await expect(counter.getByTestId('desktop.resetPin.done')).toBeVisible({ timeout: 15_000 });
  await counter.getByTestId('desktop.resetPin.finish').click();
  await expect(counter.getByTestId('desktop.settings.staff')).toContainText('Maria Kambu');

  await counter.getByTestId('desktop.settings.nav.account').click();
  await counter.getByTestId('desktop.settings.changePin').click();
  await counter.keyboard.type(lane.credentials.pin);
  await counter.keyboard.type('246802');
  await counter.keyboard.type('246802');
  await expect(counter.getByTestId('desktop.changePin.done')).toBeVisible({ timeout: 15_000 });
  await counter.getByTestId('desktop.changePin.finish').click();

  // The new cashier signs in on this PC with the PIN the owner set.
  await counter.getByTestId('desktop.person').click();
  await counter.getByRole('menuitem', { name: 'Kunci layar' }).click();
  await counter.getByTestId('switcher.person').filter({ hasText: 'Maria Kambu' }).click();
  await counter.keyboard.type('135790');
  await expect(counter.getByTestId('desktop.shell')).toBeVisible();
});

/** Lock the counter and sign in with `pin` as the person shown with `name`, or as the owner. */
async function signInAs(name: string | null, pin: string): Promise<void> {
  await counter.getByTestId('desktop.person').click();
  await counter.getByRole('menuitem', { name: 'Kunci layar' }).click();
  await counter
    .getByTestId('switcher.person')
    .filter(name === null ? { hasNotText: 'Maria Kambu' } : { hasText: name })
    .click();
  await counter.keyboard.type(pin);
  await expect(counter.getByTestId('desktop.shell')).toBeVisible();
}

test('the owner uses Belanja on the store PC, which keeps none of it once they leave', async () => {
  const belanja = counter.getByRole('button', { name: 'Belanja', exact: true });
  // The cashier may not buy: the PC shows no Belanja, and holds none of it.
  await expect(counter.getByTestId('repair.desk.board.newIntake')).toBeVisible();
  await expect(belanja).toHaveCount(0);

  // The owner's PIN goes to the server, and what only they may read comes down for this sign-in.
  await signInAs(null, '246802');
  await belanja.click();
  await expect(counter.getByTestId('purchasing.desk.table')).toBeVisible({ timeout: 15_000 });
  await counter.getByTestId('purchasing.desk.openSuppliers').click();
  await counter.getByTestId('purchasing.desk.suppliers.add').click();
  await counter.getByTestId('purchasing.desk.supplierForm.name').fill('CV Sinar Jaya');
  await counter
    .getByTestId('purchasing.desk.supplierForm')
    .getByRole('button', { name: /^Simpan/ })
    .click();
  await expect(counter.getByTestId('purchasing.desk.suppliers')).toContainText('CV Sinar Jaya');
  await counter.keyboard.press('Escape');
  await expect(counter.getByTestId('desktop.sync')).toHaveAttribute('data-state', 'synced', {
    timeout: 60_000,
  });

  // The cashier again: no Belanja.
  await signInAs('Maria Kambu', '135790');
  await expect(belanja).toHaveCount(0);

  // The owner again: it comes back from the server.
  await signInAs(null, '246802');
  await belanja.click();
  await counter.getByTestId('purchasing.desk.openSuppliers').click();
  await expect(counter.getByTestId('purchasing.desk.suppliers')).toContainText('CV Sinar Jaya', {
    timeout: 15_000,
  });
  await counter.keyboard.press('Escape');

  // With the server gone (this suite's last test), nothing of it is left on the PC to show.
  server.kill('SIGTERM');
  await signInAs(null, '246802');
  await belanja.click();
  await expect(counter.getByText('Perlu internet untuk membuka ini.')).toBeVisible({
    timeout: 15_000,
  });
  await expect(counter.getByTestId('purchasing.desk.new')).toBeDisabled();
});
