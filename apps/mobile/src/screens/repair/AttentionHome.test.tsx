// Perlu dicek over a real runtime, beside Servisan as the shell puts them: the owner sees the
// counter's request with its servisan, a tap opens the answer itself, and backing out of the
// servisan comes back to Perlu dicek with the request gone.
import { DEFAULT_LOCALE, setLocale } from '@bolusi/i18n';
import idMoneyCatalog from '@bolusi/modules/money/i18n/id.json';
import enMoneyCatalog from '@bolusi/modules/money/i18n/en.json';
import { registerMoneyCatalog } from '@bolusi/modules/money/screens';
import type { PlaceOpen } from '@bolusi/modules/screen-kit';
import { tn } from '@bolusi/modules/repair/screens';
import { useState } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  ensureRepairCatalog,
  intake,
  openRepairScreenHarness,
  press,
  render,
  repairRuntimeFor,
  settle,
  text,
  USER_NAMES,
  type RepairHarness,
  waitUntil,
} from '../../../test/repair-support.js';

import { AttentionHome, type AttentionTarget } from './AttentionHome.js';
import { RepairHome, type RepairOpenTarget } from './RepairHome.js';

let h: RepairHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
  setLocale(DEFAULT_LOCALE);
});

const NOW = new Date(2026, 9, 25, 10, 0).getTime();

/** Perlu dicek and Servisan, one showing at a time, joined the way the shell joins them. */
function Places({
  harness,
  userId,
  refused = 0,
  onOther,
}: {
  readonly harness: RepairHarness;
  readonly userId: string;
  readonly refused?: number;
  readonly onOther?: (target: AttentionTarget) => void;
}): React.JSX.Element {
  const [shown, setShown] = useState<'attention' | 'repair'>('attention');
  const [open, setOpen] = useState<PlaceOpen<RepairOpenTarget> | null>(null);
  const runtime = repairRuntimeFor(harness, userId);
  return (
    <>
      {shown === 'attention' ? (
        <AttentionHome
          runtime={runtime}
          now={() => NOW}
          refused={refused}
          syncChip={null}
          avatar={null}
          onOpen={(target) => {
            if (target.place !== 'repair') {
              onOther?.(target);
              return;
            }
            setOpen((last) => ({ nonce: (last?.nonce ?? 0) + 1, target: target.open }));
            setShown('repair');
          }}
          onOpenSyncStatus={vi.fn()}
        />
      ) : null}
      {shown === 'repair' ? (
        <RepairHome
          runtime={runtime}
          now={() => NOW}
          syncChip={null}
          avatar={null}
          onOpenSyncStatus={vi.fn()}
          open={open}
          onReturn={() => setShown('attention')}
        />
      ) : null}
    </>
  );
}

async function mount(
  harness: RepairHarness,
  userId: string,
  props: { readonly refused?: number; readonly onOther?: (target: AttentionTarget) => void } = {},
) {
  ensureRepairCatalog();
  registerMoneyCatalog({ id: idMoneyCatalog, en: enMoneyCatalog });
  const screen = render(<Places harness={harness} userId={userId} {...props} />);
  await settle();
  return screen;
}

async function askDiscount(
  harness: RepairHarness,
): Promise<{ ticketId: string; requestId: string }> {
  const { ticketId } = (await harness.run('openTicket', intake(harness), harness.cashierId)) as {
    ticketId: string;
  };
  const { requestId } = (await harness.approvals(
    'requestApproval',
    {
      kind: 'repair.discount',
      input: {
        ticketId,
        kind: 'discount',
        description: 'Diskon langganan',
        amount: -20_000,
        reason: 'Pelanggan langganan',
        customerAgreed: true,
      },
      reason: 'Pelanggan minta',
    },
    harness.cashierId,
  )) as { requestId: string };
  return { ticketId, requestId };
}

describe('Perlu dicek', () => {
  test('with nothing waiting says so, without empty sections', async () => {
    h = await openRepairScreenHarness(7301);
    const screen = await mount(h, h.storeOwnerId);
    expect(text(screen, 'attention.empty.title')).toBe(tn('repair.attention.empty'));
    expect(screen.query('attention.requests')).toBeNull();
    expect(screen.query('attention.lists')).toBeNull();
  });

  test('opens a request on its answer, and back from the servisan comes back here', async () => {
    h = await openRepairScreenHarness(7302);
    const { ticketId, requestId } = await askDiscount(h);
    const screen = await mount(h, h.storeOwnerId);

    const row = `attention.request.${requestId}`;
    expect(await waitUntil(() => screen.query(row) !== null)).toBe(true);
    const label = String(screen.all(row)[0]!.props['accessibilityLabel']);
    // What it is, what it is worth, which servisan, who asked and why.
    expect(label).toContain('Rp');
    expect(label).toContain(USER_NAMES.cashier);
    expect(label).toContain('Pelanggan minta');
    const number = (await h.query('getTicket', { ticketId }, h.cashierId)).rows[0]!.ticketNumber;
    expect(label).toContain(String(number));

    await press(screen, row);
    // Straight on the answer, not on the servisan with the request somewhere below.
    expect(screen.query('repair.ticket.approval.primary')).not.toBeNull();
    await press(screen, 'repair.ticket.approval.primary');
    expect(
      await waitUntil(async () => {
        const [line] = (await h!.approvalsQuery('approvalRequest', { requestId }, h!.cashierId))
          .rows;
        return line?.['status'] === 'approved';
      }),
    ).toBe(true);
    // On the servisan now, with the answer given; its back arrow returns to Perlu dicek.
    await press(screen, 'repair.ticket.back');
    expect(await waitUntil(() => screen.query('attention.empty') !== null)).toBe(true);
    expect(screen.query(row)).toBeNull();
  });

  test('is not given requests the person may not answer, and counts what else waits', async () => {
    h = await openRepairScreenHarness(7303);
    const { requestId } = await askDiscount(h);
    // The counter asked it: theirs to wait on, not to answer.
    const counter = await mount(h, h.cashierId, { refused: 2 });
    expect(counter.query(`attention.request.${requestId}`)).toBeNull();
    counter.unmount();

    const other = vi.fn();
    const owner = await mount(h, h.storeOwnerId, { refused: 2, onOther: other });
    expect(text(owner, 'attention.list.refused')).toContain('2');
    await press(owner, 'attention.list.refused');
    expect(other).toHaveBeenCalledWith({ place: 'syncStatus' });
  });
});
