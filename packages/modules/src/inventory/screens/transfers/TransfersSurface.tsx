/**
 * TransfersSurface — "Kiriman": parts sent between this store and the business's others, and
 * everything reached from them (a transfer, sending one, receiving one, settling one), as local
 * navigation like PurchasingSurface: a section of the Barang place. The send being written lives
 * here, so a trip to pick a part comes back to it. While anything is open it publishes a
 * `PlaceStep`, so back closes the open step first.
 */
import { useDoneNote } from '../../../screen-kit/index.js';
import { EmptyState, ListDetail, useListDetailSplit } from '@bolusi/ui';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { DiscardGuard, PlaceStep } from '../../../screen-kit/index.js';
import type { PlaceHeader, ScreenChrome } from '../../../screen-kit/screens/views.js';
import { ti, type InventoryKey } from '../../i18n.js';
import { EMPTY_SEND, addSendLine, sendChanged, type SendDraft } from '../../transfers/form.js';
import type { TransferDetailRow, TransferFilter } from '../../transfers/queries.js';
import { PickPartStep } from '../PickPartStep.js';
import { ReceiveTransferStep } from './ReceiveTransferStep.js';
import { SendForm } from './SendForm.js';
import { SettleStep } from './SettleStep.js';
import { TransferDetail } from './TransferDetail.js';
import { TransferList } from './TransferList.js';

type View =
  | { readonly kind: 'list' }
  | { readonly kind: 'transfer'; readonly transferId: string }
  | { readonly kind: 'send' }
  | { readonly kind: 'pick' }
  | { readonly kind: 'receive'; readonly transfer: TransferDetailRow }
  | { readonly kind: 'settle'; readonly transfer: TransferDetailRow };

export interface TransfersSurfaceProps {
  readonly chrome: ScreenChrome;
  readonly place: PlaceHeader;
  readonly onRegisterPlaceStep?: ((step: PlaceStep | null) => void) | undefined;
  readonly onRegisterDiscardGuard?: ((guard: DiscardGuard | null) => void) | undefined;
}

export function TransfersSurface({
  chrome,
  place,
  onRegisterPlaceStep,
  onRegisterDiscardGuard,
}: TransfersSurfaceProps): React.JSX.Element {
  const [view, setView] = useState<View>({ kind: 'list' });
  const [filter, setFilter] = useState<TransferFilter>('open');
  const { note: notice, say: setNotice } = useDoneNote<InventoryKey>((key) => ti(key));
  const [draft, setDraft] = useState<SendDraft>(EMPTY_SEND);
  const guardRef = useRef<DiscardGuard | null>(null);
  const registerGuard = useCallback(
    (guard: DiscardGuard | null): void => {
      guardRef.current = guard;
      onRegisterDiscardGuard?.(guard);
    },
    [onRegisterDiscardGuard],
  );

  const closeSend = useCallback((): void => {
    setDraft(EMPTY_SEND);
    setView({ kind: 'list' });
  }, []);

  // On a wide screen the list stays beside the open transfer. Sending, receiving and settling are
  // tasks of their own and keep the whole screen.
  const beside = view.kind === 'list' || view.kind === 'transfer';
  const split = useListDetailSplit() && beside;

  useEffect(() => {
    if (view.kind === 'list') {
      onRegisterPlaceStep?.(null);
      return;
    }
    const back = (): void => {
      switch (view.kind) {
        case 'transfer':
          setView({ kind: 'list' });
          return;
        case 'send': {
          const guard = guardRef.current;
          if (guard === null) closeSend();
          else guard(closeSend);
          return;
        }
        case 'pick':
          setView({ kind: 'send' });
          return;
        case 'receive':
        case 'settle':
          setView({ kind: 'transfer', transferId: view.transfer.id });
          return;
      }
    };
    onRegisterPlaceStep?.({ back, listBeside: split });
    return () => onRegisterPlaceStep?.(null);
  }, [view, split, closeSend, onRegisterPlaceStep]);

  const openTransfer = (transferId: string, done: InventoryKey | null = null): void => {
    setNotice(done);
    setView({ kind: 'transfer', transferId });
  };

  const paneChrome: ScreenChrome = split ? { syncChip: null, avatar: null } : chrome;
  const openId = view.kind === 'transfer' ? view.transferId : null;

  const list = (
    <TransferList
      chrome={chrome}
      filter={filter}
      onFilter={setFilter}
      place={place}
      onOpen={(transferId) => {
        if (transferId !== openId) openTransfer(transferId);
      }}
      onSend={() => {
        setDraft(EMPTY_SEND);
        setView({ kind: 'send' });
      }}
      selectedId={split ? openId : null}
    />
  );

  const detail =
    view.kind === 'transfer' ? (
      <TransferDetail
        key={view.transferId}
        transferId={view.transferId}
        chrome={paneChrome}
        hideBack={split}
        onBack={() => setView({ kind: 'list' })}
        onReceive={(transfer) => setView({ kind: 'receive', transfer })}
        onSettle={(transfer) => setView({ kind: 'settle', transfer })}
        notice={notice}
        onClearNotice={() => setNotice(null)}
      />
    ) : split ? (
      <EmptyState
        title={ti('inventory.transfer.list.pick')}
        testID="inventory.transfers.noneOpen"
      />
    ) : null;

  return (
    <ListDetail
      split={split}
      list={split || view.kind === 'list' ? list : null}
      detail={detail}
      testID="inventory.transfers.split"
    >
      {beside ? null : fullScreen()}
    </ListDetail>
  );

  function fullScreen(): React.JSX.Element | null {
    switch (view.kind) {
      case 'list':
      case 'transfer':
        return null;
      case 'send':
        return (
          <SendForm
            chrome={chrome}
            draft={draft}
            onChange={setDraft}
            onPickPart={() => setView({ kind: 'pick' })}
            onDone={(transferId) => {
              setDraft(EMPTY_SEND);
              openTransfer(transferId, 'inventory.transfer.done.sent');
            }}
            onCancel={closeSend}
            dirty={sendChanged(draft)}
            onRegisterDiscardGuard={registerGuard}
          />
        );
      case 'pick':
        return (
          <PickPartStep
            chrome={chrome}
            title={ti('inventory.pick.title')}
            picked={new Set(draft.lines.map((line) => line.itemId))}
            onPick={(item) => {
              setDraft((now) => addSendLine(now, item));
              setView({ kind: 'send' });
            }}
            onCancel={() => setView({ kind: 'send' })}
            testID="inventory.send.pick"
          />
        );
      case 'receive':
        return (
          <ReceiveTransferStep
            chrome={chrome}
            transfer={view.transfer}
            onDone={() => openTransfer(view.transfer.id, 'inventory.transfer.done.received')}
            onCancel={() => setView({ kind: 'transfer', transferId: view.transfer.id })}
          />
        );
      case 'settle':
        return (
          <SettleStep
            chrome={chrome}
            transfer={view.transfer}
            onDone={() => openTransfer(view.transfer.id, 'inventory.transfer.done.settled')}
            onCancel={() => setView({ kind: 'transfer', transferId: view.transfer.id })}
          />
        );
    }
  }
}
