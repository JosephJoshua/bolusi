/**
 * The phone screens on a tablet, in a browser over the demo runtime: upright a record's halves sit
 * side by side and capture tiles stay thumbnail-sized; turned sideways a list stays beside the record
 * open from it. A phone keeps one column. Screenshots go to `artifacts/tablet/`.
 *
 * HONEST CEILING: a browser approximation. Rotation, the status bar and the real font scale still
 * need the Android tablet run.
 */
import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import * as tokens from '@bolusi/ui/tokens';

const ARTIFACTS = path.join(__dirname, 'artifacts', 'tablet');
const UPRIGHT = { width: 800, height: 1280 };
const SIDEWAYS = { width: 1280, height: 800 };

const tap = (page: Page, testID: string) => page.getByTestId(testID).first().click();
const shoot = (page: Page, name: string) =>
  page.screenshot({ path: path.join(ARTIFACTS, `${name}.png`) });

async function open(page: Page, role: 'owner' | 'counter', phone = false): Promise<void> {
  await page.goto(`/?screen=repair&state=${role}${phone ? '' : '&frame=tablet'}`);
  await expect(page.getByTestId('repair.board')).toBeVisible();
}

async function openFromMenu(page: Page, item: 'parts' | 'purchasing'): Promise<void> {
  await open(page, 'owner');
  await page.getByLabel('Menu akun').first().click();
  await tap(page, `shell-open-${item}`);
}

/** `#rrggbb` as the browser reports a computed colour. */
function rgb(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}

async function width(page: Page, testID: string): Promise<number> {
  return (await page.getByTestId(testID).first().boundingBox())!.width;
}

test('upright, the servisan page puts its photos and history beside the record', async ({
  page,
}) => {
  await page.setViewportSize(UPRIGHT);
  await open(page, 'counter');
  await tap(page, 'repair.board.row.t-1');
  await expect(page.getByTestId('repair.ticket.columns.two')).toBeVisible();
  const summary = (await page.getByTestId('repair.ticket.summary').boundingBox())!;
  const history = (await page.getByTestId('repair.ticket.history').boundingBox())!;
  expect(history.x).toBeGreaterThan(summary.x + summary.width);
  await shoot(page, 'ticket-upright');
});

test('upright, the handover keeps the photo and signature thumbnail-sized beside the bill', async ({
  page,
}) => {
  await page.setViewportSize(UPRIGHT);
  await open(page, 'counter');
  await tap(page, 'repair.board.views.pickup');
  await tap(page, 'repair.board.row.t-4');
  await tap(page, 'repair.ticket.action.handover');
  await expect(page.getByTestId('repair.handover.columns.two')).toBeVisible();
  expect(await width(page, 'repair.handover.photo')).toBeLessThanOrEqual(
    tokens.size.tileTarget * 1.3,
  );
  expect(await width(page, 'repair.handover.signature')).toBeLessThanOrEqual(
    tokens.size.tileTarget * 1.3,
  );
  await shoot(page, 'handover-upright');
});

test('upright, Kas puts what is owed beside the drawer', async ({ page }) => {
  await page.setViewportSize(UPRIGHT);
  await open(page, 'owner');
  await tap(page, 'shell-tabs.kas');
  await expect(page.getByTestId('money.kas.columns.two')).toBeVisible();
  await shoot(page, 'kas-upright');
});

test('sideways, a part opens beside the parts list and the list stays', async ({ page }) => {
  await page.setViewportSize(SIDEWAYS);
  await openFromMenu(page, 'parts');
  await expect(page.getByTestId('inventory.split')).toBeVisible();
  await expect(page.getByTestId('inventory.noPartOpen')).toBeVisible();
  const row = page.locator('[data-testid^="inventory.list.row."]').first();
  await row.click();
  await expect(page.getByTestId('inventory.part.summary')).toBeVisible();
  await expect(page.getByTestId('inventory.list.items')).toBeVisible();
  // The open part's row is marked.
  await expect(row).toHaveCSS('background-color', rgb(tokens.color.infoBg));
  // The list is in view, so the part has no back arrow.
  await expect(page.getByTestId('inventory.part.back')).toHaveCount(0);
  await shoot(page, 'parts-sideways');
});

test('sideways, an order opens beside the orders list', async ({ page }) => {
  await page.setViewportSize(SIDEWAYS);
  await openFromMenu(page, 'purchasing');
  await expect(page.getByTestId('purchasing.noOrderOpen')).toBeVisible();
  await page.locator('[data-testid^="purchasing.orders.row."]').first().click();
  await expect(page.getByTestId('purchasing.order.summary')).toBeVisible();
  await expect(page.getByTestId('purchasing.orders.new')).toBeVisible();
  await expect(page.getByTestId('purchasing.order.back')).toHaveCount(0);
  await shoot(page, 'purchasing-sideways');
});

test('a phone keeps one column', async ({ page }) => {
  await open(page, 'counter', true);
  await tap(page, 'repair.board.row.t-1');
  await expect(page.getByTestId('repair.ticket.columns')).toBeVisible();
  await expect(page.getByTestId('repair.ticket.columns.two')).toHaveCount(0);
});
