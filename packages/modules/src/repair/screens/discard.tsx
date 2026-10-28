// The confirm before a repair step drops photos or a signature it has taken (screen-kit's
// `useDiscardConfirm` with repair's copy).
import type { ReactNode } from 'react';

import type { DiscardGuard } from '../../screen-kit/index.js';
import { useDiscardConfirm as useSharedDiscardConfirm } from '../../screen-kit/screens/discard.js';

import { tn } from '../i18n.js';

export function useDiscardConfirm({
  dirty,
  onRegisterDiscardGuard,
  onDiscard,
  testID,
}: {
  readonly dirty: boolean;
  readonly onRegisterDiscardGuard?: ((guard: DiscardGuard | null) => void) | undefined;
  readonly onDiscard?: (() => void) | undefined;
  readonly testID: string;
}): { readonly requestLeave: DiscardGuard; readonly overlay: ReactNode } {
  return useSharedDiscardConfirm({
    dirty,
    onDiscard,
    copy: {
      title: tn('repair.discardPhotos.title'),
      message: tn('repair.discardPhotos.message'),
      confirm: tn('repair.discardPhotos.confirm'),
      keep: tn('repair.discardPhotos.keep'),
    },
    onRegisterDiscardGuard,
    testID,
  });
}
