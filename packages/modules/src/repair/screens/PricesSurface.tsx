/**
 * PricesSurface — the Harga section of the Servisan place: the price list and the form reached from
 * it, as local navigation like the parts list. While the form is open it publishes a `PlaceStep`, so
 * back closes it (through its discard confirm); on the list it publishes null and the tabs show.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { DiscardGuard, PlaceStep } from '../../screen-kit/index.js';
import type { PlaceHeader, ScreenChrome } from '../../screen-kit/screens/views.js';
import { tn } from '../i18n.js';
import type { PriceStart } from '../price-list.js';
import { PriceForm } from './PriceForm.js';
import { PriceList } from './PriceList.js';

type View = { readonly kind: 'list' } | { readonly kind: 'form'; readonly start: PriceStart };

export interface PricesSurfaceProps {
  readonly chrome: ScreenChrome;
  readonly place: PlaceHeader;
  readonly onRegisterPlaceStep?: ((step: PlaceStep | null) => void) | undefined;
  readonly onRegisterDiscardGuard?: ((guard: DiscardGuard | null) => void) | undefined;
}

export function PricesSurface({
  chrome,
  place,
  onRegisterPlaceStep,
  onRegisterDiscardGuard,
}: PricesSurfaceProps): React.JSX.Element {
  const [view, setView] = useState<View>({ kind: 'list' });
  // A new form for each start: a copy is a new row, not the one it came from.
  const [formKey, setFormKey] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const guardRef = useRef<DiscardGuard | null>(null);
  const registerGuard = useCallback(
    (guard: DiscardGuard | null): void => {
      guardRef.current = guard;
      onRegisterDiscardGuard?.(guard);
    },
    [onRegisterDiscardGuard],
  );

  useEffect(() => {
    if (view.kind === 'list') {
      onRegisterPlaceStep?.(null);
      return;
    }
    const back = (): void => {
      const guard = guardRef.current;
      if (guard === null) setView({ kind: 'list' });
      else guard(() => setView({ kind: 'list' }));
    };
    onRegisterPlaceStep?.({ back, listBeside: false });
    return () => onRegisterPlaceStep?.(null);
  }, [view, onRegisterPlaceStep]);

  const openForm = (start: PriceStart): void => {
    setNotice(null);
    setFormKey((n) => n + 1);
    setView({ kind: 'form', start });
  };

  if (view.kind === 'form') {
    return (
      <PriceForm
        key={formKey}
        chrome={chrome}
        start={view.start}
        onDone={(saved) => {
          setNotice(tn('repair.prices.saved', { price: saved }));
          setView({ kind: 'list' });
        }}
        onRemoved={() => {
          setNotice(tn('repair.prices.removed'));
          setView({ kind: 'list' });
        }}
        onCopy={(row) => openForm({ kind: 'copy', row })}
        onCancel={() => setView({ kind: 'list' })}
        onRegisterDiscardGuard={registerGuard}
      />
    );
  }
  return (
    <PriceList
      chrome={chrome}
      place={place}
      notice={notice}
      onClearNotice={() => setNotice(null)}
      onOpenPrice={(row) => openForm({ kind: 'edit', row })}
      onAddPrice={() => openForm({ kind: 'new' })}
    />
  );
}
