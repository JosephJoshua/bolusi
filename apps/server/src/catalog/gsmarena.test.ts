// The parsers over trimmed copies of GSMArena's markup (unquoted attributes, `<br>` inside
// names, entities and all), plus the checks that keep a hostile page from steering the crawl.
import { describe, expect, test } from 'vitest';

import {
  isCrawlablePath,
  kindFromTitle,
  parseBrandPage,
  parseBrands,
  parseModelPage,
  yearFromTitle,
} from './gsmarena.js';

const MAKERS = `
<div class="st-text">
<table>
<tr><td><a href=acer-phones-59.php>Acer<br><span>100 devices</span></a></td>
<td><a href="samsung-phones-9.php">Samsung<br><span>1384 devices</span></a></td></tr>
<tr><td><a href=at&amp;t-phones-57.php>AT&amp;T<br><span>4 devices</span></a></td>
<td><a href="https://evil.example/x-phones-1.php">Evil<br><span>1 devices</span></a></td></tr>
</table>
</div>
<div class="sidebar"><a href="apple-phones-48.php">Apple</a></div>`;

const BRAND_PAGE = `
<div class="makers">
<ul>
<li><a href="samsung_galaxy_a56-13603.php"><img src="https://fdn2.gsmarena.com/vv/bigpic/samsung-galaxy-a56.jpg" title="Samsung Galaxy A56 Android smartphone. Announced Mar 2025. Features 6.7&#8243; display, Exynos 1580 chipset."><strong><span>Galaxy A56</span></strong></a></li>
<li><a href=samsung_galaxy_tab_s10_fe-13711.php><img src=https://fdn2.gsmarena.com/vv/bigpic/samsung-galaxy-tab-s10-fe.jpg title="Samsung Galaxy Tab S10 FE Android tablet. Announced Apr 2025."><strong><span>Galaxy Tab S10<br>FE</span></strong></a></li>
<li><a href="samsung_galaxy_watch8-13900.php"><img src="https://fdn2.gsmarena.com/vv/bigpic/w8.jpg" title="Samsung Galaxy Watch8 Wear OS smartwatch. Announced Jul 2025."><strong><span>Galaxy Watch8</span></strong></a></li>
<li><a href="samsung_galaxy_s25-13610.php"><img src="https://evil.example/s25.jpg" title="Samsung Galaxy S25 Android smartphone. Not announced yet."><strong><span>Galaxy S25</span></strong></a></li>
<li><a href="../etc/passwd">x</a></li>
</ul>
</div>
<div class="review-nav-v2">
<div class="nav-pages">
<strong>1</strong>
<a href="samsung-phones-f-9-0-p3.php">3</a>
<a href="samsung-phones-f-9-0-p2.php">2</a>
<a class="prevnextbutton" href="samsung-phones-f-9-0-p2.php" title="Next page">&#9658;</a>
<a href="https://evil.example/samsung-phones-f-9-0-p4.php">4</a>
</div>
</div>`;

const MODEL_PAGE = `
<h1 class="specs-phone-name-title" data-spec="modelname">Samsung Galaxy A56</h1>
<table><tr><td class="ttl"><a href="glossary.php3?term=phone-life-cycle">Announced</a></td>
<td class="nfo" data-spec="year">2025, March 02</td></tr>
<tr><td class="ttl">Status</td><td class="nfo" data-spec="status">Available. Released 2025, March 12</td></tr>
<tr><td class="ttl"><a href="glossary.php3?term=models">Models</a></td>
<td class="nfo" data-spec="models">SM-A566B, SM-A566B/DS, SM-A566E, SM-A566B</td></tr></table>
<table><tr><th rowspan="5" scope="row">Display</th>
<td class="ttl"><a href="glossary.php3?term=display-type">Type</a></td>
<td class="nfo" data-spec="displaytype">Super AMOLED, 120Hz, 1200 nits (HBM)</td></tr>
<tr><td class="ttl"><a href="#">Size</a></td>
<td class="nfo" data-spec="displaysize">6.7 inches, 110.2 cm<sup>2</sup> (~87.5% screen-to-body ratio)</td></tr>
<tr><td class="ttl"><a href="#">Resolution</a></td>
<td class="nfo" data-spec="displayresolution">1080 x 2340 pixels, 19.5:9 ratio (~385 ppi density)</td></tr>
<tr><td class="ttl">&nbsp;</td><td class="nfo" data-spec="displayother"></td></tr></table>
<table><tr><td class="ttl">OS</td><td class="nfo" data-spec="os">Android 15, up to 6 major Android upgrades, One UI 7</td></tr>
<tr><td class="ttl">Chipset</td><td class="nfo" data-spec="chipset">Exynos 1580 (4 nm)</td></tr></table>
<table><tr><td class="ttl">Card slot</td><td class="nfo" data-spec="memoryslot">No</td></tr>
<tr><td class="ttl">Internal</td><td class="nfo" data-spec="internalmemory">128GB 8GB RAM, 256GB 8GB RAM, 256GB 12GB RAM</td></tr></table>
<table><tr><td class="ttl">SIM</td><td class="nfo" data-spec="sim">Nano-SIM + Nano-SIM + eSIM</td></tr>
<tr><td class="ttl">USB</td><td class="nfo" data-spec="usb">USB Type-C 2.0, OTG</td></tr></table>
<table><tr><td class="ttl">Type</td><td class="nfo" data-spec="batdescription1">Li-Ion 5000 mAh, non-removable</td></tr>
<tr><td class="ttl"><a href="glossary.php3?term=battery-charging">Charging</a></td>
<td class="nfo">45W wired, PD3.0, 65% in 30 min</td></tr></table>
<table><tr><td class="ttl">Colors</td><td class="nfo" data-spec="colors">Awesome Black, Awesome Graphite, Awesome Light Gray, Awesome Pink</td></tr></table>`;

test('brands come from the brand table only, with names before their counts', () => {
  expect(parseBrands(MAKERS)).toEqual([
    { path: 'acer-phones-59.php', name: 'Acer' },
    { path: 'samsung-phones-9.php', name: 'Samsung' },
  ]);
});

describe('a brand listing page', () => {
  const page = parseBrandPage(BRAND_PAGE, 'Samsung');

  test('reads each model with its kind, year and photo', () => {
    expect(page.models).toEqual([
      {
        id: 13603,
        brand: 'Samsung',
        name: 'Galaxy A56',
        kind: 'phone',
        announcedYear: 2025,
        pagePath: 'samsung_galaxy_a56-13603.php',
        photoUrl: 'https://fdn2.gsmarena.com/vv/bigpic/samsung-galaxy-a56.jpg',
      },
      {
        id: 13711,
        brand: 'Samsung',
        name: 'Galaxy Tab S10 FE',
        kind: 'tablet',
        announcedYear: 2025,
        pagePath: 'samsung_galaxy_tab_s10_fe-13711.php',
        photoUrl: 'https://fdn2.gsmarena.com/vv/bigpic/samsung-galaxy-tab-s10-fe.jpg',
      },
      expect.objectContaining({ id: 13900, kind: 'watch' }),
      // A photo on another host is dropped, not fetched.
      expect.objectContaining({ id: 13610, announcedYear: null, photoUrl: null }),
    ]);
  });

  test('lists the other pages once, in order, on GSMArena only', () => {
    expect(page.pages).toEqual(['samsung-phones-f-9-0-p2.php', 'samsung-phones-f-9-0-p3.php']);
  });

  test('a page without the listing reads as empty', () => {
    expect(parseBrandPage('<html>Too many requests</html>', 'Samsung')).toEqual({
      models: [],
      pages: [],
    });
  });
});

test('a model page gives its unique maker codes and year', () => {
  expect(parseModelPage(MODEL_PAGE)).toEqual({
    modelCodes: ['SM-A566B', 'SM-A566B/DS', 'SM-A566E'],
    announcedYear: 2025,
    specs: {
      displayType: 'Super AMOLED, 120Hz, 1200 nits (HBM)',
      displaySize: '6.7 inches',
      displayResolution: '1080 x 2340 pixels',
      os: 'Android 15',
      chipset: 'Exynos 1580 (4 nm)',
      internalMemory: '128GB 8GB RAM, 256GB 8GB RAM, 256GB 12GB RAM',
      cardSlot: 'No',
      battery: 'Li-Ion 5000 mAh',
      charging: '45W wired, PD3.0, 65% in 30 min',
      usb: 'USB Type-C 2.0, OTG',
      sim: 'Nano-SIM + Nano-SIM + eSIM',
      colors: 'Awesome Black, Awesome Graphite, Awesome Light Gray, Awesome Pink',
    },
  });
  expect(parseModelPage('<p>nothing</p>')).toEqual({
    modelCodes: [],
    announcedYear: null,
    specs: {},
  });
});

test('a very long spec cell is clipped, and a data-spec name never matches a longer one', () => {
  const long = 'x'.repeat(400);
  const specs = parseModelPage(
    `<td class="nfo" data-spec="os2">iOS</td><td class="nfo" data-spec="chipset">${long}</td>`,
  ).specs;
  expect(specs.os).toBeUndefined();
  expect(specs.chipset).toHaveLength(300);
  expect(specs.chipset!.endsWith('…')).toBe(true);
});

test('titles give the kind and announced year', () => {
  expect(kindFromTitle('Apple iPad Air 13 (2025) iPadOS tablet.')).toBe('tablet');
  expect(kindFromTitle('Apple Watch Series 10 watchOS smartwatch.')).toBe('watch');
  expect(kindFromTitle('Nokia 105 (2023) Feature phone.')).toBe('phone');
  expect(yearFromTitle('Nokia 3310 Feature phone. Announced 2000.')).toBe(2000);
  expect(yearFromTitle('Xiaomi Redmi Note 13 Android smartphone. Announced Sep. 2023.')).toBe(2023);
  expect(yearFromTitle('Rumored, not announced yet.')).toBeNull();
});

test('only GSMArena page shapes may be fetched', () => {
  expect(isCrawlablePath('makers.php3')).toBe(true);
  expect(isCrawlablePath('samsung-phones-9.php')).toBe(true);
  expect(isCrawlablePath('samsung-phones-f-9-0-p2.php')).toBe(true);
  expect(isCrawlablePath('samsung_galaxy_a56-13603.php')).toBe(true);
  expect(isCrawlablePath('../etc/passwd')).toBe(false);
  expect(isCrawlablePath('https://evil.example/a-1.php')).toBe(false);
  expect(isCrawlablePath('samsung_galaxy_a56-pictures-13603.php')).toBe(false);
});
