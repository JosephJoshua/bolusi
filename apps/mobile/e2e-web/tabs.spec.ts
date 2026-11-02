/**
 * The Servisan/Kas tabs show only on a place's top level. On a phone they share the board's bottom
 * dock; a screen with a back arrow owns the bottom for its action. On a wide
 * tablet they stand down the left edge. Screenshots go to `artifacts/tabs/`.
 *
 * HONEST CEILING: a browser approximation. The real font scale and the system bars need the device.
 */
import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

const ARTIFACTS = path.join(__dirname, 'artifacts', 'tabs');
const PHONE = { width: 360, height: 760 };
const SIDEWAYS = { width: 1280, height: 800 };

const tap = (page: Page, testID: string) => page.getByTestId(testID).first().click();
const shoot = (page: Page, name: string) =>
  page.screenshot({ path: path.join(ARTIFACTS, `${name}.png`) });

async function open(page: Page, frame = ''): Promise<void> {
  await page.goto(`/?screen=repair&state=owner${frame}`);
  await expect(page.getByTestId('repair.board')).toBeVisible();
}

/** Text 1.3x larger, as a large system font would draw it (RN-web always reports 1). */
async function largeFont(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('div, span, input'))) {
      const holdsText = Array.from(el.childNodes).some(
        (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== '',
      );
      if (!holdsText && el.tagName !== 'INPUT') continue;
      const style = getComputedStyle(el);
      el.style.fontSize = `${parseFloat(style.fontSize) * 1.3}px`;
      if (style.lineHeight.endsWith('px'))
        el.style.lineHeight = `${parseFloat(style.lineHeight) * 1.3}px`;
    }
  });
}

test('on a phone the tabs sit in the board dock, and leave a servisan page to its own action', async ({
  page,
}) => {
  await page.setViewportSize(PHONE);
  await open(page);
  const tabs = page.getByTestId('shell-tabs');
  await expect(tabs).toBeVisible();
  // Under the board's action, in the same dock.
  const action = (await page.getByTestId('repair.board.newIntake').boundingBox())!;
  expect((await tabs.boundingBox())!.y).toBeGreaterThan(action.y + action.height);
  await shoot(page, 'phone-board');
  await largeFont(page);
  await shoot(page, 'phone-board-font13');

  await open(page);
  await tap(page, 'repair.board.row.t-1');
  await expect(page.getByTestId('repair.ticket')).toBeVisible();
  await expect(page.getByTestId('shell-tabs')).toHaveCount(0);
  await shoot(page, 'phone-ticket');

  await tap(page, 'repair.ticket.more.open');
  await shoot(page, 'phone-ticket-lainnya');
});

test('on a wide tablet the tabs stand down the left edge, beside an open servisan', async ({
  page,
}) => {
  await page.setViewportSize(SIDEWAYS);
  await open(page, '&frame=tablet');
  await tap(page, 'repair.board.row.t-1');
  const rail = (await page.getByTestId('shell-tabs').boundingBox())!;
  const board = (await page.getByTestId('repair.board').boundingBox())!;
  expect(rail.x + rail.width).toBeLessThanOrEqual(board.x + 1);
  await shoot(page, 'tablet-sideways-ticket');

  await tap(page, 'shell-tabs.kas');
  await expect(page.getByTestId('money.kas')).toBeVisible();
  await shoot(page, 'tablet-sideways-kas');
});
