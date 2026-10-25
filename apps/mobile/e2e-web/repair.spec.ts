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

type Role = 'owner' | 'counter' | 'technician';

async function open(page: Page, role: Role): Promise<void> {
  await page.goto(`/?screen=repair&state=${role}`);
  await expect(page.getByTestId('repair.board')).toBeVisible();
}

const tap = (page: Page, testID: string) => page.getByTestId(testID).first().click();
const fill = (page: Page, testID: string, text: string) =>
  page.getByTestId(`${testID}.field`).fill(text);

async function shoot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join(ARTIFACTS, `${name}.png`) });
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
  await expect(page.getByTestId('repair.ticket.handoverPhotos')).toBeVisible();
  await shoot(page, 'handover-done');
});
