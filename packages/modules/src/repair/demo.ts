/**
 * A `RepairRuntime` over in-memory demo tickets for the browser harnesses (the phone screens on
 * react-native-web, the desktop app's demo mode), the repair twin of `demoNotesRuntime`. The real
 * runtime needs SQLite, so the harnesses render the REAL repair screens over this fake. Commands
 * mutate the demo data and notify, so the flows (intake, start, repaired, price change, handover)
 * genuinely move a ticket along. Dev tooling only: no shipping screen imports it.
 *
 * Photos resolve to a labelled grey placeholder image, never anything that looks like a real photo.
 */
import { FuzzyIndex, type PaperSettings } from '@bolusi/core';
import type { AnyMediaRef, MediaRef, ThumbnailRef, VideoRef } from '@bolusi/schemas';

import { APPROVAL_PERMISSION } from '../approvals/constants.js';
import { demoApprovals } from '../approvals/demo.js';
import { demoInventoryRuntime } from '../inventory/demo.js';
import { INVENTORY_PERMISSION } from '../inventory/constants.js';
import { MONEY_PERMISSION } from '../money/constants.js';
import { demoMoneyLedger, demoQris } from '../money/demo.js';
import {
  DEFAULT_UNCOLLECTED_DAYS,
  IN_PROGRESS_OUTCOMES,
  REPAIR_PERMISSION,
  ownershipVideoSlot,
  type RepairOutcome,
} from './constants.js';
import { partsInWork } from './flows.js';
import { catalogModelSearch } from './model-picker.js';
import {
  DEFAULT_INTAKE_OPTIONS,
  NOTHING_HIDDEN,
  handoverProblem,
  needsOwnershipVideo,
  recordRepairTypes,
  storeIntakeOptions,
  type HandoverCheck,
  type IntakeOption,
  type IntakeOptionSettings,
} from './intake-options.js';
import type { PrintSettings, QuoteLineRow, TicketDetailRow, TicketPhotoRow } from './queries.js';
import { standardCancelFee } from './queries.js';
import type { RepairPrinting, RepairRuntime } from './runtime.js';
import { amountOwed } from './flows.js';
import { REPAIR_REFUSALS, claimProblem } from './rules.js';
import {
  demoFindDeviceModel,
  demoModelPhoto,
  demoSearchDeviceModels,
} from './phone-catalog-demo.js';

/** The phone harness's fixed clock, so its screenshots never change. */
export const DEMO_NOW = Date.UTC(2026, 6, 21, 3, 0, 0);

/** "Now" for the runtime being built; a live demo passes the real clock. */
let HARNESS_NOW = DEMO_NOW;

/** The browser globals the harness touches, without a DOM lib in this package. */
const browser = globalThis as unknown as {
  window?: Record<string, unknown> & { open(url: string, target: string): unknown };
  Blob?: new (parts: string[], options: { type: string }) => Blob;
  document?: { createElement(tag: 'a'): { href: string; download: string; click(): void } };
};

const HOUR = 3_600_000;
const P = REPAIR_PERMISSION;
const I = INVENTORY_PERMISSION;
const M = MONEY_PERMISSION;

/** Who the harness can act as: the owner (everything), the counter and a technician. */
export const DEMO_REPAIR_ROLES = {
  owner: {
    userId: 'u-andi',
    name: 'Andi Pratama',
    permissions: [...Object.values(P), ...Object.values(I), ...Object.values(M)],
  },
  counter: {
    userId: 'u-siti',
    name: 'Siti Rahayu',
    // No cancel or discount: only owners lower what a customer pays (how counter staff kept cash).
    permissions: [
      P.read,
      P.intake,
      P.assign,
      P.quoteChange,
      P.handover,
      I.read,
      I.useParts,
      M.read,
      M.receive,
      M.moveCash,
      M.countCash,
    ],
  },
  technician: {
    userId: 'u-budi',
    name: 'Budi Santoso',
    permissions: [P.read, P.work, I.read, I.useParts],
  },
  /** A manager: counter and repair work, plus the owners' money decisions up to a limit. */
  manager: {
    userId: 'u-maria',
    name: 'Maria Kogoya',
    permissions: [
      P.read,
      P.intake,
      P.assign,
      P.quoteChange,
      P.handover,
      P.work,
      P.cancel,
      P.discount,
      P.correctDownPayment,
      P.warrantyException,
      I.read,
      I.useParts,
      I.correctUse,
      I.count,
      M.read,
      M.receive,
      M.moveCash,
      M.countCash,
      M.adjustCash,
      M.refund,
      M.voidPayment,
      M.extendCredit,
    ],
    /** Per servisan, as the store owner set them in "Batas wewenang". */
    limits: {
      [P.discount]: 50_000,
      [P.cancel]: 50_000,
      [P.correctDownPayment]: 50_000,
      [M.refund]: 30_000,
      [M.voidPayment]: 30_000,
      [M.extendCredit]: 100_000,
    },
  },
  /** A store owner: may choose what this store uses, not change the franchise's lists. */
  storeOwner: {
    userId: 'u-yosua',
    name: 'Yosua Wonda',
    permissions: [
      P.read,
      P.intake,
      P.quoteChange,
      P.hideIntakeOptions,
      P.cancel,
      P.discount,
      P.setCancelFees,
      P.correctDownPayment,
      P.setPrintSettings,
      P.setUncollectedDays,
      P.warrantyException,
      // Categories are the business owner's alone.
      ...Object.values(I).filter((id) => id !== I.manageCategories),
      ...Object.values(M).filter((id) => id !== M.manageCentralAccounts),
    ],
  },
} as const;

/** The demo store's payment methods besides cash. */
const DEMO_ACCOUNTS = [
  {
    id: '01920000-0000-7000-8000-00000000a001',
    kind: 'qris',
    name: 'QRIS BCA',
    active: true,
    central: false,
    storeIds: [],
  },
  {
    id: '01920000-0000-7000-8000-00000000a002',
    kind: 'edc',
    name: 'EDC Mandiri',
    active: true,
    central: false,
    storeIds: [],
  },
  {
    id: '01920000-0000-7000-8000-00000000a003',
    kind: 'transfer',
    name: 'Transfer BRI',
    active: true,
    central: true,
    storeIds: [],
  },
] as const;
export type DemoRepairRole = keyof typeof DEMO_REPAIR_ROLES;

/** `ModulePort.limitOf` for a demo actor: their limit when they have one, else none if held. */
function demoLimitOf(
  actor: (typeof DEMO_REPAIR_ROLES)[DemoRepairRole],
  permitted: ReadonlySet<string>,
  id: string,
): number | null {
  if (!permitted.has(id)) return 0;
  const limits = (actor as { readonly limits?: Readonly<Record<string, number>> }).limits ?? {};
  return limits[id] ?? null;
}

/** The business's stores, for picking which ones share a central payment method. */
const DEMO_STORES = [
  { id: '01920000-0000-7000-8000-0000000005a1', name: 'Bolusi Jayapura' },
  { id: '01920000-0000-7000-8000-0000000005a2', name: 'Bolusi Sorong' },
  { id: '01920000-0000-7000-8000-0000000005a3', name: 'Bolusi Manokwari' },
];

/** The `window` key of the colleague hook `demoRepairRuntime` installs (browser tests only). */
export const DEMO_COLLEAGUE_HOOK = '__repairDemoColleague';

const NAMES = new Map<string, string>([
  ['u-andi', 'Andi Pratama'],
  ['u-siti', 'Siti Rahayu'],
  ['u-budi', 'Budi Santoso'],
  ['u-yosua', 'Yosua Wonda'],
  ['u-maria', 'Maria Kogoya'],
]);
const TECHNICIANS = ['u-budi', 'u-yosua', 'u-andi'];

let mediaCounter = 0;
function demoMedia(mime: 'image/jpeg' | 'image/png' = 'image/jpeg'): MediaRef {
  mediaCounter += 1;
  const hex = mediaCounter.toString(16).padStart(12, '0');
  return {
    mediaId: `01920000-0000-7000-8000-${hex}`,
    sha256: hex.padStart(64, 'a'),
    mime,
    type: 'image',
    sizeBytes: 120_000,
    capturedAt: HARNESS_NOW,
    location: null,
    userId: 'u-siti',
    deviceId: 'd-demo',
  };
}

function demoVideo(): VideoRef {
  const { mediaId, sha256, sizeBytes, capturedAt, location, userId, deviceId } = demoMedia();
  return {
    mediaId,
    sha256,
    mime: 'video/mp4',
    type: 'video',
    sizeBytes: sizeBytes * 60,
    capturedAt,
    location,
    userId,
    deviceId,
  };
}

function photoRow(slot: string, ref: AnyMediaRef = demoMedia()): TicketPhotoRow {
  return {
    slot,
    mediaId: ref.mediaId,
    mediaSha256: ref.sha256,
    mediaMime: ref.mime,
    capturedAt: ref.capturedAt,
  };
}

const INTAKE_SLOTS = ['front', 'back', 'left', 'right', 'top', 'bottom'];

function line(
  kind: QuoteLineRow['kind'],
  description: string,
  amount: number,
  extra: Partial<QuoteLineRow> = {},
): QuoteLineRow {
  return {
    id: `line-${description}-${String(amount)}`,
    kind,
    description,
    amount,
    status: 'intake',
    reason: null,
    customerAgreed: null,
    createdBy: 'u-siti',
    createdAt: HARNESS_NOW - 5 * HOUR,
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    ...extra,
  };
}

function ticket(spec: {
  id: string;
  number: string;
  customer: string;
  phone: string | null;
  brand: string;
  model: string;
  color: string;
  complaint: string;
  outcome: RepairOutcome;
  technicianId: string | null;
  lines: QuoteLineRow[];
  hoursAgo: number;
  extraPhotos?: TicketPhotoRow[];
  location?: TicketDetailRow['location'];
  cancel?: { fee: number; standardFee: number; by: string; reason: string; hoursAgo: number };
  downPayment?: number;
  returnedBy?: string;
  /** Hours since it was marked repaired; a cancel is ready to collect when it was cancelled. */
  readyHoursAgo?: number;
  /** Repair type ids from the default list. */
  repairTypes?: readonly string[];
}): TicketDetailRow {
  const createdAt = HARNESS_NOW - spec.hoursAgo * HOUR;
  return {
    id: spec.id,
    ticketNumber: spec.number,
    customerId: `c-${spec.id}`,
    customerName: spec.customer,
    customerPhone: spec.phone,
    deviceBrand: spec.brand,
    deviceModel: spec.model,
    deviceColor: spec.color,
    deviceImei: '356789104455667',
    complaint: spec.complaint,
    outcome: spec.outcome,
    location: spec.location ?? 'in_store',
    technicianId: spec.technicianId,
    technicianName: spec.technicianId === null ? null : (NAMES.get(spec.technicianId) ?? null),
    quoteTotal: 0,
    estimatedReadyAt: createdAt + 30 * HOUR,
    pendingProposals: 0,
    createdAt,
    updatedAt: createdAt,
    cancelFee: spec.cancel?.fee ?? null,
    cancelStandardFee: spec.cancel?.standardFee ?? null,
    cancelledBy: spec.cancel?.by ?? null,
    cancelledByName: spec.cancel === undefined ? null : (NAMES.get(spec.cancel.by) ?? null),
    cancelledAt: spec.cancel === undefined ? null : HARNESS_NOW - spec.cancel.hoursAgo * HOUR,
    readyAt:
      spec.cancel !== undefined
        ? HARNESS_NOW - spec.cancel.hoursAgo * HOUR
        : spec.outcome === 'repaired'
          ? HARNESS_NOW - (spec.readyHoursAgo ?? Math.min(spec.hoursAgo, 20)) * HOUR
          : null,
    // Every seeded ticket past "received" has had work started on it.
    workStarted: spec.outcome !== 'received' && (spec.extraPhotos ?? []).length > 0,
    devicePasscode: null,
    intakeNotes: 'Ada goresan di sudut kanan bawah.',
    checklist: [
      { item: 'screen', label: null, state: 'issue', note: '' },
      { item: 'touch', label: null, state: 'issue', note: '' },
      { item: 'speaker', label: null, state: 'ok', note: '' },
      { item: 'charging', label: null, state: 'ok', note: '' },
    ],
    peripherals: [
      { item: 'charger', label: null },
      { item: 'case', label: null },
    ],
    repairTypes: demoRepairTypes(spec.repairTypes ?? []),
    claimOfTicketId: null,
    claimOf: null,
    claims: [],
    intakePhotos: INTAKE_SLOTS.map((slot) => ({ slot, label: null })),
    outcomeNote: spec.cancel?.reason ?? null,
    createdBy: 'u-siti',
    createdByName: 'Siti Rahayu',
    returnedBy: spec.returnedBy ?? null,
    returnedByName: spec.returnedBy === undefined ? null : (NAMES.get(spec.returnedBy) ?? null),
    returnedAt: spec.returnedBy === undefined ? null : createdAt + 40 * HOUR,
    downPayment: spec.downPayment ?? null,
    slipPrints: { intake: 1, handover: 0 },
    quoteLines: spec.lines,
    photos: [...INTAKE_SLOTS.map((slot) => photoRow(slot)), ...(spec.extraPhotos ?? [])],
    events: [
      {
        id: `ev-${spec.id}-1`,
        kind: 'repair.ticket_opened',
        actorId: 'u-siti',
        actorName: 'Siti Rahayu',
        at: createdAt,
        detail: {},
      },
    ],
  };
}

function demoRepairTypes(ids: readonly string[]): TicketDetailRow['repairTypes'] {
  const recorded = recordRepairTypes(ids, DEFAULT_INTAKE_OPTIONS.repairTypes);
  return 'types' in recorded ? recorded.types : [];
}

function seedTickets(): TicketDetailRow[] {
  return [
    ticket({
      id: 't-1',
      number: 'K7Q-0012',
      customer: 'Yohanis Wenda',
      phone: '0812-4455-6677',
      brand: 'Samsung',
      model: 'Galaxy A14',
      color: 'Hitam',
      complaint: 'Layar retak, sentuhan tidak responsif di bagian atas',
      outcome: 'received',
      technicianId: null,
      lines: [line('part', 'LCD A14 original', 650_000), line('labour', 'Pasang LCD', 100_000)],
      repairTypes: ['screen'],
      hoursAgo: 2,
    }),
    ticket({
      id: 't-2',
      number: 'K7Q-0011',
      customer: 'Maria Kogoya',
      phone: '0813-9988-1122',
      brand: 'Oppo',
      model: 'A57',
      color: 'Biru',
      complaint: 'Tidak bisa mengisi daya',
      outcome: 'in_repair',
      technicianId: 'u-budi',
      lines: [
        line('part', 'Konektor charger', 85_000),
        line('labour', 'Servis konektor', 50_000),
        line('part', 'Baterai', 180_000, {
          status: 'proposed',
          reason: 'Baterai kembung, harus diganti',
          createdBy: 'u-budi',
        }),
      ],
      repairTypes: ['chargingPort', 'battery'],
      hoursAgo: 20,
      extraPhotos: [photoRow('before:m1'), photoRow('before:m2')],
      downPayment: 50_000,
    }),
    ticket({
      id: 't-3',
      number: 'K7Q-0010',
      customer: 'Petrus Yikwa',
      phone: null,
      brand: 'Xiaomi',
      model: 'Redmi Note 12',
      color: 'Hijau',
      complaint: 'Mati total setelah jatuh ke air',
      outcome: 'waiting_for_parts',
      technicianId: 'u-yosua',
      lines: [line('labour', 'Cek mesin', 50_000)],
      repairTypes: ['noPower', 'waterDamage'],
      hoursAgo: 48,
      extraPhotos: [photoRow('before:m3')],
    }),
    ticket({
      id: 't-4',
      number: 'K7Q-0009',
      customer: 'Ester Mandowen',
      phone: '0821-3344-5566',
      brand: 'Vivo',
      model: 'Y21',
      color: 'Putih',
      complaint: 'Speaker tidak bunyi',
      outcome: 'repaired',
      technicianId: 'u-budi',
      lines: [line('part', 'Speaker Y21', 75_000), line('labour', 'Pasang speaker', 40_000)],
      repairTypes: ['audio'],
      hoursAgo: 70,
      extraPhotos: [photoRow('before:m4'), photoRow('after:m5')],
      downPayment: 100_000,
    }),
    ticket({
      id: 't-5',
      number: 'K7Q-0008',
      customer: 'Daniel Tabuni',
      phone: '0852-1122-3344',
      brand: 'Realme',
      model: 'C55',
      color: 'Hitam',
      complaint: 'Kamera belakang buram',
      outcome: 'cancelled',
      technicianId: 'u-budi',
      lines: [line('part', 'Kamera C55', 220_000), line('labour', 'Pasang kamera', 50_000)],
      repairTypes: ['camera'],
      hoursAgo: 90,
      extraPhotos: [photoRow('before:m6')],
      downPayment: 100_000,
      cancel: {
        fee: 50_000,
        standardFee: 50_000,
        by: 'u-andi',
        reason: 'Pelanggan tidak jadi, harga kamera terlalu mahal.',
        hoursAgo: 30,
      },
    }),
    ticket({
      id: 't-6',
      number: 'K7Q-0007',
      customer: 'Lince Wakerkwa',
      phone: null,
      brand: 'Samsung',
      model: 'Galaxy A05',
      color: 'Hijau',
      complaint: 'Tombol power macet',
      outcome: 'cancelled',
      technicianId: 'u-budi',
      lines: [line('labour', 'Servis tombol power', 60_000)],
      repairTypes: ['buttons'],
      hoursAgo: 120,
      extraPhotos: [photoRow('before:m7')],
      location: 'returned',
      returnedBy: 'u-siti',
      cancel: {
        fee: 0,
        standardFee: 50_000,
        by: 'u-yosua',
        reason: 'Sparepart tidak tersedia. Biaya dibebaskan karena kami yang tidak bisa servis.',
        hoursAgo: 100,
      },
    }),
    // Repaired more than two months ago and never collected: flagged on the board.
    ticket({
      id: 't-7',
      number: 'K7Q-0006',
      customer: 'Markus Yikwa',
      phone: '0813-4455-6677',
      brand: 'Oppo',
      model: 'A57',
      color: 'Hitam',
      complaint: 'Baterai cepat habis',
      outcome: 'repaired',
      technicianId: 'u-budi',
      lines: [line('part', 'Baterai A57', 180_000), line('labour', 'Ganti baterai', 50_000)],
      repairTypes: ['battery'],
      hoursAgo: 75 * 24,
      readyHoursAgo: 72 * 24,
      extraPhotos: [photoRow('before:m8'), photoRow('after:m9')],
    }),
    // Went home with a new screen about ten days ago: still under warranty, so it can be claimed.
    ticket({
      id: 't-8',
      number: 'K7Q-0005',
      customer: 'Yakob Tabuni',
      phone: '0812-7788-9900',
      brand: 'Xiaomi',
      model: 'Redmi Note 12',
      color: 'Biru',
      complaint: 'Layar pecah',
      outcome: 'repaired',
      technicianId: 'u-budi',
      lines: [line('part', 'LCD Redmi Note 12', 550_000), line('labour', 'Pasang LCD', 75_000)],
      repairTypes: ['screen'],
      hoursAgo: 300,
      extraPhotos: [photoRow('before:m10'), photoRow('after:m11')],
      location: 'returned',
      returnedBy: 'u-siti',
    }),
    // Taken home last week before it was paid: on the Kas unpaid list.
    ticket({
      id: 't-9',
      number: 'K7Q-0004',
      customer: 'Yulianus Wenda',
      phone: '0812-9988-7766',
      brand: 'Samsung',
      model: 'Galaxy A34',
      color: 'Hitam',
      complaint: 'Port cas longgar',
      outcome: 'repaired',
      technicianId: 'u-budi',
      lines: [line('part', 'Konektor cas', 350_000), line('labour', 'Ganti konektor', 100_000)],
      hoursAgo: 9 * 24,
      readyHoursAgo: 7 * 24,
      location: 'returned',
      returnedBy: 'u-siti',
      extraPhotos: [photoRow('before:m12'), photoRow('after:m13')],
    }),
  ].map(withTotals);
}

const CUSTOMERS = [
  'Yakobus Mandowen',
  'Benny Kambu',
  'Corneles Waromi',
  'Debora Yoku',
  'Elias Mofu',
  'Fransina Ayomi',
  'Gerson Rumbewas',
  'Hana Sawaki',
  'Isak Kafiar',
  'Juliana Wanma',
  'Kornelius Mansawan',
  'Lea Rumaropen',
  'Markus Wamafma',
  'Novi Rumbrawer',
  'Obeth Inggamer',
  'Priska Mayor',
  'Rudi Hamadi',
  'Sarlota Rumere',
  'Thomas Indey',
  'Yuliana Sroyer',
  'Wempi Fonataba',
  'Siti Nurhaliza',
  'Ahmad Fauzi',
  'Rina Wulandari',
  'Budi Hartono',
];
const DEVICES: readonly (readonly [string, string, string])[] = [
  ['Samsung', 'Galaxy A15', 'Hitam'],
  ['Samsung', 'Galaxy A05s', 'Hijau'],
  ['Oppo', 'A18', 'Biru'],
  ['Oppo', 'Reno 8', 'Hitam'],
  ['Vivo', 'Y17s', 'Ungu'],
  ['Xiaomi', 'Redmi 13C', 'Hitam'],
  ['Xiaomi', 'Redmi Note 13', 'Biru'],
  ['Realme', 'C53', 'Emas'],
  ['Infinix', 'Hot 40i', 'Hijau'],
  ['iPhone', '11', 'Putih'],
  ['Tecno', 'Spark 20', 'Hitam'],
];
const PROBLEMS: readonly (readonly [string, string, number, string, number])[] = [
  ['LCD pecah, ada garis hijau', 'LCD original', 550_000, 'Pasang LCD', 100_000],
  ['Baterai cepat habis', 'Baterai', 180_000, 'Ganti baterai', 50_000],
  ['Tidak bisa cas', 'Konektor cas', 75_000, 'Servis konektor', 50_000],
  ['Speaker sember', 'Speaker', 70_000, 'Pasang speaker', 40_000],
  ['Kamera belakang tidak fokus', 'Kamera belakang', 210_000, 'Pasang kamera', 50_000],
  ['Mati total habis jatuh', 'IC power', 250_000, 'Servis mesin', 150_000],
  ['Lupa pola kunci layar', 'Flash ulang', 0, 'Reset dan flash', 100_000],
  ['Tombol volume macet', 'Fleksibel volume', 60_000, 'Pasang fleksibel', 40_000],
];
const OUTCOMES: readonly RepairOutcome[] = [
  'received',
  'in_repair',
  'in_repair',
  'waiting_for_parts',
  'repaired',
  'received',
  'in_repair',
];

/** A store's worth of extra tickets, dated over the past two weeks, spread over every queue. */
function storeTickets(): TicketDetailRow[] {
  return Array.from({ length: 48 }, (_, i) => {
    const [brand, model, colour] = DEVICES[(i * 7) % DEVICES.length]!;
    const [complaint, part, partPrice, labour, labourPrice] = PROBLEMS[(i * 5) % PROBLEMS.length]!;
    const outcome = OUTCOMES[i % OUTCOMES.length]!;
    const returned = i % 11 === 10;
    const unassigned = outcome === 'received' && i % 3 === 0;
    const lines = [
      ...(partPrice > 0 ? [line('part', part, partPrice)] : []),
      line('labour', labour, labourPrice),
    ];
    return withTotals(
      ticket({
        id: `t-s${String(i)}`,
        number: `K7P-${String(200 - i).padStart(4, '0')}`,
        customer: CUSTOMERS[i % CUSTOMERS.length]!,
        phone:
          i % 4 === 3
            ? null
            : `08${String(11 + (i % 9))}-${String(4000 + i * 37)}-${String(5100 + i * 53)}`,
        brand,
        model,
        color: colour,
        complaint,
        outcome: returned ? 'repaired' : outcome,
        technicianId: unassigned ? null : TECHNICIANS[i % TECHNICIANS.length]!,
        lines,
        hoursAgo: 3 + i * 6,
        ...(outcome === 'received' ? {} : { extraPhotos: [photoRow(`before:s${String(i)}`)] }),
        ...(returned ? { location: 'returned' as const } : {}),
      }),
    );
  });
}

/**
 * `?tickets=N` on a repair entry fills the store to N tickets, so the board can be timed at a busy
 * store's volume: the seeded six, then older history, nearly all of it already handed back.
 */
export function demoTicketCount(search: string): number {
  const count = Number(new URLSearchParams(search).get('tickets'));
  return Number.isInteger(count) && count > 0 ? count : 0;
}

const HISTORY_FIRST = [
  'Yohanis',
  'Maria',
  'Markus',
  'Agustina',
  'Petrus',
  'Ruth',
  'Simon',
  'Dorkas',
  'Budi',
  'Dewi',
];
const HISTORY_LAST = [
  'Wenda',
  'Kogoya',
  'Tabuni',
  'Mandacan',
  'Rumbiak',
  'Kambu',
  'Yoku',
  'Mofu',
  'Krey',
  'Sawaki',
];
const HISTORY_DEVICES = [
  ['Samsung', 'Galaxy A14'],
  ['Oppo', 'A17'],
  ['Vivo', 'Y17s'],
  ['Xiaomi', 'Redmi Note 12'],
  ['Realme', 'C55'],
  ['Infinix', 'Hot 40'],
  ['Apple', 'iPhone 11'],
] as const;

/** Older tickets after the seeded ones, deterministic so timings compare run to run. */
function historyTickets(count: number): TicketDetailRow[] {
  let seed = 7;
  const next = (): number => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
  return Array.from({ length: count }, (_, i) => {
    const [brand, model] = pick(HISTORY_DEVICES);
    // One in twenty is still in the shop; the rest were repaired, or cancelled, and handed back.
    const open = next() < 0.05;
    const cancelled = !open && next() < 0.08;
    return withTotals(
      ticket({
        id: `h-${String(i)}`,
        number: `K7Q-H${String(i).padStart(5, '0')}`,
        customer: `${pick(HISTORY_FIRST)} ${pick(HISTORY_LAST)}`,
        phone: `08${String(Math.floor(next() * 1e10)).padStart(10, '0')}`,
        brand,
        model,
        color: 'Hitam',
        complaint: 'Layar retak',
        outcome: open ? 'in_repair' : cancelled ? 'cancelled' : 'repaired',
        technicianId: pick(TECHNICIANS),
        lines: [line('part', 'LCD', 450_000), line('labour', 'Pasang LCD', 50_000)],
        hoursAgo: 150 + i * 0.6,
        location: open ? 'in_store' : 'returned',
        ...(cancelled
          ? {
              cancel: {
                fee: 0,
                standardFee: 50_000,
                by: 'u-andi',
                reason: 'Batal',
                hoursAgo: 140 + i * 0.6,
              },
            }
          : {}),
      }),
    );
  });
}

function withTotals(row: TicketDetailRow): TicketDetailRow {
  const counted = row.quoteLines.filter((l) => l.status === 'intake' || l.status === 'applied');
  return {
    ...row,
    quoteTotal: counted.reduce((sum, l) => sum + l.amount, 0),
    pendingProposals: row.quoteLines.filter((l) => l.status === 'proposed').length,
  };
}

/** A small grey tile reading "demo photo", so a screenshot never passes for real evidence. */
/** A stand-in photo per media id, portrait like a phone shot, tinted so swiping shows a change. */
function placeholderUri(mediaId: string): string {
  const n = parseInt(mediaId.slice(-4), 16) || 0;
  const hue = (n * 47) % 360;
  return `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400"><rect width="300" height="400" fill="hsl(${String(hue)},18%,82%)"/><rect x="95" y="70" width="110" height="220" rx="16" fill="hsl(${String(hue)},14%,52%)"/><text x="150" y="350" font-family="sans-serif" font-size="22" text-anchor="middle" fill="#3d4450">demo photo ${String(n)}</text></svg>`,
  )}`;
}

export interface DemoRepairOptions {
  /** The clock the tickets are dated against; the phone harness keeps its fixed one. */
  readonly now?: number | undefined;
  /** `store` adds a few dozen more tickets, so lists are seen at a real store's volume. */
  readonly volume?: 'sample' | 'store' | undefined;
  /** Fills the store with older history up to this many tickets, to time lists at volume. */
  readonly tickets?: number | undefined;
}

/** The demo runtime, plus switching who acts, so "switch user" in the preview keeps the same tickets. */
export type DemoRepairRuntime = RepairRuntime & { actAs(role: DemoRepairRole): void };

/** The demo role a roster user signs in as, if they have one. */
export function demoRoleOf(userId: string): DemoRepairRole | undefined {
  return (Object.keys(DEMO_REPAIR_ROLES) as DemoRepairRole[]).find(
    (role) => DEMO_REPAIR_ROLES[role].userId === userId,
  );
}

export function demoRepairRuntime(
  role: DemoRepairRole = 'owner',
  { now = DEMO_NOW, volume = 'sample', tickets: ticketCount = 0 }: DemoRepairOptions = {},
): DemoRepairRuntime {
  HARNESS_NOW = now;
  let actor: (typeof DEMO_REPAIR_ROLES)[DemoRepairRole] = DEMO_REPAIR_ROLES[role];
  const seeded = volume === 'store' ? [...seedTickets(), ...storeTickets()] : seedTickets();
  let tickets = [...seeded, ...historyTickets(Math.max(0, ticketCount - seeded.length))];
  let counter = 13;
  let options: IntakeOptionSettings = { lists: DEFAULT_INTAKE_OPTIONS, hidden: NOTHING_HIDDEN };
  let optionIds = 0;
  let cancelFees = { beforeWork: 0, afterWork: 50_000 };
  let uncollectedLimit = DEFAULT_UNCOLLECTED_DAYS;
  let printSettings: PrintSettings = {
    name: null,
    address: 'Jl. Trikora No. 12, Wamena',
    phone: '0821-9876-5432',
    logo: null,
    logoOnDotMatrix: false,
    intakeTerms: null,
    handoverTerms: null,
  };
  let paper: PaperSettings | null = null;
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  // Recorded as the command does: the store's list now, a kept type keeps its terms.
  const recordedTypes = (
    ids: unknown,
    kept: TicketDetailRow['repairTypes'],
  ): TicketDetailRow['repairTypes'] => {
    const recorded = recordRepairTypes(
      (ids as string[] | undefined) ?? [],
      storeIntakeOptions(options).repairTypes,
      kept,
    );
    return 'types' in recorded ? recorded.types : kept;
  };

  const find = (ticketId: string): TicketDetailRow => {
    const found = tickets.find((t) => t.id === ticketId);
    if (found === undefined)
      throw Object.assign(new Error('not found'), { code: 'ENTITY_NOT_FOUND' });
    return found;
  };
  // The links between a claim and its servisan, read as the device's query joins them.
  const withClaims = (t: TicketDetailRow): TicketDetailRow => {
    const claimed = tickets.find((other) => other.id === t.claimOfTicketId);
    return {
      ...t,
      claimOf:
        claimed === undefined
          ? null
          : {
              id: claimed.id,
              ticketNumber: claimed.ticketNumber,
              repairTypes: claimed.repairTypes,
              returnedAt: claimed.returnedAt,
            },
      claims: tickets
        .filter((other) => other.claimOfTicketId === t.id)
        .map(({ id, ticketNumber }) => ({ id, ticketNumber }))
        .reverse(),
    };
  };
  const update = (
    ticketId: string,
    kind: string,
    patch: Partial<TicketDetailRow>,
    detail: Readonly<Record<string, unknown>> = {},
  ) => {
    // The one rule every step but the handover shares (repair rules.ts): a change that raced a
    // cancel or a handover on another device is refused with its own reason, as on a phone.
    const current = find(ticketId);
    if (kind !== 'repair.device_returned') {
      if (current.location === 'returned') throw REPAIR_REFUSALS.refuse('returned');
      if (current.outcome === 'cancelled') throw REPAIR_REFUSALS.refuse('cancelled');
    }
    tickets = tickets.map((t) =>
      t.id === ticketId
        ? withTotals({
            ...t,
            ...patch,
            updatedAt: HARNESS_NOW,
            events: [
              ...t.events,
              {
                id: `ev-${String(Math.random())}`,
                kind,
                actorId: actor.userId,
                actorName: actor.name,
                at: HARNESS_NOW,
                detail,
              },
            ],
          })
        : t,
    );
    notify();
    return { ticketId };
  };
  const addPhotos = (t: TicketDetailRow, stage: string, refs: readonly MediaRef[]) => [
    ...t.photos,
    ...refs.map((ref) => photoRow(`${stage}:${ref.mediaId}`, ref)),
  ];
  const page = <T>(rows: readonly T[]) => Promise.resolve({ rows, nextCursor: null });
  // Pages like the device's `listTickets`: `limit` rows, with the next offset as the cursor.
  const paged = <T>(rows: readonly T[], input: Input) => {
    const start = Number(input['cursor'] ?? 0);
    const end = start + Number(input['limit'] ?? 50);
    return Promise.resolve({
      rows: rows.slice(start, end),
      nextCursor: end < rows.length ? String(end) : null,
    });
  };
  // Kept between searches and rebuilt only after a change, as the device's search cache does.
  let ticketIndex: { readonly of: readonly TicketDetailRow[]; readonly index: FuzzyIndex } | null =
    null;
  const ticketSearch = (): FuzzyIndex => {
    if (ticketIndex?.of !== tickets) {
      ticketIndex = {
        of: tickets,
        index: new FuzzyIndex(
          tickets.map((t) => ({
            id: t.id,
            text: [t.customerName, t.deviceBrand, t.deviceModel],
            phones: [t.customerPhone],
            numbers: [t.deviceImei],
            codes: [t.ticketNumber],
            rank: t.createdAt,
          })),
        ),
      };
    }
    return ticketIndex.index;
  };
  const summary = (t: TicketDetailRow) => t;

  // The same filters and sorts `listTickets` applies on a device, over the demo's rows.
  const filterTickets = (raw: unknown, cancelledOnly: boolean): TicketDetailRow[] => {
    const f = (raw ?? {}) as Record<string, unknown>;
    const outcomes = f['outcomes'] as string[] | undefined;
    const technicianIds = f['technicianIds'] as string[] | undefined;
    const brands = (f['brands'] as string[] | undefined)?.map((b) => b.trim().toLowerCase());
    const from = f['receivedFrom'] as number | undefined;
    const before = f['receivedBefore'] as number | undefined;
    const readyBefore = f['readyBefore'] as number | undefined;
    const ids = f['ids'] as string[] | undefined;
    return tickets.filter(
      (t) =>
        (outcomes === undefined || outcomes.includes(t.outcome)) &&
        (f['location'] === undefined || t.location === f['location']) &&
        (ids === undefined || ids.includes(t.id)) &&
        (f['technicianId'] === undefined || t.technicianId === f['technicianId']) &&
        (technicianIds === undefined
          ? f['unassigned'] !== true || t.technicianId === null
          : (t.technicianId !== null && technicianIds.includes(t.technicianId)) ||
            (f['unassigned'] === true && t.technicianId === null)) &&
        (f['hasPendingProposals'] !== true || t.pendingProposals > 0) &&
        (from === undefined || t.createdAt >= from) &&
        (before === undefined || t.createdAt < before) &&
        (readyBefore === undefined || (t.readyAt !== null && t.readyAt < readyBefore)) &&
        (brands === undefined || brands.includes(t.deviceBrand.trim().toLowerCase())) &&
        (!cancelledOnly || t.cancelledAt !== null),
    );
  };
  const compareBy = (sort: string) => {
    const [key, direction] = sort.split('.');
    const value = (t: TicketDetailRow): number | string =>
      key === 'number'
        ? t.ticketNumber
        : key === 'total'
          ? t.outcome === 'cancelled'
            ? (t.cancelFee ?? 0)
            : t.quoteTotal
          : key === 'readyBy'
            ? (t.estimatedReadyAt ?? 0)
            : key === 'cancelledAt'
              ? (t.cancelledAt ?? 0)
              : key === 'readyAt'
                ? (t.readyAt ?? 0)
                : t.createdAt;
    const sign = direction === 'asc' ? 1 : -1;
    return (a: TicketDetailRow, b: TicketDetailRow): number => {
      const x = value(a);
      const y = value(b);
      const order =
        typeof x === 'string' && typeof y === 'string'
          ? x.localeCompare(y, 'id')
          : Number(x) - Number(y);
      return order === 0 ? b.createdAt - a.createdAt : sign * order;
    };
  };

  type Input = Record<string, unknown>;
  const queries: Record<string, (input: Input) => Promise<unknown>> = {
    listTickets: (input) => {
      const sort = String(input['sort'] ?? 'createdAt.desc');
      const rows = filterTickets(input['filter'], sort === 'cancelledAt.desc')
        .sort(compareBy(sort))
        .map(summary);
      // The desktop table asks for a page by offset; the phone board pages by cursor like the device.
      if (input['offset'] === undefined) return paged(rows, input);
      const offset = Number(input['offset']);
      return page(rows.slice(offset, offset + Number(input['limit'] ?? 50)));
    },
    countTickets: (input) =>
      page([{ count: filterTickets(input['filter'], input['cancelledOnly'] === true).length }]),
    ticketBrands: () => {
      const counts = new Map<string, { brand: string; count: number }>();
      for (const t of tickets) {
        const key = t.deviceBrand.trim().toLowerCase();
        const entry = counts.get(key) ?? { brand: t.deviceBrand.trim(), count: 0 };
        entry.count += 1;
        counts.set(key, entry);
      }
      return page([...counts.values()].sort((a, b) => b.count - a.count));
    },
    technicianLoads: () => {
      const loads = new Map<string, number>();
      for (const t of tickets) {
        const working = (IN_PROGRESS_OUTCOMES as readonly RepairOutcome[]).includes(t.outcome);
        if (t.technicianId === null || !working || t.location !== 'in_store') continue;
        loads.set(t.technicianId, (loads.get(t.technicianId) ?? 0) + 1);
      }
      return page([...loads].map(([technicianId, load]) => ({ technicianId, load })));
    },
    // The same shared fuzzy search the device runs, so typos and spelling variants behave alike.
    searchTickets: (input) =>
      page(
        ticketSearch()
          .search(String(input['text']), Number(input['limit'] ?? 20))
          .map((hit) => find(hit.id)),
      ),
    searchDeviceModels: (input) =>
      page(demoSearchDeviceModels(String(input['text']), Number(input['limit'] ?? 6))),
    findDeviceModel: (input) =>
      page(demoFindDeviceModel(String(input['brand']), String(input['model']))),
    searchCustomers: (input) => {
      const customers = new Map(tickets.map((t) => [t.customerId, t]));
      const index = new FuzzyIndex(
        [...customers.values()].map((t) => ({
          id: t.customerId,
          text: [t.customerName],
          phones: [t.customerPhone],
          rank: t.createdAt,
        })),
      );
      return page(
        index.search(String(input['text']), Number(input['limit'] ?? 10)).map((hit) => {
          const t = customers.get(hit.id)!;
          return {
            id: t.customerId,
            name: t.customerName,
            phone: t.customerPhone,
            createdAt: t.createdAt,
          };
        }),
      );
    },
    getTicket: (input) => page([withClaims(find(String(input['ticketId'])))]),
    intakeOptionSettings: () => page([options]),
    cancelFees: () => page([cancelFees]),
    printSettings: () => page([printSettings]),
    uncollectedDays: () => page([{ days: uncollectedLimit }]),
  };

  const commands: Record<string, (input: Input) => unknown> = {
    openTicket: (input) => {
      // The wizard mints the id when intake starts (so a double submit opens one ticket).
      const id =
        typeof input['ticketId'] === 'string' ? input['ticketId'] : `t-new-${String(counter)}`;
      const number = `K7Q-${String(counter).padStart(4, '0')}`;
      counter += 1;
      const customer = input['customer'] as {
        name?: string;
        phone?: string | null;
        customerId?: string;
      };
      const existing = tickets.find((t) => t.customerId === customer.customerId);
      const device = input['device'] as {
        brand: string;
        model: string;
        color: string;
        passcode?: string | null;
      };
      const photos = input['photos'] as { slot: string; label: string | null; ref: MediaRef }[];
      const claimOf = typeof input['claimOf'] === 'string' ? input['claimOf'] : null;
      const lines = input['quoteLines'] as {
        kind: QuoteLineRow['kind'];
        description: string;
        amount: number;
      }[];
      if (claimOf !== null) {
        // As the claim rule judges it.
        const problem = claimProblem(find(claimOf), {
          customerId: customer.customerId ?? '',
          imei: (input['device'] as { imei?: string | null }).imei ?? null,
          repairTypes: (input['repairTypes'] as string[] | undefined) ?? [],
          total: lines.reduce((sum, l) => sum + l.amount, 0),
          at: HARNESS_NOW,
        });
        if (problem !== null && !(problem.owner && permitted.has(P.warrantyException))) {
          throw REPAIR_REFUSALS.refuse(problem.reason);
        }
      }
      const repairTypes = recordedTypes(input['repairTypes'], []);
      const video = (input['ownershipVideo'] as VideoRef | null | undefined) ?? null;
      // As the intake rule judges it.
      if (video === null && needsOwnershipVideo(repairTypes)) {
        throw REPAIR_REFUSALS.refuse('ownershipVideoNeeded');
      }
      const created = withTotals({
        ...seedTickets()[0]!,
        id,
        deviceImei: (input['device'] as { imei?: string }).imei || null,
        technicianId: null,
        technicianName: null,
        events: [
          {
            id: `ev-${id}-1`,
            kind: 'repair.ticket_opened',
            actorId: actor.userId,
            actorName: actor.name,
            at: HARNESS_NOW,
            detail: {},
          },
        ],
        ticketNumber: number,
        customerId: existing?.customerId ?? `c-${id}`,
        customerName: existing?.customerName ?? customer.name ?? '',
        customerPhone: existing?.customerPhone ?? customer.phone ?? null,
        deviceBrand: device.brand,
        deviceModel: device.model,
        deviceColor: device.color,
        devicePasscode: device.passcode ?? null,
        complaint: String(input['complaint']),
        intakeNotes: String(input['intakeNotes'] ?? ''),
        checklist: input['checklist'] as TicketDetailRow['checklist'],
        peripherals: input['peripherals'] as TicketDetailRow['peripherals'],
        repairTypes,
        claimOfTicketId: claimOf,
        intakePhotos: photos.map(({ slot, label }) => ({ slot, label })),
        estimatedReadyAt: input['estimatedReadyAt'] as number | null,
        createdAt: HARNESS_NOW,
        downPayment: Number(input['downPayment'] ?? 0) > 0 ? Number(input['downPayment']) : null,
        slipPrints: { intake: 0, handover: 0 },
        quoteLines: lines.map((l) =>
          line(l.kind, l.description, l.amount, { createdAt: HARNESS_NOW }),
        ),
        photos: [
          ...photos.map(({ slot, ref }) => photoRow(slot, ref)),
          ...(video === null ? [] : [photoRow(ownershipVideoSlot(video.mediaId), video)]),
        ],
      });
      tickets = [created, ...tickets];
      notify();
      return { ticketId: id, ticketNumber: number, customerId: created.customerId };
    },
    claimTicket: (input) =>
      update(String(input['ticketId']), 'repair.ticket_claimed', {
        technicianId: actor.userId,
        technicianName: actor.name,
      }),
    assignTechnician: (input) =>
      update(String(input['ticketId']), 'repair.technician_assigned', {
        technicianId: String(input['technicianId']),
        technicianName: NAMES.get(String(input['technicianId'])) ?? null,
      }),
    startWork: (input) => {
      const t = find(String(input['ticketId']));
      return update(t.id, 'repair.work_started', {
        outcome: 'in_repair',
        readyAt: null,
        workStarted: true,
        technicianId: t.technicianId ?? actor.userId,
        technicianName: t.technicianName ?? actor.name,
        photos: addPhotos(t, 'before', (input['beforePhotos'] as MediaRef[] | undefined) ?? []),
      });
    },
    markWaitingForParts: (input) =>
      update(String(input['ticketId']), 'repair.work_paused', {
        outcome: 'waiting_for_parts',
        outcomeNote: String(input['note'] ?? ''),
      }),
    markRepaired: (input) => {
      const t = find(String(input['ticketId']));
      return update(t.id, 'repair.marked_repaired', {
        outcome: 'repaired',
        readyAt: HARNESS_NOW,
        outcomeNote: String(input['note'] ?? ''),
        photos: addPhotos(t, 'after', input['afterPhotos'] as MediaRef[]),
      });
    },
    cancelTicket: (input) => {
      const t = find(String(input['ticketId']));
      return update(t.id, 'repair.ticket_cancelled', {
        outcome: 'cancelled',
        outcomeNote: String(input['reason']),
        cancelFee: Number(input['fee']),
        cancelStandardFee: standardCancelFee(t, cancelFees),
        cancelledBy: actor.userId,
        cancelledByName: actor.name,
        cancelledAt: HARNESS_NOW,
        readyAt: HARNESS_NOW,
      });
    },
    setUncollectedDays: (input) => {
      uncollectedLimit = Number(input['days']);
      notify();
      return { days: uncollectedLimit };
    },
    setCancelFees: (input) => {
      cancelFees = {
        beforeWork: Number(input['beforeWork']),
        afterWork: Number(input['afterWork']),
      };
      notify();
      return cancelFees;
    },
    proposeQuoteChange: (input) => priceLine(input, 'proposed', 'repair.quote_change_proposed'),
    // Not agreed yet: the change waits for the customer, like a proposal.
    changeQuote: (input) => {
      chargeOnClaim(String(input['ticketId']), Number(input['amount']));
      withinDiscountLimit(String(input['ticketId']), Number(input['amount']));
      return input['customerAgreed'] === true
        ? priceLine(input, 'applied', 'repair.quote_changed')
        : priceLine({ ...input, customerAgreed: undefined }, 'proposed', 'repair.quote_changed');
    },
    applyProposal: (input) => {
      const t = find(String(input['ticketId']));
      chargeOnClaim(t.id, t.quoteLines.find((l) => l.id === input['lineId'])?.amount ?? 0);
      return decide(input, 'applied', 'repair.quote_changed');
    },
    declineProposal: (input) => decide(input, 'declined', 'repair.quote_proposal_declined'),
    setRepairTypes: (input) => {
      const t = find(String(input['ticketId']));
      if (t.claimOfTicketId !== null) throw REPAIR_REFUSALS.refuse('claimWithTypes');
      return update(t.id, 'repair.ticket_repair_types_changed', {
        repairTypes: recordedTypes(input['repairTypes'], t.repairTypes),
      });
    },
    changeIntakeOptions: (input) => {
      const list = input['list'] as keyof IntakeOptionSettings['lists'];
      const items = (input['items'] as (IntakeOption & { id: string | null })[]).map((item) => {
        optionIds += 1;
        return { ...item, id: item.id ?? `opt-${String(optionIds)}` };
      });
      options = { ...options, lists: { ...options.lists, [list]: items } };
      notify();
      return { list };
    },
    hideIntakeOptions: (input) => {
      const list = input['list'] as keyof IntakeOptionSettings['lists'];
      options = { ...options, hidden: { ...options.hidden, [list]: input['hidden'] as string[] } };
      notify();
      return { list };
    },
    recordDownPayment: (input) =>
      update(String(input['ticketId']), 'repair.down_payment_received', {
        downPayment: Number(input['amount']),
      }),
    correctDownPayment: (input) =>
      update(String(input['ticketId']), 'repair.down_payment_corrected', {
        downPayment: Number(input['amount']) > 0 ? Number(input['amount']) : null,
      }),
    recordSlipPrinted: (input) => {
      const t = find(String(input['ticketId']));
      const slip = input['slip'] as keyof TicketDetailRow['slipPrints'];
      return update(t.id, 'repair.slip_printed', {
        slipPrints: { ...t.slipPrints, [slip]: t.slipPrints[slip] + 1 },
      });
    },
    setPrintSettings: (input) => {
      const name = String(input['name'] ?? '').trim();
      const logo = input['logo'] as MediaRef | null | undefined;
      printSettings = {
        name: name === '' ? null : name,
        address: String(input['address'] ?? ''),
        phone: String(input['phone'] ?? ''),
        logo:
          logo === undefined
            ? printSettings.logo
            : logo === null
              ? null
              : { mediaId: logo.mediaId, sha256: logo.sha256, mime: logo.mime },
        logoOnDotMatrix: input['logoOnDotMatrix'] === true,
        intakeTerms: (input['intakeTerms'] as string | null | undefined) ?? null,
        handoverTerms: (input['handoverTerms'] as string | null | undefined) ?? null,
      };
      notify();
      return printSettings;
    },
    returnDevice: (input) => {
      const t = find(String(input['ticketId']));
      const paidNow = ((input['payments'] as { amount: number }[] | undefined) ?? []).reduce(
        (sum, payment) => sum + payment.amount,
        0,
      );
      const paid = Math.min((t.downPayment ?? 0) + paidNow, amountOwed(t));
      const checklist = (input['checklist'] as HandoverCheck[] | undefined) ?? [];
      const note = String(input['note'] ?? '');
      const problem = handoverProblem(checklist, t.peripherals, note);
      if (problem !== null) throw REPAIR_REFUSALS.refuse(problem);
      return update(
        t.id,
        'repair.device_returned',
        {
          downPayment: paid === 0 ? null : paid,
          location: 'returned',
          returnedBy: actor.userId,
          returnedByName: actor.name,
          returnedAt: HARNESS_NOW,
          photos: [
            ...t.photos,
            photoRow('handover', input['handoverPhoto'] as MediaRef),
            photoRow('signature', input['signature'] as MediaRef),
          ],
        },
        { note, checklist },
      );
    },
  };

  /** A price rise on a warranty claim is the owner's, as the quote rule has it. */
  function chargeOnClaim(ticketId: string, amount: number): void {
    if (find(ticketId).claimOfTicketId === null || amount <= 0) return;
    if (permitted.has(P.warrantyException)) return;
    throw REPAIR_REFUSALS.refuse('claimChargeOwnerOnly');
  }

  /** A limited role's discounts on one servisan, together, stay within its limit (rules.ts). */
  function withinDiscountLimit(ticketId: string, amount: number): void {
    if (amount >= 0) return;
    const limit = demoLimitOf(actor, new Set<string>(actor.permissions), P.discount);
    if (limit === null) return;
    const earlier = find(ticketId)
      .quoteLines.filter((l) => l.amount < 0 && l.status !== 'declined')
      .reduce((sum, l) => sum - l.amount, 0);
    if (earlier - amount > limit) {
      throw REPAIR_REFUSALS.refuse('overLimit', { code: 'PERMISSION_DENIED' });
    }
  }

  function priceLine(input: Input, status: QuoteLineRow['status'], kind: string) {
    const t = find(String(input['ticketId']));
    const added = line(
      input['kind'] as QuoteLineRow['kind'],
      String(input['description']),
      Number(input['amount']),
      {
        status,
        reason: String(input['reason']),
        customerAgreed: (input['customerAgreed'] as boolean | undefined) ?? null,
        createdBy: actor.userId,
        createdAt: HARNESS_NOW,
      },
    );
    update(t.id, kind, { quoteLines: [...t.quoteLines, added] });
    return { ticketId: t.id, lineId: added.id };
  }

  function decide(input: Input, status: QuoteLineRow['status'], kind: string) {
    const t = find(String(input['ticketId']));
    update(t.id, kind, {
      quoteLines: t.quoteLines.map((l) =>
        l.id === input['lineId']
          ? {
              ...l,
              status,
              customerAgreed: (input['customerAgreed'] as boolean | undefined) ?? null,
              decidedBy: actor.userId,
              decidedAt: HARNESS_NOW,
            }
          : l,
      ),
    });
    return { ticketId: t.id, lineId: String(input['lineId']) };
  }

  // A colleague on another device: the harness's stand-in for a change that arrives by sync, so a
  // browser test can watch an open screen react to it. Runs the same demo commands as the owner.
  const colleague = (name: string, input: Input): unknown => {
    const self = actor;
    actor = DEMO_REPAIR_ROLES.owner;
    try {
      return commands[name]!(input);
    } finally {
      actor = self;
    }
  };
  if (browser.window !== undefined) {
    browser.window[DEMO_COLLEAGUE_HOOK] = { run: colleague };
  }

  // The browser stand-in for the print dialog: the slip opens in a new tab, ready for Ctrl+P, so a
  // reviewer sees the very page a phone would print. "Share" downloads the same page.
  const printing: RepairPrinting = {
    storeName: () => Promise.resolve('Bolusi Wamena'),
    userName: () => Promise.resolve(actor.name),
    readPaper: () => Promise.resolve(paper),
    writePaper: (next) => {
      paper = next;
      return Promise.resolve();
    },
    output: (slip, how) => {
      const { window, document, Blob: PageBlob } = browser;
      if (window === undefined || document === undefined || PageBlob === undefined) {
        return Promise.resolve('done');
      }
      const url = URL.createObjectURL(new PageBlob([slip.html], { type: 'text/html' }));
      if (how === 'print') {
        window.open(url, '_blank');
        // A browser tab cannot say whether it was printed either, so the screen asks.
        return Promise.resolve('unconfirmed');
      }
      const link = document.createElement('a');
      link.href = url;
      link.download = `${slip.jobName}.html`;
      link.click();
      return Promise.resolve('done');
    },
    imageDataUri: (ref) => Promise.resolve(placeholderUri(ref.mediaId)),
  };

  // The parts shelf, with repair's say over which servisan may draw on it (repair/part-use.ts).
  const inventory = demoInventoryRuntime({
    now: HARNESS_NOW,
    actor: () => actor,
    checkUse: (ticketId, who) => {
      const t = find(ticketId);
      if (t.outcome === 'received') throw REPAIR_REFUSALS.refuse('partsNotInWork');
      if (who.permissions.includes(I.correctUse)) return t.ticketNumber;
      if (!partsInWork(t)) throw REPAIR_REFUSALS.refuse('partsNotInWork');
      if (t.technicianId !== who.userId && !who.permissions.includes(P.assign)) {
        throw REPAIR_REFUSALS.refuse('partsNotYours', { code: 'PERMISSION_DENIED' });
      }
      return t.ticketNumber;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    notify,
    searchModels: catalogModelSearch({
      query: (name: string, input: Input) => queries[name]!(input),
    } as unknown as Pick<RepairRuntime, 'query'>),
  });

  // A repaired phone that went home unpaid: the Kas unpaid list names its customer.
  const unpaid = tickets.find((t) => t.id === 't-9');
  const ledger = demoMoneyLedger(
    {
      now,
      accounts: DEMO_ACCOUNTS,
      actor: () => actor.userId,
      debt:
        unpaid === undefined
          ? undefined
          : { id: unpaid.id, label: unpaid.ticketNumber, amount: unpaid.quoteTotal },
    },
    notify,
  );
  // The QRIS method is connected to a Xendit test account; a paid QR lands as the server would
  // record it, lowering what the servisan or the debt still owes.
  const qris = demoQris({
    now: () => Date.now(),
    connectedAccounts: DEMO_ACCOUNTS.filter((row) => row.kind === 'qris').map((row) => row.id),
    onPaid: (body) => {
      ledger.recordPayment({
        id: body.id,
        document: body.document,
        account: `account:${body.accountId}`,
        amount: body.amount,
      });
      if ((ledger.documentMoney(body.document.id)?.charged ?? 0) === 0) {
        tickets = tickets.map((t) =>
          t.id === body.document.id
            ? withTotals({ ...t, downPayment: (t.downPayment ?? 0) + body.amount })
            : t,
        );
        notify();
      }
    },
  });
  // Everyone asks for and answers approvals; the decision's own permission says what.
  let permitted = new Set<string>([...actor.permissions, APPROVAL_PERMISSION.use]);
  const approvals = demoApprovals({
    kinds: {
      'repair.discount': {
        permission: P.discount,
        commandPermission: P.quoteChange,
        amount: (input) => -Number(input['amount']),
        targetId: (input) => String(input['ticketId']),
        apply: (input) => commands['changeQuote']!(input),
      },
      'repair.cancel': {
        permission: P.cancel,
        commandPermission: P.cancel,
        amount: (input) => {
          const standard = standardCancelFee(find(String(input['ticketId'])), cancelFees);
          return Math.max(0, standard - Number(input['fee'] ?? standard));
        },
        targetId: (input) => String(input['ticketId']),
        apply: (input) => commands['cancelTicket']!(input),
      },
      // A permit: approving changes nothing until the counter hands the phone over.
      'repair.payLater': {
        permission: MONEY_PERMISSION.extendCredit,
        commandPermission: MONEY_PERMISSION.extendCredit,
        amount: (input) => {
          const t = find(String(input['ticketId']));
          return Math.max(0, amountOwed(t) - (t.downPayment ?? 0));
        },
        targetId: (input) => String(input['ticketId']),
        apply: () => null,
      },
      // The demo counts a fix through the same method: what the DP goes down by.
      'repair.downPayment': {
        permission: P.correctDownPayment,
        commandPermission: P.correctDownPayment,
        amount: (input) =>
          Math.max(0, (find(String(input['ticketId'])).downPayment ?? 0) - Number(input['amount'])),
        targetId: (input) => String(input['ticketId']),
        apply: (input) => commands['correctDownPayment']!(input),
      },
    },
    actor: () => ({ userId: actor.userId, name: actor.name, can: (id) => permitted.has(id) }),
    now: () => HARNESS_NOW,
    notify,
    // The counter asked for a discount on the first servisan, waiting for an owner.
    seed: [
      {
        kind: 'repair.discount',
        input: {
          ticketId: 't-1',
          kind: 'discount',
          description: 'Diskon pelanggan tetap',
          amount: -25_000,
          reason: 'Pelanggan tetap, sudah 3 kali servis di sini',
          customerAgreed: false,
        },
        reason: 'Pelanggan tetap, sudah 3 kali servis di sini',
        by: DEMO_REPAIR_ROLES.counter,
        at: HARNESS_NOW - 20 * 60_000,
      },
    ],
  });
  const runtime = {
    inventory,
    get userId() {
      return actor.userId;
    },
    actAs: (next: DemoRepairRole) => {
      actor = DEMO_REPAIR_ROLES[next];
      permitted = new Set<string>([...actor.permissions, APPROVAL_PERMISSION.use]);
      notify();
    },
    query: (name: string, input: Input) => queries[name]!(input),
    run: (name: string, input: Input) => {
      try {
        return Promise.resolve(commands[name]!(input));
      } catch (error) {
        return Promise.reject(error);
      }
    },
    hasPermission: (id: string) => permitted.has(id),
    limitOf: (id: string) => demoLimitOf(actor, permitted, id),
    newId: () => `t-new-${String(counter)}-${String(Math.random()).slice(2, 8)}`,
    colleagueHasPermission: (userId: string, id: string) =>
      id === P.work ? TECHNICIANS.includes(userId) : false,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ticketSyncStatuses: () => Promise.resolve({ 't-1': ['local'] }),
    // The ledger as the screens read it: the store's methods, a servisan's payments and the Kas.
    money: {
      query: (name: string, input: Input) => {
        if (name === 'documentMoney') {
          const id = String(input['id']);
          const recorded = ledger.documentMoney(id);
          // A debt is the ledger's; a servisan still in the store keeps its DP on the ticket.
          if (recorded !== null && recorded.charged > 0) {
            return Promise.resolve({ rows: [recorded], nextCursor: null });
          }
          const paid = find(id).downPayment ?? 0;
          return Promise.resolve({
            rows: [
              {
                balance: -paid,
                charged: 0,
                reduced: 0,
                paid,
                entries: recorded?.entries ?? [],
              },
            ],
            nextCursor: null,
          });
        }
        return ledger.query(name, input);
      },
      qris,
      run: (name: string, input: Input) => ledger.run(name, input),
      hasPermission: (id: string) => permitted.has(id),
      colleagueHasPermission: () => false,
      limitOf: (id: string) => demoLimitOf(actor, permitted, id),
      newId: () => `m-new-${String(Math.random()).slice(2, 10)}`,
      stores: () => Promise.resolve(DEMO_STORES),
      get userId() {
        return actor.userId;
      },
    },
    approvals: {
      query: approvals.query,
      run: approvals.run,
      hasPermission: (id: string) => permitted.has(id),
      colleagueHasPermission: () => false,
      limitOf: (id: string) => demoLimitOf(actor, permitted, id),
      newId: () => `a-new-${String(Math.random()).slice(2, 10)}`,
      get userId() {
        return actor.userId;
      },
    },
    technicians: () =>
      Promise.resolve(TECHNICIANS.map((id) => ({ id, name: NAMES.get(id) ?? id }))),
    capturePhoto: () => Promise.resolve({ mediaRef: demoMedia() }),
    captureSignature: () => Promise.resolve({ mediaRef: demoMedia('image/png') }),
    pickPhoto: () => Promise.resolve({ mediaRef: demoMedia('image/png') }),
    recordVideo: () => Promise.resolve({ videoRef: demoVideo() }),
    // The demo has no clip to show; the player closes at once.
    playVideo: () => Promise.resolve(),
    printing,
    loadModelPhoto: demoModelPhoto,
    loadThumbnail: (ref: ThumbnailRef) =>
      Promise.resolve({ kind: 'ready', uri: placeholderUri(ref.mediaId) }),
    // The browser stand-in for the share sheet: a download of the same file.
    sharePhoto: (ref: ThumbnailRef) => {
      if (browser.document === undefined) return Promise.resolve('failed');
      const link = browser.document.createElement('a');
      link.href = placeholderUri(ref.mediaId);
      link.download = `${ref.mediaId}.svg`;
      link.click();
      return Promise.resolve('done');
    },
  };
  return runtime as unknown as DemoRepairRuntime;
}
