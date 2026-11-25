/**
 * Perlu dicek, an owner's first place: the requests waiting on them, each opening on its answer,
 * and back from that servisan returning here. Screenshots go to `artifacts/attention/`.
 *
 * HONEST CEILING: a browser approximation. The real font scale and the system bars need the device.
 */
import type { Page } from '@playwright/test';

import { expect, shoot as check, test } from './qa';

const shoot = (page: Page, name: string) => check(page, 'attention', name);

async function open(page: Page, role: string, frame = ''): Promise<void> {
  await page.goto(`/?screen=repair&state=${role}${frame}`);
  await expect(page.getByTestId('attention')).toBeVisible();
}

test('an owner opens on Perlu dicek, answers a request on its servisan, and comes back', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 760 });
  await open(page, 'owner');
  await expect(page.getByTestId('shell-tabs.attention')).toBeVisible();
  const request = page.locator('[data-testid^="attention.request."]').first();
  await expect(request).toBeVisible();
  await shoot(page, 'phone-attention');

  await request.click();
  await expect(page.getByTestId('repair.ticket.approval.primary')).toBeVisible();
  await expect(page.getByTestId('shell-tabs')).toHaveCount(0);
  await shoot(page, 'phone-answer');

  await page.getByTestId('repair.ticket.approval.primary').click();
  await expect(page.getByTestId('repair.ticket')).toBeVisible();
  await shoot(page, 'phone-answered');
  await page.getByTestId('repair.ticket.back').first().click();
  await expect(page.getByTestId('attention')).toBeVisible();
  await shoot(page, 'phone-back');
});

test('a counter has no Perlu dicek and opens on Servisan', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 760 });
  await page.goto('/?screen=repair&state=counter');
  await expect(page.getByTestId('repair.board')).toBeVisible();
  await expect(page.getByTestId('shell-tabs.attention')).toHaveCount(0);
});

test('on a wide tablet Perlu dicek sits beside the rail', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page, 'owner', '&frame=tablet');
  await shoot(page, 'tablet-attention');
});
