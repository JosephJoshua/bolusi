/**
 * KasHome — the money surface at the shell's Kas tab, built like `RepairHome`: it owns the board →
 * step navigation as local state, binds the money runtime once and publishes its back to the
 * shell, so hardware back closes an open step instead of leaving Kas.
 */
import {
  CountCashStep,
  KasBoard,
  MoneyRuntimeProvider,
  MoveCashStep,
  ReceiveDebtStep,
  SettleCountStep,
  type CashCountRow,
  type MoneyRuntime,
  type OpenBalanceRow,
} from '@bolusi/modules/money/screens';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import type { SurfaceNav } from '../../navigation/surface.js';

type KasView =
  | { readonly kind: 'board' }
  | { readonly kind: 'count' }
  | { readonly kind: 'move' }
  | { readonly kind: 'settle'; readonly count: CashCountRow }
  | { readonly kind: 'receive'; readonly balance: OpenBalanceRow };

export interface KasHomeProps {
  readonly runtime: MoneyRuntime;
  readonly now: () => number;
  readonly syncChip: ReactNode;
  readonly avatar: ReactNode;
  readonly onRegisterSurfaceNav?: ((nav: SurfaceNav | null) => void) | undefined;
  /** Hardware back on the board: Kas is a tab, so back goes to the first one instead of leaving. */
  readonly onBackAtRoot: () => void;
}

export function KasHome({
  runtime,
  now,
  syncChip,
  avatar,
  onRegisterSurfaceNav,
  onBackAtRoot,
}: KasHomeProps): React.JSX.Element {
  const [view, setView] = useState<KasView>({ kind: 'board' });
  const toBoard = (): void => setView({ kind: 'board' });
  // Inside a step the header keeps only the sync chip, as in repair's flows.
  const stepChrome = { syncChip, avatar: null };

  useEffect(() => {
    onRegisterSurfaceNav?.({
      handleBack: () => {
        if (view.kind === 'board') onBackAtRoot();
        else setView({ kind: 'board' });
        return true;
      },
      requestLeave: (proceed) => proceed(),
    });
    return () => onRegisterSurfaceNav?.(null);
  }, [view, onRegisterSurfaceNav, onBackAtRoot]);

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
          />
        );
      case 'count':
        return <CountCashStep chrome={stepChrome} onDone={toBoard} onCancel={toBoard} />;
      case 'move':
        return <MoveCashStep chrome={stepChrome} onDone={toBoard} onCancel={toBoard} />;
      case 'settle':
        return (
          <SettleCountStep
            chrome={stepChrome}
            count={view.count}
            onDone={toBoard}
            onCancel={toBoard}
          />
        );
      case 'receive':
        return (
          <ReceiveDebtStep
            chrome={stepChrome}
            balance={view.balance}
            onDone={toBoard}
            onCancel={toBoard}
          />
        );
    }
  })();

  return <MoneyRuntimeProvider runtime={runtime}>{screen}</MoneyRuntimeProvider>;
}
