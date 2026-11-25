/**
 * What every browser test of the phone screens shares: `test` draws the page at the project's font
 * scale, and `shoot` saves a screenshot and fails the test when the screen breaks a layout rule of
 * the design guide (packages/test-support/src/layout-audit.ts). So every screenshot is checked.
 */
import path from 'node:path';

import { test as base, type Page } from '@playwright/test';

import {
  expectCleanLayout,
  fontScaleScript,
  type LayoutRule,
} from '@bolusi/test-support/layout-audit';
import * as tokens from '@bolusi/ui/tokens';

export { expect } from '@playwright/test';

export const test = base.extend<{ fontScale: number }>({
  fontScale: [1, { option: true }],
  page: async ({ page, fontScale }, use) => {
    await page.addInitScript(fontScaleScript(fontScale));
    await use(page);
  },
});

const LADDER = Object.values(tokens.type).map((style) => style.fontSize);

export interface ShootOptions {
  /** Rules a deliberate state breaks on purpose, said where it is used. */
  readonly allow?: readonly LayoutRule[];
  readonly fullPage?: boolean;
}

/** Save `artifacts/<project>/<folder>/<name>.png` and check the screen's layout. */
export async function shoot(
  page: Page,
  folder: string,
  name: string,
  options: ShootOptions = {},
): Promise<void> {
  const info = test.info();
  const fontScale = (info.project.use as { fontScale?: number }).fontScale ?? 1;
  await page.screenshot({
    path: path.join(__dirname, 'artifacts', info.project.name, folder, `${name}.png`),
    animations: 'disabled',
    fullPage: options.fullPage ?? false,
  });
  await expectCleanLayout(
    page,
    {
      ladder: LADDER,
      fontScale,
      minTarget: tokens.size.control,
      primaryFill: tokens.color.primary,
      skip: options.allow ?? [],
    },
    `${folder}/${name}`,
  );
}
