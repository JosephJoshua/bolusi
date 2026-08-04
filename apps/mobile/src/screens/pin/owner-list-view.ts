/**
 * Map an owner screen's simple `OwnerListState` (reset / unlock) to the `<List>` component's §5
 * `ListState`, filling in localized copy and the state callbacks. Shared by both owner screens
 * (CLAUDE.md §2.8) so the four mandatory states render identically — in particular the Unauthorized
 * arm, which must carry the "ask your store owner" guidance and a back CTA rather than degrading into
 * an empty box (design-system §5 / FR-1036). Only the Empty title differs between the two screens, so
 * it is the one thing passed in.
 */
import { t } from '@bolusi/i18n';
import type { ListState } from '@bolusi/ui';

import type { OwnerListState, PinTargetUser } from './pin-target.js';

export interface OwnerListViewOptions {
  /** The localized Empty-state title — "no other users" for reset, "no one is locked out" for unlock. */
  readonly emptyTitle: string;
  readonly onBack: () => void;
  readonly onReload: () => void;
}

export function ownerListToListState(
  state: OwnerListState,
  options: OwnerListViewOptions,
): ListState<PinTargetUser> {
  switch (state.kind) {
    case 'unauthorized':
      return {
        kind: 'unauthorized',
        unauthorized: {
          title: t('auth.pin.manage.unauthorizedTitle'),
          hint: t('auth.pin.manage.unauthorizedBody'),
          backLabel: t('core.action.back'),
          onBack: options.onBack,
        },
      };
    case 'loading':
      return { kind: 'loading' };
    case 'error':
      return {
        kind: 'error',
        error: {
          title: t('core.errors.UNEXPECTED'),
          errorCode: state.code,
          retryLabel: t('core.action.retry'),
          onRetry: options.onReload,
        },
      };
    case 'ready':
      if (state.targets.length === 0) {
        return { kind: 'empty', empty: { title: options.emptyTitle } };
      }
      return { kind: 'ready', items: state.targets };
  }
}
