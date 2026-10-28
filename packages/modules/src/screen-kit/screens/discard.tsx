// The confirm before a step drops what the user has filled in. Its sheet goes in the screen's
// `overlay` slot, never inside the scrolling content (AppShell's overlay docs).
import { ConfirmSheet } from '@bolusi/ui';
import { useEffect, useState, type ReactNode } from 'react';

import type { DiscardGuard } from '../action.js';

/** Already-localized copy for the sheet. */
export interface DiscardCopy {
  readonly title: string;
  readonly message: string;
  readonly confirm: string;
  readonly keep: string;
}

/**
 * Leaving a step with unsaved input asks first, from the header back and from hardware back
 * (through the registered guard) alike. Returns the leave to call and the sheet to pass as the
 * screen's overlay.
 */
export function useDiscardConfirm({
  dirty,
  copy,
  onRegisterDiscardGuard,
  onDiscard,
  testID,
}: {
  readonly dirty: boolean;
  readonly copy: DiscardCopy;
  readonly onRegisterDiscardGuard?: ((guard: DiscardGuard | null) => void) | undefined;
  /** The person chose to drop what they filled in, whichever back they used. */
  readonly onDiscard?: (() => void) | undefined;
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
        title={copy.title}
        message={copy.message}
        confirmLabel={copy.confirm}
        onConfirm={() => {
          setPending(null);
          // The user said to drop it: a parent whose leave asks this guard must not ask again.
          onRegisterDiscardGuard?.(null);
          onDiscard?.();
          pending();
        }}
        cancelLabel={copy.keep}
        onCancel={() => setPending(null)}
        testID={`${testID}.discard`}
      />
    );
  return { requestLeave, overlay };
}
