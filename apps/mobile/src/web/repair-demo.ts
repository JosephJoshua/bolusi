/**
 * A `RepairRuntime` over in-memory demo tickets for the browser harness, the repair twin of
 * `demoNotesRuntime`. The real runtime needs SQLite, which a browser cannot load, so the harness
 * renders the REAL repair screens over this fake. Commands mutate the demo data and notify, so the
 * flows (intake, start, repaired, price change, handover) genuinely move a ticket along.
 *
 * Photos resolve to a labelled grey placeholder image, never anything that looks like a real photo.
 */
import { FuzzyIndex, type PaperSettings } from '@bolusi/core';
import type { MediaRef, ThumbnailRef } from '@bolusi/schemas';
import {
  IN_PROGRESS_OUTCOMES,
  DEFAULT_INTAKE_OPTIONS,
  NOTHING_HIDDEN,
  REPAIR_PERMISSION,
  REPAIR_REFUSALS,
  type IntakeOptionSettings,
  type PrintSettings,
  type QuoteLineRow,
  type RepairOutcome,
  type TicketDetailRow,
  type TicketPhotoRow,
} from '@bolusi/modules/repair';
import type { RepairPrinting, RepairRuntime } from '@bolusi/modules/repair/screens';

import {
  demoFindDeviceModel,
  demoModelPhoto,
  demoSearchDeviceModels,
} from './phone-catalog-demo.js';
import { HARNESS_NOW } from './seed.js';

const HOUR = 3_600_000;
const P = REPAIR_PERMISSION;

/** Who the harness can act as: the owner (everything), the counter and a technician. */
export const DEMO_REPAIR_ROLES = {
  owner: { userId: 'u-andi', name: 'Andi Pratama', permissions: Object.values(P) },
  counter: {
    userId: 'u-siti',
    name: 'Siti Rahayu',
    // No cancel or discount: only owners lower what a customer pays (how counter staff kept cash).
    permissions: [P.read, P.intake, P.assign, P.quoteChange, P.handover],
  },
  technician: { userId: 'u-budi', name: 'Budi Santoso', permissions: [P.read, P.work] },
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
    ],
  },
} as const;
export type DemoRepairRole = keyof typeof DEMO_REPAIR_ROLES;

/** The `window` key of the colleague hook `demoRepairRuntime` installs (browser tests only). */
export const DEMO_COLLEAGUE_HOOK = '__repairDemoColleague';

const NAMES = new Map<string, string>([
  ['u-andi', 'Andi Pratama'],
  ['u-siti', 'Siti Rahayu'],
  ['u-budi', 'Budi Santoso'],
  ['u-yosua', 'Yosua Wonda'],
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

function photoRow(slot: string, ref: MediaRef = demoMedia()): TicketPhotoRow {
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
    intakePhotos: INTAKE_SLOTS.map((slot) => ({ slot, label: null })),
    outcomeNote: spec.cancel?.reason ?? null,
    createdBy: 'u-siti',
    createdByName: 'Siti Rahayu',
    returnedBy: spec.returnedBy ?? null,
    returnedByName: spec.returnedBy === undefined ? null : (NAMES.get(spec.returnedBy) ?? null),
    returnedAt: spec.returnedBy === undefined ? null : createdAt + 40 * HOUR,
    downPayment: spec.downPayment ?? null,
    downPaymentBy: spec.downPayment === undefined ? null : 'u-siti',
    downPaymentByName: spec.downPayment === undefined ? null : 'Siti Rahayu',
    downPaymentAt: spec.downPayment === undefined ? null : createdAt,
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
      hoursAgo: 90,
      extraPhotos: [photoRow('before:m6')],
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
  ].map(withTotals);
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

/** The demo runtime, plus switching who acts, so "switch user" in the preview keeps the same tickets. */
export type DemoRepairRuntime = RepairRuntime & { actAs(role: DemoRepairRole): void };

/** The demo role a roster user signs in as, if they have one. */
export function demoRoleOf(userId: string): DemoRepairRole | undefined {
  return (Object.keys(DEMO_REPAIR_ROLES) as DemoRepairRole[]).find(
    (role) => DEMO_REPAIR_ROLES[role].userId === userId,
  );
}

export function demoRepairRuntime(role: DemoRepairRole = 'owner'): DemoRepairRuntime {
  let actor: (typeof DEMO_REPAIR_ROLES)[DemoRepairRole] = DEMO_REPAIR_ROLES[role];
  let tickets = seedTickets();
  let counter = 13;
  let options: IntakeOptionSettings = { lists: DEFAULT_INTAKE_OPTIONS, hidden: NOTHING_HIDDEN };
  let optionIds = 0;
  let cancelFees = { beforeWork: 0, afterWork: 50_000 };
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

  const find = (ticketId: string): TicketDetailRow => {
    const found = tickets.find((t) => t.id === ticketId);
    if (found === undefined)
      throw Object.assign(new Error('not found'), { code: 'ENTITY_NOT_FOUND' });
    return found;
  };
  const update = (ticketId: string, kind: string, patch: Partial<TicketDetailRow>) => {
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
                detail: {},
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
  const summary = (t: TicketDetailRow) => t;

  type Input = Record<string, unknown>;
  const queries: Record<string, (input: Input) => Promise<unknown>> = {
    listTickets: (input) => {
      const f = (input['filter'] ?? {}) as Record<string, unknown>;
      const outcomes = f['outcomes'] as string[] | undefined;
      return page(
        tickets
          .filter((t) => outcomes === undefined || outcomes.includes(t.outcome))
          .filter((t) => f['location'] === undefined || t.location === f['location'])
          .filter((t) => f['technicianId'] === undefined || t.technicianId === f['technicianId'])
          .filter((t) => f['unassigned'] !== true || t.technicianId === null)
          .filter((t) => input['sort'] !== 'cancelledAt.desc' || t.cancelledAt !== null)
          .sort((a, b) =>
            input['sort'] === 'cancelledAt.desc'
              ? (b.cancelledAt ?? 0) - (a.cancelledAt ?? 0)
              : b.createdAt - a.createdAt,
          )
          .map(summary),
      );
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
    searchTickets: (input) => {
      const index = new FuzzyIndex(
        tickets.map((t) => ({
          id: t.id,
          text: [t.customerName, t.deviceBrand, t.deviceModel],
          phones: [t.customerPhone],
          numbers: [t.deviceImei],
          codes: [t.ticketNumber],
          rank: t.createdAt,
        })),
      );
      return page(index.search(String(input['text']), 50).map((hit) => find(hit.id)));
    },
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
        index.search(String(input['text']), 10).map((hit) => {
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
    getTicket: (input) => page([find(String(input['ticketId']))]),
    intakeOptionSettings: () => page([options]),
    cancelFees: () => page([cancelFees]),
    printSettings: () => page([printSettings]),
  };

  const commands: Record<string, (input: Input) => unknown> = {
    openTicket: (input) => {
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
        intakePhotos: photos.map(({ slot, label }) => ({ slot, label })),
        estimatedReadyAt: input['estimatedReadyAt'] as number | null,
        createdAt: HARNESS_NOW,
        downPayment: Number(input['downPayment'] ?? 0) > 0 ? Number(input['downPayment']) : null,
        downPaymentBy: Number(input['downPayment'] ?? 0) > 0 ? actor.userId : null,
        downPaymentByName: Number(input['downPayment'] ?? 0) > 0 ? actor.name : null,
        downPaymentAt: Number(input['downPayment'] ?? 0) > 0 ? HARNESS_NOW : null,
        slipPrints: { intake: 0, handover: 0 },
        quoteLines: (
          input['quoteLines'] as {
            kind: QuoteLineRow['kind'];
            description: string;
            amount: number;
          }[]
        ).map((l) => line(l.kind, l.description, l.amount, { createdAt: HARNESS_NOW })),
        photos: photos.map(({ slot, ref }) => photoRow(slot, ref)),
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
        cancelStandardFee: t.workStarted ? cancelFees.afterWork : cancelFees.beforeWork,
        cancelledBy: actor.userId,
        cancelledByName: actor.name,
        cancelledAt: HARNESS_NOW,
      });
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
    changeQuote: (input) =>
      input['customerAgreed'] === true
        ? priceLine(input, 'applied', 'repair.quote_changed')
        : priceLine({ ...input, customerAgreed: undefined }, 'proposed', 'repair.quote_changed'),
    applyProposal: (input) => decide(input, 'applied', 'repair.quote_changed'),
    declineProposal: (input) => decide(input, 'declined', 'repair.quote_proposal_declined'),
    changeIntakeOptions: (input) => {
      const list = input['list'] as keyof IntakeOptionSettings['lists'];
      const items = (input['items'] as { id: string | null; label: string | null }[]).map(
        (item) => {
          optionIds += 1;
          return { id: item.id ?? `opt-${String(optionIds)}`, label: item.label };
        },
      );
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
        downPaymentBy: actor.userId,
        downPaymentByName: actor.name,
        downPaymentAt: HARNESS_NOW,
      }),
    correctDownPayment: (input) =>
      update(String(input['ticketId']), 'repair.down_payment_corrected', {
        downPayment: Number(input['amount']) > 0 ? Number(input['amount']) : null,
        downPaymentBy: actor.userId,
        downPaymentByName: actor.name,
        downPaymentAt: HARNESS_NOW,
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
      return update(t.id, 'repair.device_returned', {
        location: 'returned',
        returnedBy: actor.userId,
        returnedByName: actor.name,
        returnedAt: HARNESS_NOW,
        photos: [
          ...t.photos,
          photoRow('handover', input['handoverPhoto'] as MediaRef),
          photoRow('signature', input['signature'] as MediaRef),
        ],
      });
    },
  };

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
  if (typeof window !== 'undefined') {
    (window as unknown as Record<string, unknown>)[DEMO_COLLEAGUE_HOOK] = { run: colleague };
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
      if (typeof window === 'undefined') return Promise.resolve('done');
      const url = URL.createObjectURL(new Blob([slip.html], { type: 'text/html' }));
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

  let permitted = new Set<string>(actor.permissions);
  let ids = 0;
  const runtime = {
    get userId() {
      return actor.userId;
    },
    actAs: (next: DemoRepairRole) => {
      actor = DEMO_REPAIR_ROLES[next];
      permitted = new Set<string>(actor.permissions);
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
    newId: () => `t-new-id-${String((ids += 1))}`,
    colleagueHasPermission: (userId: string, id: string) =>
      id === P.work ? TECHNICIANS.includes(userId) : false,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ticketSyncStatuses: () => Promise.resolve({ 't-1': ['local'] }),
    technicians: () =>
      Promise.resolve(TECHNICIANS.map((id) => ({ id, name: NAMES.get(id) ?? id }))),
    capturePhoto: () => Promise.resolve({ mediaRef: demoMedia() }),
    captureSignature: () => Promise.resolve({ mediaRef: demoMedia('image/png') }),
    pickPhoto: () => Promise.resolve({ mediaRef: demoMedia('image/png') }),
    printing,
    loadModelPhoto: demoModelPhoto,
    loadThumbnail: (ref: ThumbnailRef) =>
      Promise.resolve({ kind: 'ready', uri: placeholderUri(ref.mediaId) }),
    // The browser stand-in for the share sheet: a download of the same file.
    sharePhoto: (ref: ThumbnailRef) => {
      if (typeof document === 'undefined') return Promise.resolve('failed');
      const link = document.createElement('a');
      link.href = placeholderUri(ref.mediaId);
      link.download = `${ref.mediaId}.svg`;
      link.click();
      return Promise.resolve('done');
    },
  };
  return runtime as unknown as DemoRepairRuntime;
}
