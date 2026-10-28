/**
 * PartsSurface — the items list and everything reached from it (an item, adding, editing, counting,
 * the filters, the owner's categories), as local navigation like RepairHome. The list's filter
 * lives here, so it holds across a trip into an item and back. Back closes the open step first, then the part, then the
 * surface, through the registered step back.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { DiscardGuard, StepBack } from '../../screen-kit/index.js';
import type { ScreenChrome } from '../../screen-kit/screens/views.js';
import type { InventoryKey } from '../i18n.js';
import { NO_CATEGORY, type CategoryRow, type ItemDetailRow, type ItemRow } from '../queries.js';
import { CategoryForm, CategoryList } from './CategoryScreens.js';
import { CountStep } from './CountStep.js';
import { FilterStep } from './FilterStep.js';
import { PartDetail } from './PartDetail.js';
import { PartForm } from './PartForm.js';
import { NO_FILTER, PartList, type ListFilter } from './PartList.js';

type View =
  | { readonly kind: 'list' }
  | { readonly kind: 'part'; readonly itemId: string }
  | { readonly kind: 'add' }
  | { readonly kind: 'edit'; readonly part: ItemDetailRow }
  | { readonly kind: 'count'; readonly part: ItemRow }
  | { readonly kind: 'filter' }
  | { readonly kind: 'categories' }
  | { readonly kind: 'category'; readonly category?: CategoryRow | undefined };

export interface PartsSurfaceProps {
  readonly chrome: ScreenChrome;
  readonly onClose: () => void;
  readonly onRegisterStepBack?: ((back: StepBack | null) => void) | undefined;
  readonly onRegisterDiscardGuard?: ((guard: DiscardGuard | null) => void) | undefined;
}

export function PartsSurface({
  chrome,
  onClose,
  onRegisterStepBack,
  onRegisterDiscardGuard,
}: PartsSurfaceProps): React.JSX.Element {
  const [view, setView] = useState<View>({ kind: 'list' });
  const [notice, setNotice] = useState<InventoryKey | null>(null);
  const [filter, setFilter] = useState<ListFilter>(NO_FILTER);
  const [categoryNotice, setCategoryNotice] = useState<string | null>(null);
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
      case 'filter':
      case 'categories':
        leave({ kind: 'list' });
        return true;
      case 'category':
        leave({ kind: 'categories' });
        return true;
      case 'edit':
      case 'count':
        leave({ kind: 'part', itemId: view.part.id });
        return true;
    }
  }, [view]);

  useEffect(() => {
    onRegisterStepBack?.(back);
    return () => onRegisterStepBack?.(null);
  }, [back, onRegisterStepBack]);

  const openPart = (itemId: string, done: InventoryKey | null = null): void => {
    setNotice(done);
    setView({ kind: 'part', itemId });
  };

  switch (view.kind) {
    case 'list':
      return (
        <PartList
          chrome={chrome}
          filter={filter}
          onFilter={setFilter}
          onOpenFilters={() => setView({ kind: 'filter' })}
          onManageCategories={() => {
            setCategoryNotice(null);
            setView({ kind: 'categories' });
          }}
          onBack={onClose}
          onOpenPart={(itemId) => openPart(itemId)}
          onAddPart={() => setView({ kind: 'add' })}
        />
      );
    case 'part':
      return (
        <PartDetail
          itemId={view.itemId}
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
          categoryId={filter.categoryId === NO_CATEGORY ? null : filter.categoryId}
          onDone={(itemId) => openPart(itemId, 'inventory.done.added')}
          onCancel={() => setView({ kind: 'list' })}
          onRegisterDiscardGuard={registerGuard}
        />
      );
    case 'edit':
      return (
        <PartForm
          chrome={chrome}
          part={view.part}
          onDone={(itemId) => openPart(itemId, 'inventory.done.saved')}
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
    case 'filter':
      return (
        <FilterStep
          chrome={chrome}
          filter={filter}
          onApply={(next) => {
            setFilter(next);
            setView({ kind: 'list' });
          }}
          onCancel={() => setView({ kind: 'list' })}
        />
      );
    case 'categories':
      return (
        <CategoryList
          chrome={chrome}
          onBack={() => setView({ kind: 'list' })}
          onOpen={(category) => setView({ kind: 'category', category })}
          onAdd={() => setView({ kind: 'category' })}
          notice={categoryNotice}
          onClearNotice={() => setCategoryNotice(null)}
        />
      );
    case 'category':
      return (
        <CategoryForm
          chrome={chrome}
          category={view.category}
          onDone={(done) => {
            setCategoryNotice(done);
            // Its fields may have changed, or it left the list: a filter on it starts over.
            if (view.category !== undefined && filter.categoryId === view.category.id) {
              setFilter(NO_FILTER);
            }
            setView({ kind: 'categories' });
          }}
          onCancel={() => setView({ kind: 'categories' })}
          onRegisterDiscardGuard={registerGuard}
        />
      );
  }
}
