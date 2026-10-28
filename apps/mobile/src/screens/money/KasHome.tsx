/**
 * KasHome — the money surface at the shell's Kas tab, built like `RepairHome`: it owns the board →
 * step navigation as local state, binds the money runtime once and publishes its back to the
 * shell while a step is open, so hardware back closes the step instead of leaving Kas.
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
  type NamedBalance,
} from '@bolusi/modules/money/screens';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type { DiscardGuard } from '@bolusi/modules/screen-kit';

import type { SurfaceNav } from '../../navigation/surface.js';

type KasView =
  | { readonly kind: 'board' }
  | { readonly kind: 'count' }
  | { readonly kind: 'move' }
  | { readonly kind: 'settle'; readonly count: CashCountRow }
  | { readonly kind: 'receive'; readonly balance: NamedBalance };

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
  const guardRef = useRef<DiscardGuard | null>(null);
  const registerGuard = useCallback((guard: DiscardGuard | null): void => {
    guardRef.current = guard;
  }, []);
  const toBoard = (): void => setView({ kind: 'board' });
  // Inside a step the header keeps only the sync chip, as in repair's flows.
  const stepChrome = { syncChip, avatar: null };

  useEffect(() => {
    if (view.kind === 'board') {
      onRegisterSurfaceNav?.(null);
      return;
    }
    // A step with something typed asks before it is dropped, on back and on leaving home alike.
    const leave = (proceed: () => void): void => {
      const guard = guardRef.current;
      if (guard === null) proceed();
      else guard(proceed);
    };
    onRegisterSurfaceNav?.({
      handleBack: () => {
        leave(() => setView({ kind: 'board' }));
        return true;
      },
      requestLeave: leave,
    });
    return () => onRegisterSurfaceNav?.(null);
  }, [view, onRegisterSurfaceNav]);

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
            onRegisterDiscardGuard={registerGuard}
            onDone={toBoard}
            onCancel={toBoard}
          />
        );
    }
  })();

  return <MoneyRuntimeProvider runtime={runtime}>{screen}</MoneyRuntimeProvider>;
}
