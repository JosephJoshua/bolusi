// The WhatsApp messages the counter sends a customer: who gets which, the number WhatsApp wants, and
// the words, which carry what the customer owes and never anything the slip keeps back.
import { initI18n, setLocale } from '@bolusi/i18n';
import { beforeAll, describe, expect, it } from 'vitest';

import idCatalog from '../repair/i18n/id.json' with { type: 'json' };
import enCatalog from '../repair/i18n/en.json' with { type: 'json' };
import {
  customerMessage,
  customerMessageKind,
  whatsAppNumber,
  whatsAppUrl,
} from '../src/repair/customer-message.js';
import { registerRepairCatalog } from '../src/repair/i18n.js';
import { whatsAppAppUrl } from '../src/repair/whatsapp.js';

import { line, sampleTicket } from './support/repair-rows.js';

beforeAll(() => {
  initI18n({ locale: 'id' });
  registerRepairCatalog({ id: idCatalog, en: enCatalog });
});

const COUNTER = { intake: true, quoteChange: true };
const TECHNICIAN = { intake: false, quoteChange: false };

const repaired = sampleTicket({
  outcome: 'repaired',
  quoteTotal: 950_000,
  pendingProposals: 0,
  reduced: 0,
  quoteLines: [
    line({ id: 'l1' }),
    line({ id: 'l2', kind: 'labour', description: 'Jasa pasang', amount: 100_000 }),
  ],
});

describe('the number WhatsApp opens', () => {
  it('turns any Indonesian way of writing it into 62…', () => {
    expect(whatsAppNumber('0812-3456-7890')).toBe('6281234567890');
    expect(whatsAppNumber('+62 812 3456 7890')).toBe('6281234567890');
    expect(whatsAppNumber('6281234567890')).toBe('6281234567890');
    expect(whatsAppNumber('81234567890')).toBe('6281234567890');
    expect(whatsAppNumber('+62 0812 3456 7890')).toBe('6281234567890');
  });

  it('keeps a foreign number in its own country', () => {
    // A Chinese mobile starts with 8 after its country code; it must not turn Indonesian.
    expect(whatsAppNumber('+86 138 0013 8000')).toBe('8613800138000');
    expect(whatsAppNumber('0061 412 345 678')).toBe('61412345678');
  });

  it('has none for a missing or impossible number', () => {
    expect(whatsAppNumber(null)).toBeNull();
    expect(whatsAppNumber('12345')).toBeNull();
    // No country is written and it is not an Indonesian number.
    expect(whatsAppNumber('4155552671')).toBeNull();
    expect(whatsAppNumber('0812 3456 7890 1234 5')).toBeNull();
  });

  it('carries the message in the link, encoded', () => {
    expect(whatsAppUrl('6281234567890', 'Halo Kak, total: Rp 1.000 & DP')).toBe(
      'https://wa.me/6281234567890?text=Halo%20Kak%2C%20total%3A%20Rp%201.000%20%26%20DP',
    );
  });

  it('opens the app itself on a phone, so a phone without WhatsApp fails instead of opening a browser', () => {
    expect(whatsAppAppUrl('6281234567890', 'Halo Kak, total: Rp 1.000 & DP')).toBe(
      'whatsapp://send?phone=6281234567890&text=Halo%20Kak%2C%20total%3A%20Rp%201.000%20%26%20DP',
    );
  });
});

describe('which message the counter can send', () => {
  it('tells the customer a repaired or cancelled phone can be collected', () => {
    expect(customerMessageKind(repaired, COUNTER)).toBe('ready');
    expect(customerMessageKind({ ...repaired, outcome: 'cancelled' }, COUNTER)).toBe('ready');
  });

  it('asks about a price change that waits for the customer, before anything else', () => {
    expect(customerMessageKind({ ...repaired, pendingProposals: 1 }, COUNTER)).toBe('priceChange');
    expect(
      customerMessageKind({ ...repaired, outcome: 'in_repair', pendingProposals: 2 }, COUNTER),
    ).toBe('priceChange');
  });

  it('offers nothing while the work goes on, after handover, without a number, or to a technician', () => {
    expect(customerMessageKind({ ...repaired, outcome: 'in_repair' }, COUNTER)).toBeNull();
    expect(customerMessageKind({ ...repaired, location: 'returned' }, COUNTER)).toBeNull();
    expect(customerMessageKind({ ...repaired, customerPhone: null }, COUNTER)).toBeNull();
    expect(customerMessageKind(repaired, TECHNICIAN)).toBeNull();
    expect(customerMessageKind({ ...repaired, pendingProposals: 1 }, TECHNICIAN)).toBeNull();
  });
});

describe('the words', () => {
  it('says the phone is ready, where, its number and the total', () => {
    expect(customerMessage('ready', repaired, 'Bolusi Cell Sorong')).toBe(
      [
        'Halo Kak Yohanes, HP Samsung Galaxy A15 sudah selesai diservis dan bisa diambil di Bolusi Cell Sorong.',
        'No. servisan: K7Q-0042',
        'Total: Rp 950.000',
        'Terima kasih.',
      ].join('\n'),
    );
  });

  it('takes a down payment off what is left to pay', () => {
    const text = customerMessage('ready', { ...repaired, downPayment: 200_000 }, null);
    expect(text).toContain('bisa diambil.');
    expect(text).toContain('DP: Rp 200.000\nSisa bayar: Rp 750.000');
  });

  it('gives a cancelled phone’s fee, or the down payment to return when the fee is less', () => {
    const cancelled = { ...repaired, outcome: 'cancelled' as const, cancelFee: 50_000 };
    const text = customerMessage('ready', cancelled, 'Bolusi Cell');
    expect(text).toContain('servisan HP Samsung Galaxy A15 dibatalkan');
    expect(text).toContain('Biaya pembatalan: Rp 50.000');
    expect(text).not.toContain('Total');
    const free = customerMessage(
      'ready',
      { ...cancelled, cancelFee: 0, downPayment: 100_000 },
      null,
    );
    expect(free).not.toContain('Biaya pembatalan');
    expect(free).toContain('DP dikembalikan: Rp 100.000');
  });

  it('lists each change waiting for the customer and the total if they agree', () => {
    const waiting = {
      ...repaired,
      outcome: 'in_repair' as const,
      pendingProposals: 1,
      quoteLines: [
        ...repaired.quoteLines,
        line({ id: 'l3', description: 'Ganti baterai', amount: 300_000, status: 'proposed' }),
        line({ id: 'l4', description: 'Kabel fleksibel', amount: 50_000, status: 'declined' }),
      ],
    };
    expect(customerMessage('priceChange', waiting, 'Bolusi Cell')).toBe(
      [
        'Halo Kak Yohanes, ada perubahan biaya untuk servisan HP Samsung Galaxy A15.',
        'No. servisan: K7Q-0042',
        '- Ganti baterai: Rp 300.000',
        'Total jadi Rp 1.250.000.',
        'Boleh kami lanjutkan, Kak?',
      ].join('\n'),
    );
  });

  it('never carries the unlock code', () => {
    for (const kind of ['ready', 'priceChange'] as const) {
      expect(customerMessage(kind, repaired, null)).not.toContain('975319');
    }
  });

  it('follows the app’s language like the slips', () => {
    setLocale('en');
    try {
      expect(customerMessage('ready', repaired, null)).toContain(
        'Hi Yohanes, your Samsung Galaxy A15 is repaired and ready to collect.',
      );
    } finally {
      setLocale('id');
    }
  });
});

describe('the status link', () => {
  const SITE = 'https://bolusi.id';
  const inRepair = { ...repaired, outcome: 'in_repair' as const };

  it('is what the counter sends while the phone is in the store and nothing else is due', () => {
    expect(customerMessageKind(inRepair, COUNTER, SITE)).toBe('statusLink');
    // Ready or waiting for a yes: those messages come first, and carry the link too.
    expect(customerMessageKind(repaired, COUNTER, SITE)).toBe('ready');
    expect(customerMessageKind({ ...inRepair, pendingProposals: 1 }, COUNTER, SITE)).toBe(
      'priceChange',
    );
    // Nothing to send without a site, a code, a number or the counter's job.
    expect(customerMessageKind(inRepair, COUNTER, null)).toBeNull();
    expect(customerMessageKind({ ...inRepair, statusCode: null }, COUNTER, SITE)).toBeNull();
    expect(customerMessageKind({ ...inRepair, customerPhone: null }, COUNTER, SITE)).toBeNull();
    expect(customerMessageKind(inRepair, TECHNICIAN, SITE)).toBeNull();
    expect(customerMessageKind({ ...inRepair, location: 'returned' }, COUNTER, SITE)).toBeNull();
  });

  it('says the phone was received and where to follow it', () => {
    expect(customerMessage('statusLink', inRepair, 'Bolusi Cell Sorong', SITE)).toBe(
      [
        'Halo Kak Yohanes, HP Samsung Galaxy A15 sudah kami terima untuk diservis di Bolusi Cell Sorong.',
        'No. servisan: K7Q-0042',
        'Pantau statusnya di sini: https://bolusi.id/c/K7M2Q9XA4BRS',
        'Terima kasih.',
      ].join('\n'),
    );
    expect(customerMessage('ready', repaired, null, SITE)).toContain(
      'Pantau statusnya di sini: https://bolusi.id/c/K7M2Q9XA4BRS',
    );
    expect(customerMessage('ready', repaired, null)).not.toContain('/c/');
  });
});
