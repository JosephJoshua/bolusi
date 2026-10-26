/**
 * The one "PIN karyawan" step that scrolls: the colleague, not the owner, types their new PIN twice
 * (api/02-auth §6.6). It lives apart from `StaffPinScreen` because that screen also renders the staff
 * `<List>`, and a list must never sit inside a scrolling AppShell (a FlatList in a ScrollView loses
 * its windowing). This step has no list, and with a large font it needs to scroll.
 */
import { t } from '@bolusi/i18n';
import { AppShell } from '@bolusi/ui';
import { View } from 'react-native';

import { newPinFeedbackKey, newPinPadState, newPinPromptKey, type NewPinEntry } from './new-pin.js';
import type { PinTargetUser } from './pin-target.js';
import { PinEntry } from './PinEntry.js';

export interface StaffPinNewPinProps {
  readonly target: PinTargetUser;
  /** The new-PIN sub-flow, or `null` while the PIN is being saved. */
  readonly entry: NewPinEntry | null;
  readonly onComplete: (pin: string) => void;
  readonly onBack: () => void;
}

export function StaffPinNewPin({
  target,
  entry,
  onComplete,
  onBack,
}: StaffPinNewPinProps): React.JSX.Element {
  const feedback = entry === null ? null : newPinFeedbackKey(entry);
  return (
    // The same frame as StaffPinScreen's other steps, plus scrolling.
    <AppShell
      title={t('auth.pin.staff.resetTitle')}
      titleVariant="detail"
      onBack={onBack}
      backLabel={t('core.action.back')}
      syncChip={null}
      avatar={<View testID="staff-pin-no-avatar" />}
      scrollable
      testID="staff-pin-screen"
    >
      <PinEntry
        person={target}
        prompt={t(entry === null ? 'auth.pin.setup.repeat' : newPinPromptKey(entry))}
        message={feedback === null ? undefined : t(feedback)}
        state={entry === null ? 'locked' : newPinPadState(entry)}
        onComplete={onComplete}
        padKey={entry === null ? 'submitting' : `${entry.kind}-${newPinPadState(entry)}`}
        backspaceLabel={t('core.action.delete')}
        testID="staff-pin-entry"
      />
    </AppShell>
  );
}
