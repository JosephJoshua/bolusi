// Renders the app icons, splash image and Windows .ico from the logo SVGs in assets/brand.
// Run after changing a logo SVG: `pnpm brand:assets`. The PNG/ICO outputs are committed, so
// nothing here runs during a normal build. Set CHROMIUM_PATH if Playwright's own browser is
// not installed (cloud containers: /opt/pw-browsers/chromium).
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(join(root, 'apps/desktop/package.json'))('@playwright/test');

const brand = (name) => readFileSync(join(root, 'assets/brand', name), 'utf8');
const inner = (svg) => svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
const mark = inner(brand('bolusi-mark-dark.svg'));
const icon = inner(brand('bolusi-icon.svg'));
// The mark's drawn box in its own coordinates (see the viewBox of bolusi-mark.svg).
const MARK = { x: 92, y: 58, w: 324, h: 400 };

/** The mark, `height` units tall, centred on a 512 square. */
function centred(height, body = mark) {
  const k = height / MARK.h;
  const tx = 256 - (MARK.x + MARK.w / 2) * k;
  const ty = 256 - (MARK.y + MARK.h / 2) * k;
  return `<g transform="translate(${tx} ${ty}) scale(${k})">${body}</g>`;
}
const square = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${body}</svg>`;
// Windows and the web draw icons as given, so those get the rounded tile; iOS and Android
// mask the full-bleed square themselves.
const rounded = square(
  `<clipPath id="r"><rect width="512" height="512" rx="104"/></clipPath><g clip-path="url(#r)">${icon}</g>`,
);
// Below 32 px the 60-unit stroke falls under two pixels and smears, so the smallest sizes get
// a heavier cut of the same mark.
const roundedSmall = rounded
  .replace('stroke-width="60"', 'stroke-width="80"')
  .replace('r="38"', 'r="46"');
const gradient = icon.replace(/<g fill="none"[\s\S]*$/, '');
const white = mark.replaceAll(/#[0-9A-F]{6}/gi, '#FFFFFF');

const mobile = (name) => join(root, 'apps/mobile/assets', name);
const desktop = (name) => join(root, 'apps/desktop/build', name);
const outputs = [
  [mobile('icon.png'), square(icon), 1024],
  // Android keeps the middle 66 of 108 dp, so the mark sits well inside that circle.
  [mobile('adaptive-icon.png'), square(centred(256)), 1024],
  [mobile('adaptive-icon-background.png'), square(gradient), 1024],
  [mobile('adaptive-icon-monochrome.png'), square(centred(256, white)), 1024],
  // Android 12+ crops the launch image to a circle, so the mark keeps clear of the corners.
  [mobile('splash-icon.png'), square(centred(300)), 1024],
  [mobile('favicon.png'), rounded, 48],
  [desktop('icon.png'), rounded, 512],
];
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
);
const page = await browser.newPage();
async function render(svg, size) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<style>*{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
  );
  return page.locator('svg').screenshot({ omitBackground: true });
}

for (const [file, svg, size] of outputs) writeFileSync(file, await render(svg, size));

// An .ico is a directory of PNG images, one per size (Vista and later read PNG entries).
const images = [];
for (const size of ICO_SIZES) images.push(await render(size < 32 ? roundedSmall : rounded, size));
const header = Buffer.alloc(6 + 16 * images.length);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);
let offset = header.length;
images.forEach((png, i) => {
  const at = 6 + 16 * i;
  const size = ICO_SIZES[i];
  header.writeUInt8(size === 256 ? 0 : size, at);
  header.writeUInt8(size === 256 ? 0 : size, at + 1);
  header.writeUInt16LE(1, at + 4);
  header.writeUInt16LE(32, at + 6);
  header.writeUInt32LE(png.length, at + 8);
  header.writeUInt32LE(offset, at + 12);
  offset += png.length;
});
writeFileSync(desktop('icon.ico'), Buffer.concat([header, ...images]));

await browser.close();
console.log(`wrote ${outputs.length} PNGs and icon.ico`);
