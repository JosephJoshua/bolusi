/**
 * The repair flows driven through the real screens in a browser, over the in-memory demo runtime
 * (`src/web/repair-demo.ts`): each test taps through a flow the way a counter person or technician
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

/** The keys of a ReorderableList's rows, top to bottom. */
async function order(page: Page, listTestID: string): Promise<string[]> {
  const prefix = `${listTestID}.item.`;
  const ids = await page
    .locator(`[data-testid^="${prefix}"]`)
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid') ?? ''));
  return ids.map((id) => id.slice(prefix.length));
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
  await tap(page, 'repair.intake.device.brandChoice.Oppo');
  await fill(page, 'repair.intake.device.model', 'A57');
  await tap(page, 'repair.intake.primary');
  await fill(page, 'repair.intake.condition.complaint', 'Mati total');
  await tap(page, 'repair.intake.condition.restOk');
  await tap(page, 'repair.intake.primary');
  // The primary action walks round the phone, one missing shot per tap.
  for (let shot = 0; shot < 6; shot += 1) await tap(page, 'repair.intake.primary');
  await expect(page.getByTestId('repair.intake.primary')).toHaveText('Lanjut');
  await tap(page, 'repair.intake.primary');
  await fill(page, 'repair.intake.price.description.0', 'LCD A57');
  await fill(page, 'repair.intake.price.amount.0', '650000');
  await expect(page.getByTestId('repair.intake.price.amount.0.field')).toHaveValue('650.000');
  await tap(page, 'repair.intake.primary');
  await expect(page.getByTestId('repair.intake.review.total')).toHaveText('Rp 650.000');
  await shoot(page, 'intake-review');
  await tap(page, 'repair.intake.primary');
  await expect(page.getByTestId('repair.ticket.customer')).toHaveText('Ester Mandowen');
  // Unassigned, picking a technician is the counter's next step.
  await expect(page.getByTestId('repair.ticket.action.assign')).toBeVisible();
  await shoot(page, 'intake-ticket');
  // The picker lists the store's technicians with their loads, not an error.
  await tap(page, 'repair.ticket.action.assign');
  await expect(page.locator('[data-testid^="repair.assign.row."]').first()).toBeVisible();
  await expect(page.getByTestId('repair.assign.items.error')).toHaveCount(0);
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

test('handover needs the photo and the signature, then the phone is returned', async ({ page }) => {
  await open(page, 'counter');
  await tap(page, 'repair.board.views.pickup');
  await tap(page, 'repair.board.row.t-4');
  await tap(page, 'repair.ticket.action.handover');
  await expect(page.getByTestId('repair.handover.primary')).toBeDisabled();
  await tap(page, 'repair.handover.photo.press');
  await tap(page, 'repair.handover.signature.press');
  await tap(page, 'repair.handover.primary');
  await expect(page.getByTestId('repair.ticket.photos.strip.signature')).toBeVisible();
  await shoot(page, 'handover-done');
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
  });
  await expect(page.getByTestId('repair.handover.stale')).toBeVisible();
  await shoot(page, 'stale-handover');
  await tap(page, 'repair.handover.staleBack');
  await expect(page.getByTestId('repair.handover.discard')).toHaveCount(0);
  await expect(page.getByTestId('repair.ticket.status')).toContainText('Sudah diambil');
});
