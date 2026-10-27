// The confirm before a repair step drops photos or a signature it has taken. Its sheet goes in the
// screen's `overlay` slot, never inside the scrolling content (AppShell's overlay docs).
import { ConfirmSheet } from '@bolusi/ui';
import { useEffect, useState, type ReactNode } from 'react';

import type { DiscardGuard } from '../../screen-kit/index.js';

import { tn } from '../i18n.js';

/**
 * Leaving a step that holds photos or a signature not yet saved asks first, from the header back and
 * from hardware back (through the registered guard) alike. Returns the leave to call and the sheet
 * to pass as the screen's overlay.
 */
export function useDiscardConfirm({
  dirty,
  onRegisterDiscardGuard,
  testID,
}: {
  readonly dirty: boolean;
  readonly onRegisterDiscardGuard?: ((guard: DiscardGuard | null) => void) | undefined;
  readonly testID: string;
}): { readonly requestLeave: DiscardGuard; readonly overlay: ReactNode } {
  const [pending, setPending] = useState<(() => void) | null>(null);
  const requestLeave: DiscardGuard = (proceed) => {
    if (dirty) setPending(() => proceed);
    else proceed();
  };
  useEffect(() => {
    onRegisterDiscardGuard?.(dirty ? (proceed) => setPending(() => proceed) : null);
    return () => onRegisterDiscardGuard?.(null);
  }, [dirty, onRegisterDiscardGuard]);
  const overlay =
    pending === null ? null : (
      <ConfirmSheet
        title={tn('repair.discardPhotos.title')}
        message={tn('repair.discardPhotos.message')}
        confirmLabel={tn('repair.discardPhotos.confirm')}
        onConfirm={() => {
          setPending(null);
          pending();
        }}
        cancelLabel={tn('repair.discardPhotos.keep')}
        onCancel={() => setPending(null)}
        testID={`${testID}.discard`}
      />
    );
  return { requestLeave, overlay };
}
