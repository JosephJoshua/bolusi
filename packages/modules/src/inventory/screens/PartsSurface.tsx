/**
 * PartsSurface — the parts list and everything reached from it (a part, adding, editing, counting),
 * as local navigation like RepairHome. Back closes the open step first, then the part, then the
 * surface, through the registered step back.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { DiscardGuard, StepBack } from '../../screen-kit/index.js';
import type { ScreenChrome } from '../../screen-kit/screens/views.js';
import type { InventoryKey } from '../i18n.js';
import type { PartRow } from '../queries.js';
import { CountStep } from './CountStep.js';
import { PartDetail } from './PartDetail.js';
import { PartForm } from './PartForm.js';
import { PartList } from './PartList.js';

type View =
  | { readonly kind: 'list' }
  | { readonly kind: 'part'; readonly partId: string }
  | { readonly kind: 'add' }
  | { readonly kind: 'edit'; readonly part: PartRow }
  | { readonly kind: 'count'; readonly part: PartRow };

export interface PartsSurfaceProps {
  readonly chrome: ScreenChrome;
  readonly onClose: () => void;
  readonly onOpenSyncStatus: () => void;
  readonly onRegisterStepBack?: ((back: StepBack | null) => void) | undefined;
  readonly onRegisterDiscardGuard?: ((guard: DiscardGuard | null) => void) | undefined;
}

export function PartsSurface({
  chrome,
  onClose,
  onOpenSyncStatus,
  onRegisterStepBack,
  onRegisterDiscardGuard,
}: PartsSurfaceProps): React.JSX.Element {
  const [view, setView] = useState<View>({ kind: 'list' });
  const [notice, setNotice] = useState<InventoryKey | null>(null);
  const guardRef = useRef<DiscardGuard | null>(null);
  const registerGuard = useCallback(
    (guard: DiscardGuard | null): void => {
      guardRef.current = guard;
      onRegisterDiscardGuard?.(guard);
    },
    [onRegisterDiscardGuard],
  );

  const back = useCallback((): boolean => {
    const leave = (to: View): void => {
      const guard = guardRef.current;
      if (guard === null) setView(to);
      else guard(() => setView(to));
    };
    switch (view.kind) {
      case 'list':
        return false;
      case 'part':
      case 'add':
        leave({ kind: 'list' });
        return true;
      case 'edit':
      case 'count':
        leave({ kind: 'part', partId: view.part.id });
        return true;
    }
  }, [view]);

  useEffect(() => {
    onRegisterStepBack?.(back);
    return () => onRegisterStepBack?.(null);
  }, [back, onRegisterStepBack]);

  const openPart = (partId: string, done: InventoryKey | null = null): void => {
    setNotice(done);
    setView({ kind: 'part', partId });
  };

  switch (view.kind) {
    case 'list':
      return (
        <PartList
          chrome={chrome}
          onBack={onClose}
          onOpenPart={(partId) => openPart(partId)}
          onAddPart={() => setView({ kind: 'add' })}
          onOpenSyncStatus={onOpenSyncStatus}
        />
      );
    case 'part':
      return (
        <PartDetail
          partId={view.partId}
          chrome={chrome}
          onBack={() => setView({ kind: 'list' })}
          onEdit={(part) => setView({ kind: 'edit', part })}
          onCount={(part) => setView({ kind: 'count', part })}
          notice={notice}
          onClearNotice={() => setNotice(null)}
        />
      );
    case 'add':
      return (
        <PartForm
          chrome={chrome}
          onDone={(partId) => openPart(partId, 'inventory.done.added')}
          onCancel={() => setView({ kind: 'list' })}
          onRegisterDiscardGuard={registerGuard}
        />
      );
    case 'edit':
      return (
        <PartForm
          chrome={chrome}
          part={view.part}
          onDone={(partId) => openPart(partId, 'inventory.done.saved')}
          onCancel={() => openPart(view.part.id)}
          onRegisterDiscardGuard={registerGuard}
        />
      );
    case 'count':
      return (
        <CountStep
          chrome={chrome}
          part={view.part}
          onDone={() => openPart(view.part.id, 'inventory.done.counted')}
          onCancel={() => openPart(view.part.id)}
          onRegisterDiscardGuard={registerGuard}
        />
      );
  }
}
