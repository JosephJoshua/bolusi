// What the customer's status page says about a servisan (product-scope.md, "Customers follow their
// repair online"), worked out from what the server sends (`PublicRepairStatus`). Platform-free and
// in the current language, so the page only lays it out and a later app can show the same words.
//
// Written for the customer, not the counter: their phone is "HP-mu", the steps are what they wait
// for ("Sedang diperbaiki", "Siap diambil"), and nothing names staff or internal states.
import { formatDate, formatDateTime, formatMoney } from '@bolusi/i18n';
import type { PublicRepairStatus, RepairStatusStep } from '@bolusi/schemas';

import { whatsAppNumber, whatsAppUrl } from '../shared/whatsapp.js';
import { tn, type RepairKey } from './i18n.js';
import { warrantyLine } from './labels.js';

// What the web page needs besides the view, so it loads this entry and not the whole module.
export { registerRepairCatalog, tn } from './i18n.js';
export { STATUS_PATH_PREFIX, displayStatusCode, normalizeStatusCode } from './status-link.js';

export type CustomerStatusTone = 'neutral' | 'warning' | 'success' | 'danger';

const STEP_KEY: Readonly<Record<RepairStatusStep, RepairKey>> = {
  received: 'repair.customerPage.step.received',
  in_repair: 'repair.customerPage.step.inRepair',
  waiting_for_parts: 'repair.customerPage.step.waitingForParts',
  repaired: 'repair.customerPage.step.repaired',
  cancelled: 'repair.customerPage.step.cancelled',
  returned: 'repair.customerPage.step.returned',
};

const STEP_TONE: Readonly<Record<RepairStatusStep, CustomerStatusTone>> = {
  received: 'neutral',
  in_repair: 'neutral',
  waiting_for_parts: 'warning',
  repaired: 'success',
  cancelled: 'danger',
  returned: 'success',
};

export interface CustomerPageRow {
  readonly label: string;
  readonly amount: string;
}

export interface CustomerPageView {
  readonly storeName: string;
  /** Address and phone, the lines a slip prints under the name. */
  readonly storeLines: readonly string[];
  /** "Servisan K7Q-0042". */
  readonly reference: string;
  readonly device: string;
  readonly status: string;
  readonly tone: CustomerStatusTone;
  /** One line under the status: when it should be done, or what to do now. */
  readonly statusHint: string | null;
  /** Changes of step, newest first. */
  readonly steps: readonly {
    readonly key: string;
    readonly title: string;
    readonly meta: string;
  }[];
  /** Price changes waiting for the customer's yes, signed: "+Rp 250.000". */
  readonly pendingPrices: readonly CustomerPageRow[];
  readonly money: {
    readonly rows: readonly CustomerPageRow[];
    /** The amount left to pay (or to get back), set apart under the rows. */
    readonly due: CustomerPageRow;
  };
  /** Each repair type with its warranty; the end date once the phone went home. */
  readonly warranty: readonly string[];
  /** While the phone is in the store: the warranty counts from pickup. */
  readonly warrantyNote: string | null;
  /** Chat with the store on WhatsApp, with a first line written; null without a usable number. */
  readonly whatsAppUrl: string | null;
  /** Call the store; null without a number. */
  readonly phoneUrl: string | null;
  /** "Diperbarui 28/10/2026 14.05". */
  readonly updated: string;
}

function signed(amount: number): string {
  return amount < 0 ? `−${formatMoney(-amount)}` : `+${formatMoney(amount)}`;
}

function statusHint(status: PublicRepairStatus): string | null {
  switch (status.status) {
    case 'received':
    case 'in_repair':
    case 'waiting_for_parts':
      return status.estimatedReadyAt === null
        ? null
        : tn('repair.customerPage.hint.estimate', { date: formatDate(status.estimatedReadyAt) });
    case 'repaired':
      return tn('repair.customerPage.hint.ready');
    case 'cancelled':
      return tn('repair.customerPage.hint.cancelled');
    case 'returned':
      return status.returnedAt === null
        ? null
        : tn('repair.customerPage.hint.returned', { date: formatDate(status.returnedAt) });
  }
}

function moneyOf(status: PublicRepairStatus): CustomerPageView['money'] {
  const { total, paid } = status.money;
  const rows: CustomerPageRow[] = [
    {
      label: tn(
        status.status === 'cancelled' ||
          (status.status === 'returned' && status.steps.some((s) => s.step === 'cancelled'))
          ? 'repair.customerPage.money.cancelFee'
          : 'repair.customerPage.money.total',
      ),
      amount: formatMoney(total),
    },
  ];
  if (paid !== 0)
    rows.push({ label: tn('repair.customerPage.money.paid'), amount: formatMoney(paid) });
  const due =
    paid > total
      ? { label: tn('repair.customerPage.money.overpaid'), amount: formatMoney(paid - total) }
      : {
          label: tn('repair.customerPage.money.due'),
          amount:
            paid === total ? tn('repair.customerPage.money.settled') : formatMoney(total - paid),
        };
  return { rows, due };
}

export function customerPageView(status: PublicRepairStatus): CustomerPageView {
  const number = whatsAppNumber(status.store.phone);
  const greeting = tn('repair.customerPage.whatsApp', {
    number: status.ticketNumber,
    device: status.device,
  });
  return {
    storeName: status.store.name,
    storeLines: [status.store.address, status.store.phone].filter((line) => line.trim() !== ''),
    reference: tn('repair.customerPage.reference', { number: status.ticketNumber }),
    device: status.device,
    status: tn(STEP_KEY[status.status]),
    tone: STEP_TONE[status.status],
    statusHint: statusHint(status),
    steps: status.steps
      .map((step, index) => ({
        key: `${step.step}-${String(index)}`,
        title: tn(STEP_KEY[step.step]),
        meta: formatDateTime(step.at),
      }))
      .reverse(),
    pendingPrices: status.pendingPrices.map((line) => ({
      label: line.description,
      amount: signed(line.amount),
    })),
    money: moneyOf(status),
    warranty: status.repairTypes.map((type) =>
      warrantyLine({ ...type, needsVideo: false }, status.returnedAt),
    ),
    warrantyNote:
      status.returnedAt === null && status.repairTypes.some((type) => type.warrantyDays > 0)
        ? tn('repair.warranty.fromPickup')
        : null,
    whatsAppUrl: number === null ? null : whatsAppUrl(number, greeting),
    phoneUrl: number === null ? null : `tel:+${number}`,
    updated: tn('repair.customerPage.updated', { date: formatDateTime(status.updatedAt) }),
  };
}
