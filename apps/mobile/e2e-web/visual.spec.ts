/**
 * The react-native-web visual + interaction suite (task 116).
 *
 * It navigates the exported web build to each screen-state (`?screen=&state=`), makes REAL role/text
 * assertions about the rendered DOM (never merely "a page loaded" — T-14), captures a screenshot per
 * state into `artifacts/`, and drives five genuine interactions (PIN key press, ID↔EN language
 * toggle, discard ConfirmSheet, the running shell's Settings entry point — task 124 — and the note
 * body wrapping instead of clipping — task 128). Every state
 * also asserts the mandatory "RNW browser approximation —
 * NOT device-verified" label is present, so no artifact can be mistaken for the device lane.
 *
 * HONEST CEILING: this is a browser approximation. It does not replace the device gates (27a/27b) or
 * native E2E (117); it is a fast visual feedback loop below them.
 */
import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import * as tokens from '@bolusi/ui/tokens';

const ARTIFACTS = path.join(__dirname, 'artifacts');
const APPROX_LABEL = 'RNW browser approximation — NOT device-verified';

/** The distinctively-named seed user (mirrors `src/web/seed.ts` PROBE_USER_NAME) — the data probe. */
const PROBE_USER = 'Andi Pratama';

async function open(page: Page, screen: string, state: string): Promise<void> {
  await page.goto(`/?screen=${screen}&state=${state}`);
  await expect(page.getByTestId(`web-harness-${screen}-${state}`)).toBeVisible();
  // The label is on every screen — assert it every time (the artifact-labelling requirement).
  await expect(page.getByTestId('rnw-approx-label').getByText(APPROX_LABEL)).toBeVisible();
}

async function shoot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join(ARTIFACTS, `${name}.png`), fullPage: true });
}

/**
 * The four-states-plus screenshot matrix. Each row asserts a screen-SPECIFIC testID AND (where a
 * stable label exists) an i18n text, so a blank/stub page would red — that is the falsification T-14
 * demands, wired into the committed suite rather than left to a one-off.
 */
interface Row {
  readonly screen: string;
  readonly state: string;
  readonly testId: string;
  readonly text?: string;
}

const MATRIX: readonly Row[] = [
  // Switcher — the four §5 states + the data-backed happy path + the idle lock.
  { screen: 'switcher', state: 'loading', testId: 'switcher-screen', text: 'Siapa yang pakai?' },
  { screen: 'switcher', state: 'empty', testId: 'switcher-empty' },
  { screen: 'switcher', state: 'error', testId: 'switcher-error' },
  { screen: 'switcher', state: 'unauthorized', testId: 'switcher-unauthorized' },
  { screen: 'switcher', state: 'ready', testId: 'switcher-screen', text: PROBE_USER },
  { screen: 'switcher', state: 'lock', testId: 'switcher-lock-banner' },

  // PIN — the pad's real states.
  { screen: 'pin', state: 'entry', testId: 'pin-pad', text: PROBE_USER },
  { screen: 'pin', state: 'wrong', testId: 'pin-pad.message' },
  { screen: 'pin', state: 'delayed', testId: 'pin-pad.message' },
  { screen: 'pin', state: 'lockedOut', testId: 'pin-locked-out' },
  { screen: 'pin', state: 'needsFirstPin', testId: 'pin-needs-first', text: 'Belum ada PIN' },

  // First PIN for a colleague with none, and the owner's staff PIN list (with a locked colleague).
  { screen: 'pin-setup', state: 'interactive', testId: 'pin-setup-pad' },
  { screen: 'staff-pins', state: 'ready', testId: 'staff-pin-list' },
  { screen: 'staff-pins', state: 'many', testId: 'staff-pin-search' },
  { screen: 'staff-pins', state: 'unauthorized', testId: 'staff-pin-screen' },
  { screen: 'switcher', state: 'many', testId: 'switcher-search' },

  // Settings — the language surface (interaction covered separately).
  { screen: 'settings', state: 'ready', testId: 'settings-screen', text: 'Bahasa' },

  // Sync-status — healthy / saved-here / photos-pending / offline / actively-syncing / needs-attention.
  { screen: 'sync-status', state: 'allSent', testId: 'sync-reassurance' },
  { screen: 'sync-status', state: 'savedHere', testId: 'sync-counter-ops' },
  // task 147: ops sent, 3 photos queued. The headline reads "Foto & video belum terkirim" (Photos and videos not sent
  // yet), NOT "Semua sudah terkirim" — the exact string the browser lane now witnesses over the counter.
  {
    screen: 'sync-status',
    state: 'photosPending',
    testId: 'sync-counter-media',
    text: 'Foto & video belum terkirim',
  },
  { screen: 'sync-status', state: 'offline', testId: 'sync-reassurance' },
  // task 144 item 5: the loop actively pushing — the fifth chip state, previously never screenshotted.
  // Keyed on the syncing-specific headline ("Sedang mengirim"), so a title regression (the 126/147
  // bug class) reds this row rather than passing on a bare testID.
  {
    screen: 'sync-status',
    state: 'syncing',
    testId: 'sync-reassurance',
    text: 'Sedang mengirim',
  },
  { screen: 'sync-status', state: 'attention', testId: 'sync-rejected-section' },
  {
    screen: 'sync-status',
    state: 'unrecognised',
    testId: 'sync-unrecognised',
    text: 'HP ini perlu didaftarkan ulang',
  },
  // The §8.4-item-4 disclosure (task 130), probed on the sheet itself: the section is already
  // visible in `attention`. The code and the server's words stay behind "Lihat detail untuk laporan".
  {
    screen: 'sync-status',
    state: 'rejectedDetail',
    testId: 'sync-rejected-detail-op_9f3a',
  },

  // Enrollment — steps + revoked banner.
  { screen: 'enrollment', state: 'credentials', testId: 'enroll-step-credentials' },
  { screen: 'enrollment', state: 'confirm', testId: 'enroll-step-confirm' },
  { screen: 'enrollment', state: 'done', testId: 'enroll-step-done' },
  { screen: 'enrollment', state: 'revoked', testId: 'enroll-revoked-banner' },
  {
    screen: 'enrollment',
    state: 'reenrolWithChanges',
    testId: 'enroll-unsynced',
    text: 'Perubahan yang belum terkirim',
  },

  // Capture (media) — camera is a labelled placeholder, never a faked photo.
  { screen: 'capture', state: 'loading', testId: 'capture-loading' },
  {
    screen: 'capture',
    state: 'unauthorized',
    testId: 'capture-unauthorized',
    text: 'Kamera belum diizinkan',
  },
  { screen: 'capture', state: 'ready', testId: 'capture-web-placeholder' },
  { screen: 'capture', state: 'error', testId: 'capture-failed' },
  { screen: 'capture', state: 'lowStorage', testId: 'capture-refused' },

  // Signature (media) — loading / unauthorized / ready / error.
  { screen: 'signature', state: 'loading', testId: 'signature-loading' },
  { screen: 'signature', state: 'unauthorized', testId: 'signature-unauthorized' },
  { screen: 'signature', state: 'ready', testId: 'signature-pad' },
  { screen: 'signature', state: 'error', testId: 'signature-failed' },

  // App-mode — the full RootNavigator gate over the demo seed. The shell asserts the notes list
  // HEADER in Indonesian ("Catatan", not the "Title" key-fallback): the web entry must register the
  // module catalog after initI18n (task 122), and this row is what goes red if it stops.
  { screen: 'app', state: 'switcher', testId: 'switcher-screen', text: PROBE_USER },
  { screen: 'app', state: 'shell', testId: 'bolusi-app-shell', text: 'Catatan' },
];

for (const row of MATRIX) {
  test(`renders ${row.screen}/${row.state}`, async ({ page }) => {
    await open(page, row.screen, row.state);
    await expect(page.getByTestId(row.testId)).toBeVisible();
    if (row.text !== undefined) {
      await expect(page.getByText(row.text, { exact: true }).first()).toBeVisible();
    }
    await shoot(page, `${row.screen}-${row.state}`);
  });
}

// ── DATA PROBE: the fake feed drives the render (not a page that renders empty regardless) ─────────

test('switcher/ready renders every seeded user (data feeds the DOM)', async ({ page }) => {
  await open(page, 'switcher', 'ready');
  for (const name of [PROBE_USER, 'Siti Rahayu', 'Budi Santoso']) {
    await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
  }
});

test('switcher/empty renders the empty state, not a crash and not a user card', async ({
  page,
}) => {
  await open(page, 'switcher', 'empty');
  await expect(page.getByTestId('switcher-empty')).toBeVisible();
  // The seeded names are absent when the roster is empty — the render tracks the (empty) data.
  await expect(page.getByText(PROBE_USER, { exact: true })).toHaveCount(0);
});

// ── INTERACTION 1: the PIN pad responds to a key press, and completes on the 6th digit ────────────

test('PIN pad responds to key presses and fires its one egress on the 6th digit', async ({
  page,
}) => {
  await open(page, 'pin', 'interactive');
  const dot0 = page.getByTestId('pin-pad.dot.0');
  const emptyFill = 'rgb(244, 244, 245)';
  const filledFill = 'rgb(24, 24, 27)';

  await expect(dot0).toHaveCSS('background-color', emptyFill);
  await page.getByTestId('pin-pad.key.1').click();
  // The first dot fills — the browser-rendered pad genuinely reacted to the tap.
  await expect(dot0).toHaveCSS('background-color', filledFill);

  // The entered value's ONE egress: onComplete on the 6th digit. The PIN itself is never rendered.
  await expect(page.getByTestId('pin-submitted')).toHaveCount(0);
  for (const key of ['2', '3', '4', '5', '6']) {
    await page.getByTestId(`pin-pad.key.${key}`).click();
  }
  await expect(page.getByTestId('pin-submitted')).toBeVisible();
});

// ── INTERACTION 2: the ID↔EN language toggle switches every label live ────────────────────────────

test('Settings language toggle switches labels between Indonesian and English', async ({
  page,
}) => {
  await open(page, 'settings', 'ready');
  await expect(page.getByText('Bahasa', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Language', { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('settings-locale-id.check')).toBeVisible();

  await page.getByTestId('settings-locale-en').click();

  await expect(page.getByText('Language', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Bahasa', { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('settings-locale-en.check')).toBeVisible();
  await shoot(page, 'settings-ready-en');
});

// ── INTERACTION 3: the discard ConfirmSheet opens on a back press over typed input ────────────────

test('Enrollment back over typed input opens the real discard ConfirmSheet', async ({ page }) => {
  await open(page, 'enrollment', 'credentials');
  await expect(page.getByTestId('enroll-discard-sheet')).toHaveCount(0);

  await page.getByTestId('enroll-identifier.field').fill('owner@maju');
  await page.getByTestId('harness-enroll-back').click();

  await expect(page.getByTestId('enroll-discard-sheet')).toBeVisible();
  await shoot(page, 'enrollment-discard-sheet');

  // Cancel dismisses it — the real handler, not a stub.
  await page.getByTestId('enroll-discard-sheet.cancel').click();
  await expect(page.getByTestId('enroll-discard-sheet')).toHaveCount(0);
});

// ── INTERACTION 4: Settings is REACHABLE from the running shell (task 124) ────────────────────────

test('the running shell opens Settings from its header — the language escape hatch is reachable', async ({
  page,
}) => {
  // The browser twin of `test/live-shell-settings.test.tsx`. `app/shell` is the FULL `App` over the
  // demo seed, so this clicks the same node a thumb hits on a device. Until task 124 nothing in
  // shipping source produced `route: 'settings'` and this click had no target to find.
  await open(page, 'app', 'shell');
  await expect(page.getByTestId('settings-screen')).toHaveCount(0);

  // Settings sits in the avatar's account menu.
  await page.getByTestId('ui.avatarButton').click();
  await page.getByTestId('shell-open-settings').click();

  await expect(page.getByTestId('settings-screen')).toBeVisible();
  // REAL content, not merely a testID: the active-locale marker plus the device-identity readout the
  // screen exists to show ("so the shop can read its own device's identity to an owner over the
  // phone"). A blank Settings would satisfy the testID and fail these.
  await expect(page.getByTestId('settings-locale-id.check')).toBeVisible();
  await expect(page.getByText('dev_7Q2K9Z4M', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Servis Ponsel Maju', { exact: true }).first()).toBeVisible();
  await shoot(page, 'app-settings');
});

test('an owner renames this phone from Settings', async ({ page }) => {
  await open(page, 'app', 'shell');
  await page.getByTestId('ui.avatarButton').click();
  await page.getByTestId('shell-open-settings').click();
  await page.getByTestId('settings-device-rename').scrollIntoViewIfNeeded();
  await shoot(page, 'app-settings-device');
  await page.getByTestId('settings-device-rename').click();
  const field = page.getByTestId('rename-device-name.field');
  await expect(field).toBeFocused();
  await field.fill('HP Kasir depan');
  await shoot(page, 'app-rename-device');
  await page.getByTestId('rename-device-save').click();
  await expect(page.getByTestId('settings-device-name')).toHaveText('HP Kasir depan');
  await page.getByTestId('settings-device-name').scrollIntoViewIfNeeded();
  await shoot(page, 'app-settings-renamed');
});

test('a new phone opens on its setup: permissions, paper with a test page, then what is ready', async ({
  page,
}) => {
  await open(page, 'app', 'setup');
  await expect(page.getByTestId('setup.permissions')).toBeVisible();
  // The camera can still be asked; notifications were refused, so only the OS settings help.
  await expect(page.getByTestId('setup.notifications.settings')).toBeVisible();
  await shoot(page, 'app-setup-permissions');
  await page.getByTestId('setup.camera.allow').click();
  await expect(page.getByTestId('setup.camera.allowed')).toBeVisible();
  await shoot(page, 'app-setup-permissions-allowed');

  await page.getByTestId('setup.next').click();
  await expect(page.getByTestId('setup.paper')).toBeVisible();
  // A size none of the presets fits is typed in.
  await page.getByTestId('setup.paper.choice.custom').click();
  await expect(page.getByTestId('setup.paper.size.range')).toBeVisible();
  await shoot(page, 'app-setup-paper-custom');
  await page.getByTestId('setup.paper.choice.a5').click();
  await shoot(page, 'app-setup-paper');

  await page.getByTestId('setup.next').click();
  await expect(page.getByTestId('setup.done')).toBeVisible();
  await expect(page.getByTestId('setup.done.paper')).toContainText('A5');
  await expect(page.getByTestId('setup.basics')).toBeVisible();
  await shoot(page, 'app-setup-done');

  // Starting leaves the setup for the home screen, and it does not come back by itself.
  await page.getByTestId('setup.start').click();
  await expect(page.getByTestId('setup.done')).toHaveCount(0);
  await expect(page.getByTestId('setup.permissions')).toHaveCount(0);

  // Settings opens it again.
  await page.getByTestId('ui.avatarButton').click();
  await page.getByTestId('shell-open-settings').click();
  await page.getByTestId('settings-setup').scrollIntoViewIfNeeded();
  await expect(page.getByTestId('settings-setup')).toBeVisible();
  await shoot(page, 'app-setup-settings');
  await page.getByTestId('settings-setup').click();
  await expect(page.getByTestId('setup.permissions')).toBeVisible();

  // What the store still lacks leads to the setting that fills it.
  await page.getByTestId('setup.next').click();
  await page.getByTestId('setup.next').click();
  await page.getByTestId('setup.basics.logo').click();
  await expect(page.getByTestId('repair.printSettings')).toBeVisible();
});

// ── INTERACTION 5: the note BODY wraps instead of clipping (task 128) ─────────────────────────────
//
// THE ONLY LANE THAT CAN SEE THIS. The unit lanes read declared props and styles; nothing there
// measures a rendered box, which is why a body clipping at ~35 characters sat behind green tests.
// Here the field is real DOM with a real height: RNW renders `multiline` as a <textarea> and a
// single-line field as an <input>, and the measured height separates "wraps" from "one strip".
// This is the QA repro path walked end to end — app shell → note row → Ubah → the body field.

test('the note editor body wraps a long note instead of clipping it to one line', async ({
  page,
}) => {
  await open(page, 'app', 'shell');
  await page.getByTestId('notes.list.row.note-demo-1').click();
  await page.getByTestId('notes.detail.edit').click();

  const body = page.getByTestId('notes.editor.body.field');
  const title = page.getByTestId('notes.editor.title.field');
  await expect(body).toBeVisible();

  // The element RNW chose IS the wrap: <textarea> soft-wraps, <input> does not, at any width.
  expect(await body.evaluate((el) => el.tagName)).toBe('TEXTAREA');
  // The title is set once at creation (01 §9) and stays a one-line control — the variant is additive.
  expect(await title.evaluate((el) => el.tagName)).toBe('INPUT');

  // A note longer than the ~35 characters the single-line field showed. Typed through the real
  // onChangeText path, so this is the running screen, not a seeded string.
  const longNote =
    'Sisa 4 karung di gudang belakang. Pesan ulang sebelum akhir minggu, lalu cek rak atas ' +
    'dan catat nomor seri unit yang ditinggal pelanggan kemarin sore.';
  await body.fill(longNote);
  await expect(body).toHaveValue(longNote);

  // MEASURED, not declared: the box is several lines of `type.body` tall. The defect rendered this
  // whole note inside one 56 dp strip, so a >= 2-line box is the separation. The threshold reads the
  // token, so it tracks the type scale instead of a hardcoded lineHeight (task 146 item 10).
  const box = await body.boundingBox();
  expect(box).not.toBeNull();
  const twoLines = 2 * tokens.type.body.lineHeight;
  expect(box!.height).toBeGreaterThan(twoLines);
  // And the text genuinely occupies more than one line inside it (scrollHeight tracks wrapped rows).
  expect(await body.evaluate((el) => el.scrollHeight)).toBeGreaterThan(twoLines);

  await shoot(page, 'notes-editor-long-body');
});
