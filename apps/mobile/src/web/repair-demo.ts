/**
 * A `RepairRuntime` over in-memory demo tickets for the browser harness, the repair twin of
 * `demoNotesRuntime`. The real runtime needs SQLite, which a browser cannot load, so the harness
 * renders the REAL repair screens over this fake. Commands mutate the demo data and notify, so the
 * flows (intake, start, repaired, price change, handover) genuinely move a ticket along.
 *
 * Photos resolve to a labelled grey placeholder image, never anything that looks like a real photo.
 */
import { FuzzyIndex } from '@bolusi/core';
import type { MediaRef, ThumbnailRef } from '@bolusi/schemas';
import {
  IN_PROGRESS_OUTCOMES,
  DEFAULT_INTAKE_OPTIONS,
  NOTHING_HIDDEN,
  REPAIR_PERMISSION,
  type IntakeOptionSettings,
  type QuoteLineRow,
  type RepairOutcome,
  type TicketDetailRow,
  type TicketPhotoRow,
} from '@bolusi/modules/repair';
import type { RepairRuntime } from '@bolusi/modules/repair/screens';

import { HARNESS_NOW } from './seed.js';

const HOUR = 3_600_000;
const P = REPAIR_PERMISSION;

/** Who the harness can act as: the owner (everything), the counter and a technician. */
export const DEMO_REPAIR_ROLES = {
  owner: { userId: 'u-andi', name: 'Andi Pratama', permissions: Object.values(P) },
  counter: {
    userId: 'u-siti',
    name: 'Siti Rahayu',
    permissions: [P.read, P.intake, P.assign, P.quoteChange, P.cancel, P.handover],
  },
  technician: { userId: 'u-budi', name: 'Budi Santoso', permissions: [P.read, P.work] },
  /** A store owner: may choose what this store uses, not change the franchise's lists. */
  storeOwner: {
    userId: 'u-yosua',
    name: 'Yosua Wonda',
    permissions: [P.read, P.intake, P.hideIntakeOptions],
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
    outcomeNote: null,
    createdBy: 'u-siti',
    createdByName: 'Siti Rahayu',
    returnedBy: null,
    returnedAt: null,
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

export function demoRepairRuntime(role: DemoRepairRole = 'owner'): RepairRuntime {
  let actor: { readonly userId: string; readonly name: string } = DEMO_REPAIR_ROLES[role];
  let tickets = seedTickets();
  let counter = 13;
  let options: IntakeOptionSettings = { lists: DEFAULT_INTAKE_OPTIONS, hidden: NOTHING_HIDDEN };
  let optionIds = 0;
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
          .sort((a, b) => b.createdAt - a.createdAt)
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
  };

  const commands: Record<string, (input: Input) => unknown> = {
    openTicket: (input) => {
      const id = `t-new-${String(counter)}`;
      const number = `K7Q-${String(counter).padStart(4, '0')}`;
      counter += 1;
      const customer = input['customer'] as {
        name?: string;
        phone?: string | null;
        customerId?: string;
      };
      const existing = tickets.find((t) => t.customerId === customer.customerId);
      const device = input['device'] as { brand: string; model: string; color: string };
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
        complaint: String(input['complaint']),
        intakeNotes: String(input['intakeNotes'] ?? ''),
        checklist: input['checklist'] as TicketDetailRow['checklist'],
        peripherals: input['peripherals'] as TicketDetailRow['peripherals'],
        intakePhotos: photos.map(({ slot, label }) => ({ slot, label })),
        estimatedReadyAt: input['estimatedReadyAt'] as number | null,
        createdAt: HARNESS_NOW,
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
    cancelTicket: (input) =>
      update(String(input['ticketId']), 'repair.ticket_cancelled', {
        outcome: 'cancelled',
        outcomeNote: String(input['reason']),
      }),
    proposeQuoteChange: (input) => priceLine(input, 'proposed', 'repair.quote_change_proposed'),
    changeQuote: (input) => priceLine(input, 'applied', 'repair.quote_changed'),
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
    returnDevice: (input) => {
      const t = find(String(input['ticketId']));
      return update(t.id, 'repair.device_returned', {
        location: 'returned',
        returnedBy: actor.userId,
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

  const permitted = new Set<string>(DEMO_REPAIR_ROLES[role].permissions);
  const runtime = {
    userId: actor.userId,
    query: (name: string, input: Input) => queries[name]!(input),
    run: (name: string, input: Input) => {
      try {
        return Promise.resolve(commands[name]!(input));
      } catch (error) {
        return Promise.reject(error);
      }
    },
    hasPermission: (id: string) => permitted.has(id),
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
  return runtime as unknown as RepairRuntime;
}
