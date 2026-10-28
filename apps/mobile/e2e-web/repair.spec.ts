/**
 * The repair flows driven through the real screens in a browser, over the in-memory demo runtime
 * (`packages/modules/src/repair/demo.ts`): each test taps through a flow the way a counter person or technician
 * would and asserts what the screen shows, with a screenshot per flow into `artifacts/repair/`.
 *
 * HONEST CEILING: a browser approximation of the phone screens. Device QA (camera, signature pad,
 * hardware back, keyboard) still happens on a real Android and iOS device.
 */
import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

const ARTIFACTS = path.join(__dirname, 'artifacts', 'repair');

type Role = 'owner' | 'counter' | 'technician' | 'storeOwner';

async function open(page: Page, role: Role): Promise<void> {
  await page.goto(`/?screen=repair&state=${role}`);
  await expect(page.getByTestId('repair.board')).toBeVisible();
}

const tap = (page: Page, testID: string) => page.getByTestId(testID).first().click();
const fill = (page: Page, testID: string, text: string) =>
  page.getByTestId(`${testID}.field`).fill(text);

async function shoot(page: Page, name: string): Promise<void> {
  // Finished CSS transitions, so a switch just flipped shows its end state, not a blend.
  await page.screenshot({ path: path.join(ARTIFACTS, `${name}.png`), animations: 'disabled' });
}

/** Press a drag handle and move it, in small steps like a finger, onto another row's handle. */
async function drag(
  page: Page,
  from: string,
  onto: string,
  options: { shoot?: string } = {},
): Promise<void> {
  const a = await page.getByTestId(from).boundingBox();
  const b = await page.getByTestId(onto).boundingBox();
  if (a === null || b === null) throw new Error('drag handles not on screen');
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2 - 4, { steps: 12 });
  if (options.shoot !== undefined) {
    // The other rows slide aside over 150 ms; picture them where they come to rest.
    await page.waitForTimeout(300);
    await shoot(page, options.shoot);
  }
  await page.mouse.up();
}

/** Draw a lock pattern through the given dots with the mouse, like a finger on the pad. */
async function drawPattern(page: Page, testID: string, dots: readonly number[]): Promise<void> {
  const centres = [];
  for (const dot of dots) {
    const box = (await page.getByTestId(`${testID}.dot.${dot}`).boundingBox())!;
    centres.push({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
  }
  await page.mouse.move(centres[0]!.x, centres[0]!.y);
  await page.mouse.down();
  for (const point of centres.slice(1)) await page.mouse.move(point.x, point.y, { steps: 8 });
  await page.mouse.up();
}

/** The keys of a ReorderableList's rows, top to bottom. */
async function order(page: Page, listTestID: string): Promise<string[]> {
  const prefix = `${listTestID}.item.`;
  const ids = await page
    .locator(`[data-testid^="${prefix}"]`)
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid') ?? ''));
  return ids.map((id) => id.slice(prefix.length));
}

/** Tick every line of the handover checklist, as the counter does with the customer. */
async function tickHandoverChecks(page: Page): Promise<void> {
  const lines = page.getByTestId('repair.handover.checkList').getByRole('checkbox');
  await expect(lines.first()).toBeVisible();
  for (const line of await lines.all()) await line.click();
}

test('a misspelled name finds the ticket', async ({ page }) => {
  await open(page, 'counter');
  await fill(page, 'repair.board.search', 'yohanes wenda');
  await expect(page.getByTestId('repair.board.row.t-1')).toBeVisible();
  await expect(page.getByTestId('repair.board.row.t-2')).toHaveCount(0);
  await shoot(page, 'search');
});

test('the counter takes a repair in and lands on the new ticket', async ({ page }) => {
  await open(page, 'counter');
  await tap(page, 'repair.board.newIntake');
  await fill(page, 'repair.intake.customer.name', 'Ester Mandowen');
  await tap(page, 'repair.intake.primary');
  // The catalog knows the A58: its brand fills in and its colours are offered.
  await fill(page, 'repair.intake.device.model', 'A58');
  await expect(page.getByTestId('repair.intake.device.brand.field')).toHaveValue('Oppo');
  await tap(page, 'repair.intake.device.colour.Glowing Black');
  await expect(page.getByTestId('repair.intake.device.color.field')).toHaveValue('Glowing Black');
  await shoot(page, 'device-autofill');
  // The screen lock is drawn the way the customer draws it; 1 to 7 passes over 4 and takes it in.
  await tap(page, 'repair.intake.device.lock.kind.pattern');
  const pad = page.getByTestId('repair.intake.device.lock.pattern');
  await pad.scrollIntoViewIfNeeded();
  // "Pola" chosen with nothing drawn does not move on as if there were no lock.
  await tap(page, 'repair.intake.primary');
  await expect(page.getByTestId('repair.intake.device.lock.pattern.hint')).toHaveText(
    'Isi kunci layarnya, atau pilih Tidak ada.',
  );
  await drawPattern(page, 'repair.intake.device.lock.pattern', [1, 2]);
  await expect(page.getByTestId('repair.intake.device.lock')).toContainText('minimal 4 titik');
  await drawPattern(page, 'repair.intake.device.lock.pattern', [1, 7, 8, 9]);
  await expect(pad).toHaveAttribute('aria-label', 'Pola kunci layar: 1-4-7-8-9');
  await shoot(page, 'device-pattern');
  await tap(page, 'repair.intake.primary');
  await fill(page, 'repair.intake.condition.complaint', 'Mati total');
  await tap(page, 'repair.intake.condition.restOk');
  await tap(page, 'repair.intake.primary');
  // The primary action walks round the phone, one missing shot per tap.
  for (let shot = 0; shot < 6; shot += 1) await tap(page, 'repair.intake.primary');
  await expect(page.getByTestId('repair.intake.primary')).toHaveText('Lanjut');
  await tap(page, 'repair.intake.primary');
  await fill(page, 'repair.intake.price.description.0', 'LCD A58');
  await fill(page, 'repair.intake.price.amount.0', '650000');
  await expect(page.getByTestId('repair.intake.price.amount.0.field')).toHaveValue('650.000');
  await tap(page, 'repair.intake.primary');
  await expect(page.getByTestId('repair.intake.review.total')).toHaveText('Rp 650.000');
  await expect(page.getByTestId('repair.intake.review.devicePhoto.image')).toBeVisible();
  await shoot(page, 'intake-review');
  await tap(page, 'repair.intake.primary');
  await expect(page.getByTestId('repair.ticket.customer')).toHaveText('Ester Mandowen');
  await expect(page.getByTestId('repair.ticket.devicePhoto.image')).toBeVisible();
  // Unassigned, picking a technician is the counter's next step.
  await expect(page.getByTestId('repair.ticket.action.assign')).toBeVisible();
  await shoot(page, 'intake-ticket');
  // The pattern stays hidden until asked for, then reads in order and is drawn out.
  await expect(page.getByTestId('repair.ticket.passcode')).toHaveText('••••');
  await tap(page, 'repair.ticket.passcode.toggle');
  await expect(page.getByTestId('repair.ticket.passcode')).toHaveText('1-4-7-8-9');
  await page.getByTestId('repair.ticket.passcode.pattern').scrollIntoViewIfNeeded();
  await shoot(page, 'ticket-pattern');
  // The picker lists the store's technicians with their loads, not an error.
  await tap(page, 'repair.ticket.action.assign');
  await expect(page.locator('[data-testid^="repair.assign.row."]').first()).toBeVisible();
  await expect(page.getByTestId('repair.assign.items.error')).toHaveCount(0);
});

/** About what a phone shows above its on-screen keyboard; the browser has no keyboard to open. */
const KEYBOARD_UP = { width: 390, height: 520 };

test('typing a model suggests catalog phones with their picture', async ({ page }) => {
  await open(page, 'counter');
  await tap(page, 'repair.board.newIntake');
  await fill(page, 'repair.intake.customer.name', 'Ester Mandowen');
  await tap(page, 'repair.intake.primary');
  // Tapping the model field opens the keyboard, and the field moves to the top so the suggestions
  // fit under it. The field (label included) settles just under the header. Wait for the scroll to
  // end first: a scripted focus, as `fill` does, cuts a browser's smooth scroll short (typing on a
  // phone does not).
  await expect(page.getByTestId('repair.intake.device.model.field')).not.toBeFocused();
  await page.setViewportSize(KEYBOARD_UP);
  await page.getByTestId('repair.intake.device.model.field').click();
  const header = (await page.getByTestId('repair.intake.header').first().boundingBox())!;
  await expect
    .poll(async () => (await page.getByTestId('repair.intake.device.model').boundingBox())!.y)
    .toBeLessThan(header.y + header.height + 24);
  // A typo still finds the model, newest phones first among equal matches.
  await fill(page, 'repair.intake.device.model', 'galaxy a5');
  await expect(page.getByTestId('repair.intake.device.model.c:12824')).toBeVisible();
  await expect(page.getByTestId('repair.intake.device.model.c:12824.photo.image')).toBeVisible();
  await expect(page.getByTestId('repair.intake.device.model.c:12824')).toBeInViewport();
  await shoot(page, 'device-suggestions-keyboard');

  await tap(page, 'repair.intake.device.model.c:12824');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId('repair.intake.device.model.field')).toHaveValue('Galaxy A55');
  await expect(page.getByTestId('repair.intake.device.brand.field')).toHaveValue('Samsung');
  await expect(page.getByTestId('repair.intake.device.modelMatch')).toContainText('Rilis 2024');
  await expect(page.getByTestId('repair.intake.device.modelMatch.memory')).toHaveText(
    '8/128GB · 8/256GB · 12/256GB',
  );
  await expect(page.getByTestId('repair.intake.device.models')).toHaveCount(0);
  await shoot(page, 'device-picked');

  // Typed with the brand in front, the model is written the catalog's way on leaving the field.
  await fill(page, 'repair.intake.device.brand', '');
  await fill(page, 'repair.intake.device.model', 'samsung a55');
  await page.getByTestId('repair.intake.device.color.field').focus();
  await expect(page.getByTestId('repair.intake.device.model.field')).toHaveValue('Galaxy A55');
  await expect(page.getByTestId('repair.intake.device.brand.field')).toHaveValue('Samsung');

  // A phone the catalog lacks, taken in before, is suggested from the store's own intakes.
  await fill(page, 'repair.intake.device.brand', '');
  await fill(page, 'repair.intake.device.model', 'evercos xtream');
  await expect(page.getByTestId('repair.intake.device.models')).toContainText(
    'Pernah diservis di sini',
  );
  await shoot(page, 'device-learned');
});

test('the technician sees the phone inside out; the counter sees its memory variants', async ({
  page,
}) => {
  await open(page, 'technician');
  await tap(page, 'repair.board.views.active');
  await tap(page, 'repair.board.row.t-1');
  const specs = page.getByTestId('repair.ticket.specs');
  await specs.scrollIntoViewIfNeeded();
  await expect(page.getByTestId('repair.ticket.specs.chipset')).toHaveText(
    'Mediatek Helio G80 (12 nm)',
  );
  await expect(page.getByTestId('repair.ticket.specs.screen')).toHaveText('6.6 inci, PLS LCD');
  await expect(page.getByTestId('repair.ticket.specs.memory')).toHaveText(
    '4/64GB · 4/128GB · 6/128GB',
  );
  await specs.screenshot({ path: path.join(ARTIFACTS, 'ticket-specs-technician.png') });

  await open(page, 'counter');
  await tap(page, 'repair.board.row.t-1');
  await expect(page.getByTestId('repair.ticket.specs.memory')).toBeVisible();
  await expect(page.getByTestId('repair.ticket.specs.chipset')).toHaveCount(0);
  await page.getByTestId('repair.ticket.specs').screenshot({
    path: path.join(ARTIFACTS, 'ticket-specs-counter.png'),
  });
});

test('a focused field on a long form is scrolled above the keyboard', async ({ page }) => {
  await open(page, 'counter');
  await tap(page, 'repair.board.newIntake');
  await fill(page, 'repair.intake.customer.name', 'Ester Mandowen');
  await tap(page, 'repair.intake.primary');
  await page.setViewportSize(KEYBOARD_UP);
  // The PIN is the last field: below the fold, and focused as soon as PIN is chosen.
  await tap(page, 'repair.intake.device.lock.kind.pin');
  await expect(page.getByTestId('repair.intake.device.lock.pin.field')).toBeFocused();
  await expect(page.getByTestId('repair.intake.device.lock.pin.field')).toBeInViewport();
  await expect(page.getByTestId('repair.intake.primary')).toBeInViewport();
  await shoot(page, 'keyboard-last-field');
});

test('the price-kind choices stay one row high on the price-change step', async ({ page }) => {
  await open(page, 'technician');
  await tap(page, 'repair.board.row.t-2');
  await tap(page, 'repair.ticket.action.proposePrice');
  const kinds = await page.getByTestId('repair.price.propose.kind').boundingBox();
  expect(kinds?.height ?? Infinity).toBeLessThan(80);
  await shoot(page, 'propose-price');
});

test('the counter decides a proposal and the agreed total grows', async ({ page }) => {
  await open(page, 'counter');
  await tap(page, 'repair.board.row.t-2');
  await expect(page.getByTestId('repair.ticket.pendingTotal')).toBeVisible();
  await tap(page, 'repair.ticket.action.decidePrice');
  await tap(page, 'repair.proposal.primary');
  await expect(page.getByTestId('repair.ticket.total')).toHaveText('Rp 315.000');
  await expect(page.getByTestId('repair.ticket.pendingTotal')).toHaveCount(0);
  await shoot(page, 'proposal-applied');
});

test('handover takes the rest of the bill, then the photo and the signature', async ({ page }) => {
  await open(page, 'counter');
  await tap(page, 'repair.board.views.pickup');
  await tap(page, 'repair.board.row.t-4');
  await tap(page, 'repair.ticket.action.handover');
  // Rp 115.000 less the Rp 100.000 DP: the rest, in cash unless the counter picks another method.
  await expect(page.getByTestId('repair.handover.balance')).toHaveText('Rp 15.000');
  await expect(page.getByTestId('repair.handover.pay.line0.amount.field')).toHaveValue('15.000');
  await fill(page, 'repair.handover.pay.line0.tendered', '20000');
  await expect(page.getByTestId('repair.handover.pay.line0.change')).toHaveText('Rp 5.000');
  await expect(page.getByTestId('repair.handover.primary')).toBeDisabled();
  await shoot(page, 'handover-payment');
  await tickHandoverChecks(page);
  await tap(page, 'repair.handover.photo.press');
  await tap(page, 'repair.handover.signature.press');
  await tap(page, 'repair.handover.primary');
  await expect(page.getByTestId('repair.ticket.photos.strip.signature')).toBeVisible();
  await shoot(page, 'handover-done');
});

test('the counter goes through the checks with the customer; anything not ticked needs a note', async ({
  page,
}) => {
  await open(page, 'counter');
  await tap(page, 'repair.board.views.pickup');
  await tap(page, 'repair.board.row.t-4');
  await tap(page, 'repair.ticket.action.handover');
  await fill(page, 'repair.handover.pay.line0.tendered', '15000');
  await tap(page, 'repair.handover.photo.press');
  await tap(page, 'repair.handover.signature.press');
  const lines = page.getByTestId('repair.handover.checkList').getByRole('checkbox');
  await expect(lines).toHaveText([
    'Sudah dicoba pelanggan',
    'Bagian yang diperbaiki berfungsi',
    'Charger dikembalikan',
    'Casing dikembalikan',
  ]);
  await expect(page.getByTestId('repair.handover.primary')).toBeDisabled();
  await tap(page, 'repair.handover.check.check.customerTried');
  await tap(page, 'repair.handover.check.check.repairWorks');
  await tap(page, 'repair.handover.check.accessory.case');
  await expect(page.getByTestId('repair.handover.primary')).toBeDisabled();
  await shoot(page, 'handover-checks');
  await fill(page, 'repair.handover.note', 'Charger diambil besok');
  await expect(page.getByTestId('repair.handover.primary')).toBeEnabled();
  await tap(page, 'repair.handover.primary');
  const history = page.getByTestId('repair.ticket.timeline');
  await expect(history).toContainText('Belum: Charger');
  await history.scrollIntoViewIfNeeded();
  await shoot(page, 'handover-checks-history');
});

test('a split payment needs every part, and an EDC payment its approval code', async ({ page }) => {
  await open(page, 'counter');
  await tap(page, 'repair.board.views.pickup');
  await tap(page, 'repair.board.row.t-4');
  await tap(page, 'repair.ticket.action.handover');
  await tickHandoverChecks(page);
  await tap(page, 'repair.handover.photo.press');
  await tap(page, 'repair.handover.signature.press');
  await fill(page, 'repair.handover.pay.line0.amount', '5000');
  await expect(page.getByTestId('repair.handover.pay.remaining')).toHaveText('Kurang Rp 10.000');
  await tap(page, 'repair.handover.pay.add');
  await expect(page.getByTestId('repair.handover.pay.line1.amount.field')).toHaveValue('10.000');
  await tap(page, 'repair.handover.pay.line1.method.account:01920000-0000-7000-8000-00000000a002');
  await expect(page.getByTestId('repair.handover.primary')).toBeDisabled();
  await shoot(page, 'handover-split-edc');
  await fill(page, 'repair.handover.pay.line1.reference', '004512');
  await expect(page.getByTestId('repair.handover.primary')).toBeEnabled();
  await shoot(page, 'handover-split-ready');
});

test('only an owner lets a phone go unpaid, with a reason', async ({ page }) => {
  await open(page, 'counter');
  await tap(page, 'repair.board.views.pickup');
  await tap(page, 'repair.board.row.t-4');
  await tap(page, 'repair.ticket.action.handover');
  await expect(page.getByTestId('repair.handover.payLater')).toHaveCount(0);

  await open(page, 'owner');
  await tap(page, 'repair.board.views.pickup');
  await tap(page, 'repair.board.row.t-4');
  await tap(page, 'repair.ticket.action.handover');
  await tap(page, 'repair.handover.payLater');
  await tickHandoverChecks(page);
  await tap(page, 'repair.handover.photo.press');
  await tap(page, 'repair.handover.signature.press');
  await expect(page.getByTestId('repair.handover.primary')).toBeDisabled();
  await fill(page, 'repair.handover.unpaidReason', 'Langganan, bayar hari Jumat');
  await expect(page.getByTestId('repair.handover.debt')).toHaveText(
    'Sisa Rp 15.000 dicatat sebagai utang pelanggan.',
  );
  await expect(page.getByTestId('repair.handover.primary')).toBeEnabled();
  await shoot(page, 'handover-pay-later');
});

test('a cancelled servisan gives back the DP less its fee, with nothing to pay', async ({
  page,
}) => {
  await open(page, 'counter');
  await tap(page, 'repair.board.views.pickup');
  await tap(page, 'repair.board.row.t-5');
  await tap(page, 'repair.ticket.action.handover');
  await expect(page.getByTestId('repair.handover.balance')).toHaveText('Rp 50.000');
  await expect(page.getByTestId('repair.handover.payment')).toHaveCount(0);
  await shoot(page, 'handover-cancelled-refund');
});

test('a ticket photo opens full screen, zooms on double tap, and "see all" groups every photo', async ({
  page,
}) => {
  await open(page, 'counter');
  await tap(page, 'repair.board.row.t-2');
  await tap(page, 'repair.ticket.photos.strip.back');
  await expect(page.getByTestId('repair.ticket.photos.viewer.label')).toHaveText('Belakang');
  await expect(page.getByTestId('repair.ticket.photos.viewer.position')).toHaveText('2 dari 8');
  const photo = page.getByTestId('repair.ticket.photos.viewer.zoom.back');
  await photo.dblclick();
  await expect(photo).toHaveCSS('transform', /matrix\(2\.5/);
  await shoot(page, 'photo-zoomed');
  await tap(page, 'repair.ticket.photos.viewer.close');
  await expect(page.getByTestId('repair.ticket.photos.viewer')).toHaveCount(0);

  await tap(page, 'repair.ticket.photos.seeAll');
  await expect(page.getByTestId('repair.ticket.photos.sheet.title')).toHaveText('Semua foto');
  await tap(page, 'repair.ticket.photos.sheet.front');
  await expect(page.getByTestId('repair.ticket.photos.viewer.label')).toHaveText('Depan');
  await tap(page, 'repair.ticket.photos.viewer.close');
  // Closing a photo opened from the sheet goes back to the sheet.
  await expect(page.getByTestId('repair.ticket.photos.sheet')).toBeVisible();
});

async function openIntakeOptions(page: Page, role: Role): Promise<void> {
  await open(page, role);
  await tap(page, 'ui.avatarButton');
  await expect(page.getByTestId('account-menu')).toBeVisible();
  await shoot(page, `account-menu-${role}`);
  await tap(page, 'shell-open-settings');
  await tap(page, 'settings-intake-options');
  await expect(page.getByTestId('repair.options.open.checks')).toBeVisible();
}

test('the owner renames, adds and hides condition checks, and the summary follows', async ({
  page,
}) => {
  await openIntakeOptions(page, 'owner');
  await shoot(page, 'options-overview');
  await tap(page, 'repair.options.open.checks');
  await shoot(page, 'options-checks');

  const list = 'repair.options.list.checks';
  await tap(page, `${list}.row.camera`);
  await shoot(page, 'options-row-open');
  await fill(page, `${list}.row.camera.name`, 'Kamera depan & belakang');
  // Close the row, then drag "Mikrofon" above "Kamera" by its handle.
  await tap(page, `${list}.row.camera.done`);
  await drag(page, `${list}.order.handle.microphone`, `${list}.order.handle.camera`, {
    shoot: 'options-dragging',
  });
  expect(await order(page, `${list}.order`)).toEqual([
    'screen',
    'touch',
    'microphone',
    'camera',
    'speaker',
    'charging',
    'buttons',
    'signal',
    'biometrics',
  ]);
  await tap(page, `${list}.row.signal`);
  await tap(page, `${list}.row.signal.shown`);
  await tap(page, `${list}.add`);
  await fill(page, `${list}.row.new-1.name`, 'Face ID');
  await shoot(page, 'options-checks-edited');
  await tap(page, `${list}.primary`);

  await expect(page.getByTestId('repair.options.open.checks')).toContainText(
    '10 pilihan · 1 disembunyikan',
  );
  await tap(page, 'repair.options.open.checks');
  const rows = page.getByTestId(`${list}.rows`);
  await expect(rows).toContainText('Kamera depan & belakang');
  // The dragged order was saved.
  expect((await order(page, `${list}.order`)).slice(2, 4)).toEqual(['microphone', 'camera']);
  await expect(rows).toContainText('Face ID');
});

test('a list that cannot be saved says why, and leaving asks before dropping changes', async ({
  page,
}) => {
  await openIntakeOptions(page, 'owner');
  await tap(page, 'repair.options.open.brands');
  const list = 'repair.options.list.brands';
  await tap(page, `${list}.add`);
  await tap(page, `${list}.row.vivo`);
  await fill(page, `${list}.row.vivo.name`, 'oppo');
  await tap(page, `${list}.primary`);
  // The first row to fix opens; the empty new row says why where it stands.
  await expect(page.getByTestId(`${list}.row.vivo.name.error`)).toBeVisible();
  await expect(page.getByTestId(`${list}.row.new-1`)).toContainText(/.+/);
  await shoot(page, 'options-problems');

  await tap(page, `${list}.back`);
  await expect(page.getByTestId(`${list}.discard`)).toBeVisible();
  await shoot(page, 'options-discard');
});

test('a store owner only chooses what this store uses', async ({ page }) => {
  await openIntakeOptions(page, 'storeOwner');
  await tap(page, 'repair.options.open.accessories');
  const list = 'repair.options.list.accessories';
  await expect(page.getByTestId(`${list}.add`)).toHaveCount(0);
  await tap(page, `${list}.row.box.shown`);
  await shoot(page, 'options-store-owner');
  await tap(page, `${list}.primary`);
  await expect(page.getByTestId('repair.options.open.accessories')).toContainText(
    '1 disembunyikan',
  );
});

test('intake offers the owner’s lists and the ticket keeps their names', async ({ page }) => {
  await openIntakeOptions(page, 'owner');
  await tap(page, 'repair.options.open.checks');
  await tap(page, 'repair.options.list.checks.add');
  await fill(page, 'repair.options.list.checks.row.new-1.name', 'Face ID');
  await tap(page, 'repair.options.list.checks.primary');
  await tap(page, 'repair.options.open.photoAngles');
  await tap(page, 'repair.options.list.photoAngles.add');
  await fill(page, 'repair.options.list.photoAngles.row.new-1.name', 'Stiker IMEI');
  await tap(page, 'repair.options.list.photoAngles.primary');
  await expect(page.getByTestId('repair.options.open.photoAngles')).toContainText('7 pilihan');

  // Back home in the same page: the demo runtime lives in memory.
  await tap(page, 'repair.options.back');
  await tap(page, 'settings-screen.back');
  await expect(page.getByTestId('repair.board')).toBeVisible();
  await tap(page, 'repair.board.newIntake');
  await fill(page, 'repair.intake.customer.name', 'Ester Mandowen');
  await tap(page, 'repair.intake.primary');
  await tap(page, 'repair.intake.device.brandChoice.Oppo');
  await fill(page, 'repair.intake.device.model', 'A57');
  await tap(page, 'repair.intake.primary');
  await fill(page, 'repair.intake.condition.complaint', 'Face ID mati');
  await expect(page.getByText('Face ID', { exact: true })).toBeVisible();
  await shoot(page, 'options-intake-condition');
  await tap(page, 'repair.intake.condition.restOk');
  await tap(page, 'repair.intake.primary');
  for (let shot = 0; shot < 7; shot += 1) await tap(page, 'repair.intake.primary');
  await expect(page.getByTestId('repair.intake.primary')).toHaveText('Lanjut');
  await shoot(page, 'options-intake-photos');
  await tap(page, 'repair.intake.primary');
  await fill(page, 'repair.intake.price.description.0', 'Modul Face ID');
  await fill(page, 'repair.intake.price.amount.0', '450000');
  await tap(page, 'repair.intake.primary');
  await tap(page, 'repair.intake.primary');
  await expect(page.getByTestId('repair.ticket.customer')).toHaveText('Ester Mandowen');
  await expect(page.getByTestId('repair.ticket.photos.strip.front')).toBeVisible();
  await shoot(page, 'options-ticket');
});

test('the owner sets each repair type’s warranty and which ones need a video', async ({ page }) => {
  await openIntakeOptions(page, 'owner');
  await expect(page.getByTestId('repair.options.open.repairTypes')).toBeVisible();
  await tap(page, 'repair.options.open.repairTypes');
  const list = 'repair.options.list.repairTypes';
  // Each type says its terms without opening it.
  await expect(page.getByTestId(`${list}.row.screen`)).toContainText('Garansi 30 hari');
  await expect(page.getByTestId(`${list}.row.unlock`)).toContainText('Perlu video');
  await shoot(page, 'types-list');
  await tap(page, `${list}.row.battery`);
  await fill(page, `${list}.row.battery.warranty`, '90');
  await tap(page, `${list}.row.battery.needsVideo`);
  await shoot(page, 'types-row-open');
  await tap(page, `${list}.row.battery.done`);
  await expect(page.getByTestId(`${list}.row.battery`)).toContainText(
    'Garansi 90 hari · Perlu video',
  );
  await tap(page, `${list}.primary`);
  await tap(page, 'repair.options.open.repairTypes');
  await expect(page.getByTestId(`${list}.row.battery`)).toContainText(
    'Garansi 90 hari · Perlu video',
  );
});

test('intake picks the repair types and the ticket shows each warranty', async ({ page }) => {
  await open(page, 'counter');
  await tap(page, 'repair.board.newIntake');
  await fill(page, 'repair.intake.customer.name', 'Ester Mandowen');
  await tap(page, 'repair.intake.primary');
  await tap(page, 'repair.intake.device.brandChoice.Oppo');
  await fill(page, 'repair.intake.device.model', 'A57');
  await tap(page, 'repair.intake.primary');
  await fill(page, 'repair.intake.condition.complaint', 'Layar pecah, baterai cepat habis');
  await tap(page, 'repair.intake.condition.repairType.screen');
  await tap(page, 'repair.intake.condition.repairType.battery');
  await page.getByTestId('repair.intake.condition.repairTypes').scrollIntoViewIfNeeded();
  await shoot(page, 'types-intake');
  await tap(page, 'repair.intake.condition.restOk');
  await tap(page, 'repair.intake.primary');
  for (let shot = 0; shot < 6; shot += 1) await tap(page, 'repair.intake.primary');
  await tap(page, 'repair.intake.primary');
  await fill(page, 'repair.intake.price.description.0', 'LCD + baterai');
  await fill(page, 'repair.intake.price.amount.0', '800000');
  await tap(page, 'repair.intake.primary');
  await expect(page.getByTestId('repair.intake.review.repairTypes')).toContainText(
    'Ganti layar, Ganti baterai',
  );
  await tap(page, 'repair.intake.primary');
  await expect(page.getByTestId('repair.ticket.repairTypes')).toContainText(
    'Ganti layar · garansi 30 hari',
  );
  await expect(page.getByTestId('repair.ticket.repairTypes')).toContainText(
    'Ganti baterai · garansi 30 hari',
  );
  await shoot(page, 'types-ticket');

  // The diagnosis shows the battery is fine: the counter takes it off.
  await tap(page, 'repair.ticket.action.repairTypes');
  await tap(page, 'repair.repairTypes.type.battery');
  await shoot(page, 'types-change');
  await tap(page, 'repair.repairTypes.primary');
  await expect(page.getByTestId('repair.ticket.repairTypes')).not.toContainText('Ganti baterai');
  await expect(page.getByTestId('repair.ticket.repairTypes')).toContainText('Ganti layar');
});

test('unlocking takes the ownership video after the intake photos', async ({ page }) => {
  await open(page, 'counter');
  await tap(page, 'repair.board.newIntake');
  await fill(page, 'repair.intake.customer.name', 'Ester Mandowen');
  await tap(page, 'repair.intake.primary');
  await tap(page, 'repair.intake.device.brandChoice.Oppo');
  await fill(page, 'repair.intake.device.model', 'A57');
  await tap(page, 'repair.intake.primary');
  await fill(page, 'repair.intake.condition.complaint', 'Lupa pola');
  await tap(page, 'repair.intake.condition.repairType.unlock');
  await tap(page, 'repair.intake.condition.restOk');
  await tap(page, 'repair.intake.primary');
  for (let shot = 0; shot < 6; shot += 1) await tap(page, 'repair.intake.primary');
  // The walk round the phone ends with the video, not the next step.
  await expect(page.getByTestId('repair.intake.primary')).toContainText('Rekam video kepemilikan');
  await page.getByTestId('repair.intake.photos.video').scrollIntoViewIfNeeded();
  await shoot(page, 'video-intake-needed');
  await tap(page, 'repair.intake.primary');
  await expect(page.getByTestId('repair.intake.photos.video.tile.retake')).toBeVisible();
  await page.getByTestId('repair.intake.photos.video').scrollIntoViewIfNeeded();
  await shoot(page, 'video-intake-recorded');
  await tap(page, 'repair.intake.primary');
  await fill(page, 'repair.intake.price.description.0', 'Buka pola');
  await fill(page, 'repair.intake.price.amount.0', '100000');
  await tap(page, 'repair.intake.primary');
  await expect(page.getByTestId('repair.intake.review.video')).toContainText('Sudah direkam');
  await tap(page, 'repair.intake.primary');
  await expect(page.getByTestId('repair.ticket.video.recordedAt')).toBeVisible();
  await page.getByTestId('repair.ticket.video').scrollIntoViewIfNeeded();
  await shoot(page, 'video-ticket');
});

test('a type added later that needs the video holds the handover until it is taken', async ({
  page,
}) => {
  await open(page, 'counter');
  await tap(page, 'repair.board.views.pickup');
  await tap(page, 'repair.board.row.t-4');
  await tap(page, 'repair.ticket.action.repairTypes');
  await tap(page, 'repair.repairTypes.type.unlock');
  await tap(page, 'repair.repairTypes.primary');
  await expect(page.getByTestId('repair.ticket.video.needed')).toBeVisible();
  await tap(page, 'repair.ticket.action.handover');
  await expect(page.getByTestId('repair.handover.video.hint')).toBeVisible();
  await fill(page, 'repair.handover.pay.line0.tendered', '20000');
  await tickHandoverChecks(page);
  await tap(page, 'repair.handover.photo.press');
  await tap(page, 'repair.handover.signature.press');
  await expect(page.getByTestId('repair.handover.primary')).toBeDisabled();
  await page.getByTestId('repair.handover.video').scrollIntoViewIfNeeded();
  await shoot(page, 'video-handover-needed');
  await tap(page, 'repair.handover.video.tile.slot.press');
  // The clip just taken stays in sight, and the handover goes through.
  await expect(page.getByTestId('repair.handover.video.recordedAt')).toBeVisible();
  await expect(page.getByTestId('repair.handover.primary')).toBeEnabled();
});

test('once the phone goes home, the warranty shows its last day', async ({ page }) => {
  await open(page, 'counter');
  await tap(page, 'repair.board.views.pickup');
  await tap(page, 'repair.board.row.t-4');
  await expect(page.getByTestId('repair.ticket.repairTypes')).toContainText('· garansi 30 hari');
  await tap(page, 'repair.ticket.action.handover');
  await tickHandoverChecks(page);
  await tap(page, 'repair.handover.photo.press');
  await tap(page, 'repair.handover.signature.press');
  await tap(page, 'repair.handover.primary');
  await expect(page.getByTestId('repair.ticket.repairTypes')).toContainText(
    /· garansi s\/d \d{2}\/\d{2}\/\d{4}/,
  );
  // A phone that went home keeps the types it was repaired for.
  await expect(page.getByTestId('repair.ticket.action.repairTypes')).toHaveCount(0);
  await shoot(page, 'types-returned');
});

test('a phone back under warranty opens a free claim linked to its servisan', async ({ page }) => {
  await open(page, 'counter');
  await fill(page, 'repair.board.search', 'K7Q-0005');
  await tap(page, 'repair.board.row.t-8');
  await expect(page.getByTestId('repair.ticket.repairTypes')).toContainText('· garansi s/d');
  await tap(page, 'repair.ticket.action.warrantyClaim');
  // The same customer and phone, and the claim says where its warranty comes from.
  await expect(page.getByTestId('repair.intake.claim')).toContainText('Dari K7Q-0005');
  await expect(page.getByTestId('repair.intake.claim.ended')).toHaveCount(0);
  await shoot(page, 'claim-intake');
  await tap(page, 'repair.intake.primary');
  await expect(page.getByTestId('repair.intake.device.model.field')).toHaveValue('Redmi Note 12');
  await tap(page, 'repair.intake.primary');
  await fill(page, 'repair.intake.condition.complaint', 'Layar berkedip lagi');
  // A claim repairs what its servisan did: it picks no types of its own.
  await expect(page.getByTestId('repair.intake.condition.repairTypes')).toHaveCount(0);
  await tap(page, 'repair.intake.condition.restOk');
  await tap(page, 'repair.intake.primary');
  for (let shot = 0; shot < 6; shot += 1) await tap(page, 'repair.intake.primary');
  await tap(page, 'repair.intake.primary');
  await expect(page.getByTestId('repair.intake.price.description.0.field')).toHaveValue(
    'Klaim garansi',
  );
  await tap(page, 'repair.intake.primary');
  await expect(page.getByTestId('repair.intake.review.total')).toHaveText('Rp 0');
  await expect(page.getByTestId('repair.intake.claim')).toBeVisible();
  await tap(page, 'repair.intake.primary');

  const link = page.getByTestId('repair.ticket.claimLink');
  await expect(link).toContainText('K7Q-0005');
  await expect(link).toContainText(/Ganti layar · garansi s\/d \d{2}\/\d{2}\/\d{4}/);
  await expect(page.getByTestId('repair.ticket.repairTypes')).toHaveCount(0);
  await shoot(page, 'claim-ticket');
  // Each servisan links to the other.
  await tap(page, 'repair.ticket.claimLink.t-8');
  await expect(page.getByTestId('repair.ticket.customer')).toHaveText('Yakob Tabuni');
  await expect(page.getByTestId('repair.ticket.claimLink')).toBeVisible();
  await shoot(page, 'claim-original');
});

test('a technician cannot start a warranty claim', async ({ page }) => {
  await open(page, 'technician');
  await fill(page, 'repair.board.search', 'K7Q-0005');
  await tap(page, 'repair.board.row.t-8');
  await expect(page.getByTestId('repair.ticket.customer')).toHaveText('Yakob Tabuni');
  await expect(page.getByTestId('repair.ticket.action.warrantyClaim')).toHaveCount(0);
});

test('the preview start page signs in, and switching user keeps the same tickets', async ({
  page,
}) => {
  await page.goto('/');
  await tap(page, 'preview.role.counter');
  await expect(page.getByTestId('repair.board')).toBeVisible();
  await tap(page, 'repair.board.row.t-1');
  await tap(page, 'repair.ticket.action.assign');
  await tap(page, 'repair.assign.row.u-budi');
  await tap(page, 'repair.ticket.back');

  await tap(page, 'ui.avatarButton');
  await tap(page, 'account-menu-switch-user');
  await page.getByText('Budi Santoso').first().click();
  // The preview opens on any PIN.
  for (const digit of '123456') {
    await page.getByRole('button', { name: digit, exact: true }).click();
  }
  await expect(page.getByTestId('ui.avatarButton.avatar')).toHaveText('BS');
  // The ticket the counter just gave Budi is in his own list.
  await tap(page, 'repair.board.views.mine');
  await expect(page.getByTestId('repair.board.row.t-1')).toBeVisible();
  await shoot(page, 'preview-switched');
});

/** A colleague's change on another device, applied the way a pull would land it. */
async function colleague(page: Page, command: string, input: Record<string, unknown>) {
  await page.evaluate(
    ([name, args]) => {
      const hook = (window as unknown as Record<string, { run(n: string, i: unknown): unknown }>)[
        '__repairDemoColleague'
      ];
      hook!.run(name, args);
    },
    [command, input] as const,
  );
}

test("a colleague's change shows on the open ticket at once", async ({ page }) => {
  await open(page, 'counter');
  await tap(page, 'repair.board.row.t-1');
  await expect(page.getByTestId('repair.ticket.technician')).toContainText('Belum ada teknisi');
  await colleague(page, 'assignTechnician', { ticketId: 't-1', technicianId: 'u-yosua' });
  await expect(page.getByTestId('repair.ticket.technician')).toContainText('Yosua Wonda');
  await shoot(page, 'live-assigned-elsewhere');
});

test('a repair cancelled on another device stops the open step', async ({ page }) => {
  await open(page, 'counter');
  await tap(page, 'repair.board.row.t-1');
  await tap(page, 'repair.ticket.action.changePrice');
  await fill(page, 'repair.price.change.description', 'LCD');
  await colleague(page, 'cancelTicket', { ticketId: 't-1', reason: 'Pelanggan batal' });
  await expect(page.getByTestId('repair.price.change.stale')).toBeVisible();
  await expect(page.getByTestId('repair.price.change.primary')).toHaveCount(0);
  await shoot(page, 'stale-cancelled');
  await tap(page, 'repair.price.change.staleBack');
  await expect(page.getByTestId('repair.ticket.status')).toContainText('Dibatalkan');
});

test('a step that raced a cancel on another device is refused with its reason', async ({
  page,
}) => {
  await open(page, 'owner');
  await tap(page, 'repair.board.row.t-1');
  await tap(page, 'repair.ticket.more.open');
  // The cancel lands just as the owner taps: the tap runs on the screen they saw.
  await page.evaluate(() => {
    const hook = (window as unknown as Record<string, { run(n: string, i: unknown): unknown }>)[
      '__repairDemoColleague'
    ];
    hook!.run('cancelTicket', { ticketId: 't-1', reason: 'Pelanggan batal', fee: 0 });
    document.querySelector<HTMLElement>('[data-testid="repair.ticket.action.claim"]')!.click();
  });
  await expect(page.getByTestId('repair.ticket.actionError').first()).toContainText(
    'Servisan ini sudah dibatalkan.',
  );
  await shoot(page, 'refused-cancelled');
});

test('a proposal answered on another device cannot be answered twice', async ({ page }) => {
  await open(page, 'counter');
  await tap(page, 'repair.board.row.t-2');
  await tap(page, 'repair.ticket.action.decidePrice');
  await colleague(page, 'declineProposal', { ticketId: 't-2', lineId: 'line-Baterai-180000' });
  await expect(page.getByTestId('repair.proposal.stale')).toBeVisible();
  await shoot(page, 'stale-proposal');
});

test('a phone handed back on another device stops the handover', async ({ page }) => {
  await open(page, 'counter');
  await tap(page, 'repair.board.views.pickup');
  await tap(page, 'repair.board.row.t-4');
  await tap(page, 'repair.ticket.action.handover');
  await tap(page, 'repair.handover.photo.press');
  const shot = (mediaId: string) => ({
    mediaId,
    sha256: 'a'.repeat(64),
    mime: 'image/jpeg',
    capturedAt: 0,
  });
  await colleague(page, 'returnDevice', {
    ticketId: 't-4',
    handoverPhoto: shot('m-handover'),
    signature: shot('m-signature'),
    checklist: ['charger', 'case'].map((item) => ({
      kind: 'accessory',
      item,
      label: null,
      done: true,
    })),
  });
  await expect(page.getByTestId('repair.handover.stale')).toBeVisible();
  await shoot(page, 'stale-handover');
  await tap(page, 'repair.handover.staleBack');
  await expect(page.getByTestId('repair.handover.discard')).toHaveCount(0);
  await expect(page.getByTestId('repair.ticket.status')).toContainText('Sudah diambil');
});

test('a down payment at intake shows what is left to pay, and opens with the ticket', async ({
  page,
}) => {
  await open(page, 'counter');
  await tap(page, 'repair.board.newIntake');
  await fill(page, 'repair.intake.customer.name', 'Ester Mandowen');
  await tap(page, 'repair.intake.primary');
  await tap(page, 'repair.intake.device.brandChoice.Oppo');
  await fill(page, 'repair.intake.device.model', 'A57');
  await tap(page, 'repair.intake.primary');
  await fill(page, 'repair.intake.condition.complaint', 'Mati total');
  await tap(page, 'repair.intake.condition.restOk');
  await tap(page, 'repair.intake.primary');
  for (let shot = 0; shot < 6; shot += 1) await tap(page, 'repair.intake.primary');
  await tap(page, 'repair.intake.primary');
  await fill(page, 'repair.intake.price.description.0', 'LCD A57');
  await fill(page, 'repair.intake.price.amount.0', '650000');
  // More than the price is refused where it is typed.
  await fill(page, 'repair.intake.price.downPaymentInput', '700000');
  await expect(page.getByText('DP-nya lebih besar dari total biaya.').first()).toBeVisible();
  await fill(page, 'repair.intake.price.downPaymentInput', '200000');
  await expect(page.getByTestId('repair.intake.price.balance')).toHaveText('Rp 450.000');
  await shoot(page, 'dp-intake-price');
  // Paid on the EDC: the step waits for its approval code.
  await tap(
    page,
    'repair.intake.price.downPaymentMethod.method.account:01920000-0000-7000-8000-00000000a002',
  );
  await page.getByTestId('repair.intake.price.downPaymentMethod').scrollIntoViewIfNeeded();
  await shoot(page, 'dp-intake-edc');
  await tap(page, 'repair.intake.primary');
  await expect(page.getByText('Isi kode approval dari mesin EDC.').first()).toBeVisible();
  await fill(page, 'repair.intake.price.downPaymentMethod.reference', '004512');
  await tap(page, 'repair.intake.primary');
  await expect(page.getByTestId('repair.intake.review.balance')).toHaveText('Rp 450.000');
  await page.getByTestId('repair.intake.review.balance').scrollIntoViewIfNeeded();
  await shoot(page, 'dp-intake-review');
  await tap(page, 'repair.intake.primary');
  await expect(page.getByTestId('repair.ticket.downPayment')).toHaveText('-Rp 200.000');
  await expect(page.getByTestId('repair.ticket.balance')).toHaveText('Rp 450.000');
  // Recorded once; the counter cannot change it afterwards.
  await expect(page.getByTestId('repair.ticket.downPayment.correct')).toHaveCount(0);
  await page.getByTestId('repair.ticket.balance').scrollIntoViewIfNeeded();
  await shoot(page, 'dp-ticket');
});

test('the counter records a down payment later, and an owner corrects it with a reason', async ({
  page,
}) => {
  await open(page, 'counter');
  await tap(page, 'repair.board.row.t-1');
  await tap(page, 'repair.ticket.downPayment.record');
  await fill(page, 'repair.downPayment.amount', '100000');
  await tap(page, 'repair.downPayment.method.method.account:01920000-0000-7000-8000-00000000a002');
  await expect(page.getByTestId('repair.downPayment.primary')).toBeDisabled();
  await fill(page, 'repair.downPayment.method.reference', '004512');
  await shoot(page, 'dp-record');
  await tap(page, 'repair.downPayment.primary');
  await expect(page.getByTestId('repair.ticket.downPayment')).toHaveText('-Rp 100.000');
  await expect(page.getByTestId('repair.ticket.downPayment.record')).toHaveCount(0);

  await open(page, 'owner');
  await tap(page, 'repair.board.row.t-2');
  await tap(page, 'repair.ticket.downPayment.correct');
  // The recorded amount is shown above; the field waits for the correct one.
  await expect(page.getByTestId('repair.downPayment.amount.field')).toHaveValue('');
  await expect(page.getByText('Isi DP yang benar dulu.')).toBeVisible();
  await fill(page, 'repair.downPayment.amount', '50000');
  await expect(page.getByText('Jumlahnya masih sama.')).toBeVisible();
  await fill(page, 'repair.downPayment.amount', '30000');
  await expect(page.getByTestId('repair.downPayment.amount.field')).toHaveValue('30.000');
  await fill(page, 'repair.downPayment.reason', 'Salah ketik, pelanggan bayar 30 ribu.');
  await shoot(page, 'dp-correct');
  await tap(page, 'repair.downPayment.primary');
  await expect(page.getByTestId('repair.ticket.downPayment')).toHaveText('-Rp 30.000');
  await page.getByTestId('repair.ticket.balance').scrollIntoViewIfNeeded();
  await shoot(page, 'dp-ticket-owner');
});

test('a cancelled servisan waiting for pickup offers no down payment', async ({ page }) => {
  for (const role of ['counter', 'owner'] as const) {
    await open(page, role);
    await tap(page, 'repair.board.views.pickup');
    await tap(page, 'repair.board.row.t-5');
    await expect(page.getByTestId('repair.ticket.status')).toContainText('Dibatalkan');
    await expect(page.getByTestId('repair.ticket.total')).toBeVisible();
    await expect(page.getByTestId('repair.ticket.downPayment.record')).toHaveCount(0);
    await page.getByTestId('repair.ticket.total').scrollIntoViewIfNeeded();
    await shoot(page, `dp-cancelled-${role}`);
  }
});

test('the counter prints the handover slip, and the next print is a reprint', async ({ page }) => {
  await open(page, 'counter');
  await tap(page, 'repair.board.views.pickup');
  await tap(page, 'repair.board.row.t-4');
  await tap(page, 'repair.ticket.action.print');
  await expect(page.getByTestId('repair.print')).toBeVisible();
  await shoot(page, 'print-step');
  const popup = page.waitForEvent('popup');
  await tap(page, 'repair.print.primary');
  const slip = await popup;
  await slip.waitForLoadState();
  await expect(slip.getByText('Nota servisan').first()).toBeVisible();
  await slip.screenshot({ path: path.join(ARTIFACTS, 'print-slip-a4.png'), fullPage: true });
  await slip.close();
  // Nothing is logged until the counter says the paper came out.
  await expect(page.getByTestId('repair.print.ask')).toBeVisible();
  await shoot(page, 'print-ask');
  await tap(page, 'repair.print.ask.cancel');
  await tap(page, 'repair.print.back');
  await tap(page, 'repair.ticket.action.print');
  await expect(page.getByTestId('repair.print.reprint')).toHaveCount(0);
  const again = page.waitForEvent('popup');
  await tap(page, 'repair.print.primary');
  await (await again).close();
  await tap(page, 'repair.print.ask.confirm');
  await expect(page.getByTestId('repair.ticket.done')).toBeVisible();
  await tap(page, 'repair.ticket.action.print');
  await expect(page.getByTestId('repair.print.reprint')).toBeVisible();
  await shoot(page, 'print-step-reprint');
});

test('the counter sets the paper once in Settings, and printing uses it', async ({ page }) => {
  await open(page, 'counter');
  await tap(page, 'ui.avatarButton');
  await tap(page, 'shell-open-settings');
  await tap(page, 'settings-print-paper');
  await expect(page.getByTestId('repair.paper.choice')).toBeVisible();
  await tap(page, 'repair.paper.choice.a5');
  await shoot(page, 'print-paper');
  await tap(page, 'repair.paper.back');
  await tap(page, 'settings-screen.back');
  await tap(page, 'repair.board.views.pickup');
  await tap(page, 'repair.board.row.t-4');
  await tap(page, 'repair.ticket.action.print');
  await expect(page.getByTestId('repair.print.paper')).toHaveText('Kertas A5');
  await shoot(page, 'print-step-paper');
  const popup = page.waitForEvent('popup');
  await tap(page, 'repair.print.primary');
  const slip = await popup;
  await slip.waitForLoadState();
  expect(await slip.content()).toContain('size: 148mm 210mm');
  await slip.close();
});

test('the owner sets what the slips print at the top', async ({ page }) => {
  await open(page, 'owner');
  await tap(page, 'ui.avatarButton');
  await tap(page, 'shell-open-settings');
  await tap(page, 'settings-print-settings');
  await expect(page.getByTestId('repair.printSettings')).toBeVisible();
  await shoot(page, 'print-settings');
  await tap(page, 'repair.printSettings.logo.pick');
  await expect(page.getByTestId('repair.printSettings.logoOnDotMatrix')).toBeVisible();
  await fill(page, 'repair.printSettings.name', 'Bolusi Cell Wamena');
  await shoot(page, 'print-settings-logo');
  await page.getByTestId('repair.printSettings.handoverTerms').scrollIntoViewIfNeeded();
  await shoot(page, 'print-settings-terms');
  await tap(page, 'repair.printSettings.primary');
  await expect(page.getByText('Tampilan nota disimpan.').first()).toBeVisible();
});

/** Presses the message button and returns the WhatsApp link it opened; nothing reaches wa.me. */
async function openedWhatsApp(page: Page): Promise<URL> {
  await page.context().route('https://wa.me/**', (route) => route.fulfill({ body: '' }));
  const request = page
    .context()
    .waitForEvent('request', (r) => r.url().startsWith('https://wa.me/'));
  await tap(page, 'repair.ticket.action.message');
  return new URL((await request).url());
}

test('the counter sees a phone nobody collected and messages the customer on WhatsApp', async ({
  page,
}) => {
  await open(page, 'counter');
  await tap(page, 'repair.board.views.uncollected');
  await expect(page.getByTestId('repair.board.row.t-7.uncollected')).toContainText(
    '72 hari belum diambil',
  );
  // Only phones past the limit: one repaired yesterday is not listed.
  await expect(page.getByTestId('repair.board.row.t-4')).toHaveCount(0);
  await shoot(page, 'uncollected-board');
  await tap(page, 'repair.board.row.t-7');
  await expect(page.getByTestId('repair.ticket.uncollected')).toBeVisible();
  await shoot(page, 'uncollected-ticket');

  const url = await openedWhatsApp(page);
  expect(`${url.host}${url.pathname}`).toBe('wa.me/6281344556677');
  expect(url.searchParams.get('text')).toContain(
    'Halo Kak Markus Yikwa, HP Oppo A57 sudah selesai diservis dan bisa diambil',
  );
  expect(url.searchParams.get('text')).toContain('No. servisan: K7Q-0006');
});

test('the counter asks the customer about a price change on WhatsApp', async ({ page }) => {
  await open(page, 'counter');
  await tap(page, 'repair.board.row.t-2');
  await expect(page.getByTestId('repair.ticket.action.message')).toHaveText('Tanya pelanggan');
  await shoot(page, 'message-price-change');
  const text = (await openedWhatsApp(page)).searchParams.get('text') ?? '';
  expect(text).toContain('- Baterai: Rp');
  expect(text).toContain('Boleh kami lanjutkan, Kak?');
});

test('a technician gets neither the not-collected list nor the message button', async ({
  page,
}) => {
  await open(page, 'technician');
  await expect(page.getByTestId('repair.board.views.uncollected')).toHaveCount(0);
  await tap(page, 'repair.board.views.pickup');
  await tap(page, 'repair.board.row.t-7');
  await expect(page.getByTestId('repair.ticket.uncollected')).toHaveCount(0);
  await expect(page.getByTestId('repair.ticket.action.message')).toHaveCount(0);
});

test('the store owner sets when a phone counts as not collected', async ({ page }) => {
  await open(page, 'storeOwner');
  await tap(page, 'ui.avatarButton');
  await tap(page, 'shell-open-settings');
  await shoot(page, 'uncollected-settings-row');
  await tap(page, 'settings-uncollected-days');
  await expect(page.getByTestId('repair.uncollected.days.field')).toHaveValue('60');
  await fill(page, 'repair.uncollected.days', '90');
  await shoot(page, 'uncollected-settings');
  await tap(page, 'repair.uncollected.primary');
  await expect(page.getByText('Batas hari disimpan.').first()).toBeVisible();
  await tap(page, 'repair.uncollected.back');
  await tap(page, 'settings-screen.back');
  // 72 days is no longer past the limit.
  await tap(page, 'repair.board.views.uncollected');
  await expect(page.getByTestId('repair.board.row.t-7')).toHaveCount(0);
});
