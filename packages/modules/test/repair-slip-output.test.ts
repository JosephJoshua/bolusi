// The shared print path a platform plugs into: what reaches `output` for a slip and for a printer's
// test page, and when the store's logo also goes to a dot-matrix as dots.
import { initI18n } from '@bolusi/i18n';
import { PAPER_PRESETS, type PaperSettings } from '@bolusi/core';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import idCatalog from '../repair/i18n/id.json' with { type: 'json' };
import enCatalog from '../repair/i18n/en.json' with { type: 'json' };
import { demoRepairRuntime } from '../src/repair/demo.js';
import { registerRepairCatalog } from '../src/repair/i18n.js';
import { DESK_PAPERS } from '../src/repair/paper.js';
import type { RepairPrinting, SlipOutput } from '../src/repair/runtime.js';
import { outputSlip, outputTestPage } from '../src/repair/slip-output.js';

beforeAll(() => {
  initI18n({ locale: 'id' });
  registerRepairCatalog({ id: idCatalog, en: enCatalog });
});

const LOGO = {
  mediaId: 'logo-1',
  sha256: 'a'.repeat(64),
  mime: 'image/png',
  type: 'image',
  sizeBytes: 100,
  capturedAt: 0,
  location: null,
  userId: 'u1',
  deviceId: 'd1',
} as const;
// A 2 x 1 picture: one black pixel, one white.
const PIXELS = { rgba: new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255]), width: 2, height: 1 };

async function setup(paper: PaperSettings, logoOnDotMatrix: boolean) {
  const runtime = demoRepairRuntime('owner');
  await runtime.run('setPrintSettings', {
    name: '',
    address: 'Jl. Trikora 12',
    phone: '0812',
    logo: LOGO,
    logoOnDotMatrix,
    intakeTerms: null,
    handoverTerms: null,
  });
  const output = vi.fn<RepairPrinting['output']>(() => Promise.resolve('done'));
  const decodeImage = vi.fn(() => Promise.resolve(PIXELS));
  const printing: RepairPrinting = {
    ...runtime.printing!,
    readPaper: () => Promise.resolve(paper),
    output,
    decodeImage,
  };
  const sent = (): SlipOutput => output.mock.calls[0]![0];
  return { runtime, printing, output, decodeImage, sent };
}

describe('outputSlip', () => {
  it('hands over the document with the page, so a text printer can render it', async () => {
    const { runtime, printing, sent } = await setup(PAPER_PRESETS.continuous_half, false);
    const ticket = (await runtime.query('listTickets', {})).rows[0]!;
    const detail = (await runtime.query('getTicket', { ticketId: ticket.id })).rows[0]!;
    expect(await outputSlip(runtime, printing, detail, 'intake', DESK_PAPERS, 'print')).toBe(
      'done',
    );
    expect(sent().document.reference).toBe(detail.ticketNumber);
    expect(sent().paper).toEqual(PAPER_PRESETS.continuous_half);
    expect(sent().html).toContain(detail.ticketNumber);
  });

  it('prints both copies, but sends the customer only theirs', async () => {
    const { runtime, printing, output } = await setup(PAPER_PRESETS.a4, false);
    const ticket = (await runtime.query('listTickets', {})).rows[0]!;
    const detail = (await runtime.query('getTicket', { ticketId: ticket.id })).rows[0]!;
    await outputSlip(runtime, printing, detail, 'intake', DESK_PAPERS, 'print');
    await outputSlip(runtime, printing, detail, 'intake', DESK_PAPERS, 'share');
    const [printed, shared] = output.mock.calls.map(([slip]) => slip);
    expect(printed!.document.copies).toEqual(['Untuk toko', 'Untuk pelanggan']);
    expect(shared!.document.copies).toEqual(['Untuk pelanggan']);
    expect(shared!.html).not.toContain('Untuk toko');
  });

  it('a print that landed but could not be logged still makes the next one a reprint', async () => {
    const { runtime, printing, output } = await setup(PAPER_PRESETS.continuous_half, false);
    const ticket = (await runtime.query('listTickets', {})).rows[0]!;
    const detail = (await runtime.query('getTicket', { ticketId: ticket.id })).rows[0]!;
    const run = runtime.run.bind(runtime);
    vi.spyOn(runtime, 'run').mockImplementation((name, input) =>
      name === 'recordSlipPrinted' ? Promise.reject(new Error('disk full')) : run(name, input),
    );
    const warn = vi.spyOn(runtime.diagnostics, 'warn');
    const before = detail.slipPrints.intake;
    expect(await outputSlip(runtime, printing, detail, 'intake', DESK_PAPERS, 'print')).toBe(
      'done',
    );
    // Not silent: the lost log is written down where a support person can find it.
    expect(warn).toHaveBeenCalledWith('printed slip could not be logged', {
      ticketId: detail.id,
      slip: 'intake',
      error: 'disk full',
    });
    await outputSlip(runtime, printing, detail, 'intake', DESK_PAPERS, 'print');
    const second = output.mock.calls[1]![0].document;
    // The lost log still counts: this is the reprint after `before + 1` earlier prints.
    expect(second.meta).toContain(before === 0 ? 'Cetak ulang' : `Cetak ulang ke-${before + 1}`);
  });

  it('prints the logo as dots on a dot-matrix only when the store asked for it', async () => {
    const on = await setup(PAPER_PRESETS.continuous_half, true);
    const ticket = (await on.runtime.query('listTickets', {})).rows[0]!;
    const detail = (await on.runtime.query('getTicket', { ticketId: ticket.id })).rows[0]!;
    await outputSlip(on.runtime, on.printing, detail, 'intake', DESK_PAPERS, 'print');
    const mono = on.sent().document.header.logo?.mono;
    expect(mono).not.toBeNull();
    expect(mono!.dots).toContain(1);
    // Never wider or taller than the room a slip gives it (2.5" x 0.5" at 120 x 72 dpi).
    expect(mono!.width).toBeLessThanOrEqual(300);
    expect(mono!.height).toBeLessThanOrEqual(36);

    const off = await setup(PAPER_PRESETS.continuous_half, false);
    await outputSlip(off.runtime, off.printing, detail, 'intake', DESK_PAPERS, 'print');
    expect(off.sent().document.header.logo?.mono).toBeNull();
    expect(off.decodeImage).not.toHaveBeenCalled();

    // Plain paper prints the picture itself; no dots needed.
    const a4 = await setup(PAPER_PRESETS.a4, true);
    await outputSlip(a4.runtime, a4.printing, detail, 'intake', DESK_PAPERS, 'print');
    expect(a4.sent().document.header.logo?.dataUri).toMatch(/^data:/);
    expect(a4.sent().document.header.logo?.mono).toBeNull();
  });
});

describe('outputTestPage', () => {
  it('prints the store header and the paper name, and logs nothing on any servisan', async () => {
    const { runtime, printing, sent } = await setup(PAPER_PRESETS.a5, false);
    const run = vi.spyOn(runtime, 'run');
    expect(await outputTestPage(runtime, printing, DESK_PAPERS)).toBe('done');
    const doc = sent().document;
    expect(doc.title).toBe('HALAMAN UJI');
    expect(doc.reference).toBe('A5');
    expect(doc.header.lines).toEqual(['Jl. Trikora 12', '0812']);
    expect(doc.blocks[0]).toMatchObject({ kind: 'ruler' });
    expect(sent().paper).toEqual(PAPER_PRESETS.a5);
    expect(run).not.toHaveBeenCalled();
  });

  it('falls back to the first paper this device can print when the saved one is not among them', async () => {
    const { runtime, printing, sent } = await setup(PAPER_PRESETS.a4_landscape, false);
    await outputTestPage(runtime, printing, DESK_PAPERS);
    expect(sent().paper).toEqual(PAPER_PRESETS.continuous_half);
  });
});
