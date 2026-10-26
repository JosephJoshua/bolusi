// A realistic repair-store history for the first-sync benchmark: tickets written through the real
// repair commands on one counter device, with the mix of journeys a busy store sees (returning
// customers, technician quote proposals, parts waits, cancellations, corrected customer details).
import type { SignedOperation } from '@bolusi/schemas';
import { mulberry32, type Prng } from '@bolusi/test-support';
import { readWireOps } from '@bolusi/test-support/chaos';

import { intake, openRepairHarness, type RepairHarness } from '../test/support/repair-harness.js';

const FIRST_NAMES = [
  'Yohanis',
  'Maria',
  'Yakobus',
  'Agustina',
  'Markus',
  'Elisabeth',
  'Petrus',
  'Fransiska',
  'Daniel',
  'Ruth',
  'Andreas',
  'Selfina',
  'Simon',
  'Yuliana',
  'Musa',
  'Dorkas',
  'Budi',
  'Siti',
  'Ahmad',
  'Dewi',
];
const LAST_NAMES = [
  'Wenda',
  'Kogoya',
  'Tabuni',
  'Wonda',
  'Mandacan',
  'Rumbiak',
  'Kambu',
  'Yoku',
  'Ayomi',
  'Saragih',
  'Sinaga',
  'Pratama',
  'Wibowo',
  'Kurniawan',
  'Hutagalung',
  'Mofu',
  'Rumere',
  'Iba',
  'Krey',
  'Sawaki',
];
const DEVICES = [
  ['Samsung', 'Galaxy A14'],
  ['Samsung', 'Galaxy A05s'],
  ['Oppo', 'A17'],
  ['Oppo', 'Reno 8'],
  ['Vivo', 'Y17s'],
  ['Xiaomi', 'Redmi Note 12'],
  ['Xiaomi', 'Redmi 13C'],
  ['Realme', 'C55'],
  ['Infinix', 'Hot 40'],
  ['Apple', 'iPhone 11'],
  ['Apple', 'iPhone XR'],
  ['Nokia', '105'],
] as const;
const COLORS = ['Hitam', 'Putih', 'Biru', 'Hijau', 'Ungu', 'Emas'];
const COMPLAINTS = [
  'Layar retak, sentuhan tidak responsif',
  'Tidak bisa dicas, port longgar',
  'Baterai cepat habis dan kembung',
  'Mati total setelah jatuh ke air',
  'Speaker tidak bunyi saat telepon',
  'Kamera belakang buram',
  'Lupa pola kunci, minta reset',
  'Sinyal hilang, tidak baca SIM',
];
const PARTS = [
  ['LCD original', 650_000],
  ['Baterai', 250_000],
  ['Konektor cas', 120_000],
  ['Speaker', 90_000],
  ['Kamera belakang', 300_000],
  ['Flex on/off', 80_000],
] as const;

export interface StoreHistoryOptions {
  readonly days: number;
  readonly ticketsPerDay: number;
  readonly seed: number;
  /** Tickets still in the shop at the end, in every stage a busy counter sees. Default none. */
  readonly openTickets?: number;
  /** Called after each simulated day, for progress output on long runs. */
  readonly onDay?: (day: number) => void;
}

export interface StoreHistory {
  /** Every op the store wrote, in the order the server would have accepted them. */
  readonly ops: readonly SignedOperation[];
  readonly tickets: number;
  readonly writer: RepairHarness;
}

const pick = <T>(prng: Prng, items: readonly T[]): T => items[Math.floor(prng() * items.length)]!;

/** Syllables for clan and given names beyond the common lists, so the name vocabulary keeps growing. */
const SYLLABLES = [
  'ya',
  'ko',
  'bu',
  'we',
  'nda',
  'ru',
  'mi',
  'ta',
  'se',
  'lo',
  'ma',
  'ni',
  'ka',
  'pa',
];

/** About half the customers have a third, less common name, as a real store's book does. */
function customerName(prng: Prng): string {
  const name = `${pick(prng, FIRST_NAMES)} ${pick(prng, LAST_NAMES)}`;
  if (prng() < 0.5) return name;
  const length = 2 + Math.floor(prng() * 2);
  const rare = Array.from({ length }, () => pick(prng, SYLLABLES)).join('');
  return `${name} ${rare[0]!.toUpperCase()}${rare.slice(1)}`;
}

const digits = (prng: Prng, count: number): string =>
  Array.from({ length: count }, () => Math.floor(prng() * 10)).join('');

/** Write `days × ticketsPerDay` ticket journeys and return the resulting signed op stream. */
export async function writeStoreHistory(options: StoreHistoryOptions): Promise<StoreHistory> {
  const prng = mulberry32(options.seed);
  const writer = await openRepairHarness(options.seed);
  const customers: string[] = [];
  let tickets = 0;

  for (let day = 0; day < options.days; day += 1) {
    for (let i = 0; i < options.ticketsPerDay; i += 1) {
      await writeTicketJourney(writer, prng, customers);
      tickets += 1;
    }
    options.onDay?.(day + 1);
  }
  for (let i = 0; i < (options.openTickets ?? 0); i += 1) {
    await writeOpenTicket(writer, prng, customers);
    tickets += 1;
  }

  return { ops: await readWireOps(writer.db), tickets, writer };
}

async function openStoreTicket(h: RepairHarness, prng: Prng, customers: string[]) {
  const returning = customers.length > 0 && prng() < 0.35;
  const [brand, model] = pick(prng, DEVICES);
  const [part, price] = pick(prng, PARTS);
  const opened = (await h.run(
    'openTicket',
    intake(h, {
      customer: returning
        ? { customerId: pick(prng, customers) }
        : {
            name: customerName(prng),
            phone: `08${digits(prng, 10)}`,
          },
      device: { brand, model, color: pick(prng, COLORS), imei: digits(prng, 15) },
      complaint: pick(prng, COMPLAINTS),
      quoteLines: [
        { kind: 'part', description: part, amount: price },
        { kind: 'labour', description: 'Jasa pasang', amount: 50_000 },
      ],
    }),
    h.cashierId,
  )) as { ticketId: string; customerId: string };
  if (!returning) customers.push(opened.customerId);
  return opened;
}

/** A ticket still in the shop: waiting, with a technician, waiting for parts or for pickup. */
async function writeOpenTicket(h: RepairHarness, prng: Prng, customers: string[]): Promise<void> {
  const { ticketId } = await openStoreTicket(h, prng, customers);
  const stage = prng();
  if (stage < 0.3) return;
  await h.run('assignTechnician', { ticketId, technicianId: h.technicianId }, h.cashierId);
  if (stage < 0.45) return;
  await h.run('startWork', { ticketId, beforePhotos: [h.photo(5)] }, h.technicianId);
  if (prng() < 0.3) {
    await h.run(
      'proposeQuoteChange',
      { ticketId, kind: 'part', description: 'Baterai', amount: 250_000, reason: 'Ikut rusak' },
      h.technicianId,
    );
  }
  if (stage < 0.7) return;
  if (stage < 0.8) {
    await h.run(
      'markWaitingForParts',
      { ticketId, note: 'Tunggu part dari Jayapura' },
      h.technicianId,
    );
    return;
  }
  await h.run(
    'markRepaired',
    { ticketId, note: 'Sudah dites', afterPhotos: [h.photo(6)] },
    h.technicianId,
  );
}

async function writeTicketJourney(
  h: RepairHarness,
  prng: Prng,
  customers: string[],
): Promise<void> {
  const opened = await openStoreTicket(h, prng, customers);
  const { ticketId } = opened;

  if (prng() < 0.25) {
    await h.run('assignTechnician', { ticketId, technicianId: h.technicianId }, h.cashierId);
  }
  await h.run('startWork', { ticketId, beforePhotos: [h.photo(5)] }, h.technicianId);
  if (prng() < 0.2) {
    await h.run(
      'markWaitingForParts',
      { ticketId, note: 'Tunggu part dari Jayapura' },
      h.technicianId,
    );
    await h.run('startWork', { ticketId }, h.technicianId);
  }
  if (prng() < 0.3) {
    const [extra, extraPrice] = pick(prng, PARTS);
    const { lineId } = (await h.run(
      'proposeQuoteChange',
      { ticketId, kind: 'part', description: extra, amount: extraPrice, reason: 'Ikut rusak' },
      h.technicianId,
    )) as { lineId: string };
    if (prng() < 0.75) {
      await h.run('applyProposal', { ticketId, lineId, customerAgreed: true }, h.cashierId);
    } else {
      await h.run('declineProposal', { ticketId, lineId, note: 'Pelanggan tolak' }, h.cashierId);
    }
  }
  if (prng() < 0.08) {
    await h.run('cancelTicket', { ticketId, reason: 'Pelanggan batal' }, h.storeOwnerId);
  } else {
    await h.run(
      'markRepaired',
      { ticketId, note: 'Sudah dites', afterPhotos: [h.photo(6)] },
      h.technicianId,
    );
  }
  await h.run(
    'returnDevice',
    { ticketId, handoverPhoto: h.photo(7), signature: h.photo(8) },
    h.cashierId,
  );
  if (prng() < 0.03) {
    await h.run(
      'correctCustomerDetails',
      {
        customerId: opened.customerId,
        name: customerName(prng),
        phone: `08${digits(prng, 10)}`,
      },
      h.cashierId,
    );
  }
}
