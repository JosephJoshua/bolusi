/**
 * KasHome — the money surface at the shell's Kas tab, built like `RepairHome`: it owns the board →
 * step navigation as local state, binds the money runtime once and publishes its back to the
 * shell while a step is open, so hardware back closes the step instead of leaving Kas.
 */
import {
  CountCashStep,
  KasBoard,
  KasHistory,
  MoneyRuntimeProvider,
  MoveCashStep,
  ReceiveDebtStep,
  ReduceChargeStep,
  RefundStep,
  SettleCountStep,
  VoidPaymentStep,
  type CashCountRow,
  type MoneyEntryRow,
  targetOf,
  type MoneyRuntime,
  type MoneyTarget,
  type NamedBalance,
} from '@bolusi/modules/money/screens';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { ta } from '@bolusi/modules/approvals/screens';
import type { DiscardGuard } from '@bolusi/modules/screen-kit';

import type { SurfaceNav } from '../../navigation/surface.js';

type KasView =
  | { readonly kind: 'board' }
  | { readonly kind: 'count' }
  | { readonly kind: 'move' }
  | { readonly kind: 'settle'; readonly count: CashCountRow }
  | { readonly kind: 'receive'; readonly balance: NamedBalance }
  | { readonly kind: 'reduce'; readonly target: MoneyTarget }
  | { readonly kind: 'refund'; readonly target: MoneyTarget }
  | { readonly kind: 'history' }
  | { readonly kind: 'void'; readonly entry: MoneyEntryRow };

export interface KasHomeProps {
  readonly runtime: MoneyRuntime;
  readonly now: () => number;
  readonly syncChip: ReactNode;
  readonly avatar: ReactNode;
  /** Published while a step is open, so hardware back closes it; null on the board. */
  readonly onRegisterSurfaceNav?: ((nav: SurfaceNav | null) => void) | undefined;
}

export function KasHome({
  runtime,
  now,
  syncChip,
  avatar,
  onRegisterSurfaceNav,
}: KasHomeProps): React.JSX.Element {
  const [view, setView] = useState<KasView>({ kind: 'board' });
  // The day Riwayat shows, kept here so it is still there back from a payment.
  const [historyDay, setHistoryDay] = useState<number | null>(null);
  // Said in Riwayat once an owner has been asked to cancel a payment.
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeEntryId, setNoticeEntryId] = useState<string | null>(null);
  // A refund or lower bill asked of an owner from the board, said there until the board is left;
  // a turned-down answer shows on the board too.
  const [boardNotice, setBoardNotice] = useState<string | null>(null);
  const guardRef = useRef<DiscardGuard | null>(null);
  const registerGuard = useCallback((guard: DiscardGuard | null): void => {
    guardRef.current = guard;
  }, []);
  const toBoard = (): void => setView({ kind: 'board' });
  const askedFromBoard = (): void => {
    setBoardNotice(ta('approvals.done.asked'));
    toBoard();
  };
  useEffect(() => {
    if (view.kind !== 'board') setBoardNotice(null);
  }, [view.kind]);
  // A step with something typed asks before it is dropped, on back and on leaving home alike.
  const leave = useCallback((proceed: () => void): void => {
    const guard = guardRef.current;
    if (guard === null) proceed();
    else guard(proceed);
  }, []);
  const toHistory = (): void => setView({ kind: 'history' });
  // Inside a step the header keeps only the sync chip, as in repair's flows.
  const stepChrome = { syncChip, avatar: null };

  useEffect(() => {
    if (view.kind === 'board') {
      onRegisterSurfaceNav?.(null);
      return;
    }
    onRegisterSurfaceNav?.({
      handleBack: () => {
        leave(() => setView({ kind: view.kind === 'void' ? 'history' : 'board' }));
        return true;
      },
      requestLeave: leave,
    });
    return () => onRegisterSurfaceNav?.(null);
  }, [view, onRegisterSurfaceNav, leave]);

  const screen = (() => {
    switch (view.kind) {
      case 'board':
        return (
          <KasBoard
            chrome={{ syncChip, avatar }}
            now={now}
            onCount={() => setView({ kind: 'count' })}
            onMove={() => setView({ kind: 'move' })}
            onSettle={(count) => setView({ kind: 'settle', count })}
            onReceive={(balance) => setView({ kind: 'receive', balance })}
            onRefund={(balance) => setView({ kind: 'refund', target: targetOf(balance) })}
            onHistory={() => {
              setHistoryDay(null);
              toHistory();
            }}
            notice={boardNotice}
            onClearNotice={() => setBoardNotice(null)}
          />
        );
      case 'count':
        return (
          <CountCashStep
            chrome={stepChrome}
            onRegisterDiscardGuard={registerGuard}
            onDone={toBoard}
            onCancel={toBoard}
          />
        );
      case 'move':
        return (
          <MoveCashStep
            chrome={stepChrome}
            onRegisterDiscardGuard={registerGuard}
            onDone={toBoard}
            onCancel={toBoard}
          />
        );
      case 'settle':
        return (
          <SettleCountStep
            chrome={stepChrome}
            count={view.count}
            onRegisterDiscardGuard={registerGuard}
            onDone={toBoard}
            onCancel={toBoard}
          />
        );
      case 'receive':
        return (
          <ReceiveDebtStep
            chrome={stepChrome}
            balance={view.balance}
            onReduce={() =>
              leave(() => setView({ kind: 'reduce', target: targetOf(view.balance) }))
            }
            onRegisterDiscardGuard={registerGuard}
            onDone={toBoard}
            onCancel={toBoard}
          />
        );
      case 'reduce':
        return (
          <ReduceChargeStep
            chrome={stepChrome}
            target={view.target}
            onRegisterDiscardGuard={registerGuard}
            onDone={toBoard}
            onAsked={askedFromBoard}
            onCancel={toBoard}
          />
        );
      case 'refund':
        return (
          <RefundStep
            chrome={stepChrome}
            target={view.target}
            onRegisterDiscardGuard={registerGuard}
            onDone={toBoard}
            onAsked={askedFromBoard}
            onCancel={toBoard}
          />
        );
      case 'history':
        return (
          <KasHistory
            chrome={stepChrome}
            now={now}
            day={historyDay}
            onDay={setHistoryDay}
            onBack={toBoard}
            onVoid={(entry) => {
              setNotice(null);
              setView({ kind: 'void', entry });
            }}
            notice={notice}
            noticeEntryId={noticeEntryId}
            onClearNotice={() => setNotice(null)}
          />
        );
      case 'void':
        return (
          <VoidPaymentStep
            chrome={stepChrome}
            entry={view.entry}
            onRegisterDiscardGuard={registerGuard}
            onDone={toHistory}
            onAsked={() => {
              setNotice(ta('approvals.done.asked'));
              setNoticeEntryId(view.entry.id);
              toHistory();
            }}
            onCancel={toHistory}
          />
        );
    }
  })();

  return <MoneyRuntimeProvider runtime={runtime}>{screen}</MoneyRuntimeProvider>;
}
