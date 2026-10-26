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
<td class="nfo" data-spec="models">SM-A566B, SM-A566B/DS, SM-A566E, SM-A566B</td></tr></table>`;

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
  });
  expect(parseModelPage('<p>nothing</p>')).toEqual({ modelCodes: [], announcedYear: null });
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
