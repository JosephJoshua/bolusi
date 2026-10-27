// Times the servisan board in the browser harness at a busy store's volume, with the CPU throttled
// to roughly a cheap Android phone. A measuring tool, not a test: run it before and after a change.
//
//   pnpm --filter @bolusi/mobile build:web
//   node e2e-web/static-server.mjs dist &                     # serves on :4599
//   node e2e-web/board-perf.mjs [tickets=5000] [throttle=6]
//
// Each step reports how long its input took (typing ten keys at 120 ms each takes 1.2 s on a page
// that keeps up), how long after that the page settled (its last DOM change, after a quiet second),
// and the main-thread time spent in long tasks (over 50 ms), which is what makes typing stutter.
import { chromium } from '@playwright/test';

const tickets = Number(process.argv[2] ?? 5000);
const throttle = Number(process.argv[3] ?? 6);
const base = process.env['BASE_URL'] ?? 'http://localhost:4599';
const QUIET_MS = 1000;

// CHROMIUM_PATH points at a browser other than the one this Playwright version downloads.
const browser = await chromium.launch(
  process.env['CHROMIUM_PATH'] ? { executablePath: process.env['CHROMIUM_PATH'] } : {},
);
const page = await browser.newPage({ viewport: { width: 412, height: 915 } });
const cdp = await page.context().newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });

// Long tasks and the last DOM change, recorded in the page from the start.
await page.addInitScript(() => {
  const perf = { long: 0, lastChange: 0 };
  window.__perf = perf;
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) perf.long += entry.duration;
  }).observe({ type: 'longtask', buffered: true });
  const watch = () =>
    new MutationObserver(() => {
      perf.lastChange = performance.now();
    }).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  if (document.documentElement) watch();
  else document.addEventListener('DOMContentLoaded', watch);
});

const now = () => page.evaluate(() => performance.now());
const longSoFar = () => page.evaluate(() => window.__perf?.long ?? 0);
/** Page time from `since` to the last DOM change, once the page has been quiet for a second. */
async function settled(since) {
  for (;;) {
    const { lastChange, at } = await page.evaluate(() => ({
      lastChange: window.__perf.lastChange,
      at: performance.now(),
    }));
    if (at - Math.max(lastChange, since) >= QUIET_MS) return Math.max(0, lastChange - since);
    await page.waitForTimeout(100);
  }
}

const results = {};
/** `act` may return the page time its input ended; settling is measured from then. */
async function step(name, act) {
  const long0 = await longSoFar();
  const started = Date.now();
  const inputEnd = await act();
  const inputMs = Date.now() - started;
  const since = inputEnd ?? (await now());
  const acting = inputEnd === undefined ? Date.now() - started : 0;
  const settle = await settled(since);
  results[name] = {
    inputMs,
    settleMs: Math.round(acting + settle),
    longTaskMs: Math.round((await longSoFar()) - long0),
  };
}

const row = (id) => page.locator(`[data-testid="repair.board.row.${id}"]`);
const search = page.locator('[data-testid="repair.board.search.field"]');

await step('load', async () => {
  await page.goto(`${base}/?screen=repair&state=counter&tickets=${tickets}`);
  await row('t-1').waitFor({ timeout: 120_000 });
});

// A counter typing a name with a typo at a normal pace (about 8 keys a second).
await step('type "maria wnda" at 120 ms/key', async () => {
  await search.click();
  await search.pressSequentially('maria wnda', { delay: 120 });
  return now();
});
await step('clear search', async () => {
  await search.fill('');
  await row('t-1').waitFor();
});
// The first search above also built the search index; this one shows typing on a warm index.
await step('type "redmi note" again at 120 ms/key', async () => {
  await search.pressSequentially('redmi note', { delay: 120 });
  return now();
});
await step('clear search again', async () => {
  await search.fill('');
  await row('t-1').waitFor();
});

// The returned history, scrolled ten pages deep, then one change from a colleague's device.
await step('scroll returned view 10 pages', async () => {
  await page.click('[data-testid="repair.board.views.returned"]');
  await row('h-0').waitFor();
  const list = page.locator('[data-testid="repair.board.items"]');
  for (let i = 0; i < 10; i += 1) {
    await list.evaluate((el) => {
      const scroller = el.scrollHeight > el.clientHeight ? el : el.firstElementChild;
      scroller.scrollTop = scroller.scrollHeight;
    });
    await page.waitForTimeout(300);
  }
  return now();
});
results['rows rendered after scrolling'] = await page
  .locator('[data-testid^="repair.board.row."][data-testid$=".amount"]')
  .count();
await step("a colleague's change while scrolled", async () => {
  await page.evaluate(() =>
    window.__repairDemoColleague.run('assignTechnician', {
      ticketId: 't-1',
      technicianId: 'u-yosua',
    }),
  );
  return now();
});

await step('open a ticket', async () => {
  await page.click('[data-testid="repair.board.views.active"]');
  await row('t-2').click();
  await page.locator('[data-testid="repair.board.search.field"]').waitFor({ state: 'detached' });
});

results['heap MB'] = await page.evaluate(() =>
  Math.round(performance.memory.usedJSHeapSize / 1_048_576),
);
console.log(JSON.stringify({ tickets, throttle, ...results }, null, 2));
await browser.close();
