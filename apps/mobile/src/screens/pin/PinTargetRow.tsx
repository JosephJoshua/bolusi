/**
 * One row in an owner PIN screen's target list (design-system §3.4 ListRow, §3.12 Avatar). Shared by
 * the reset and unlock screens (CLAUDE.md §2.8) so a target user reads identically wherever an owner
 * picks one: the same identity two-channel object (colour hue + initials, §1.5) the switcher uses, so
 * an owner recognises a colleague by the same face here as on the lock screen.
 *
 * Presentational only — it renders the `PinTargetUser` the model decided to show and reports taps. It
 * holds no lockout logic; a caller that wants a "locked" marker passes it as `trailing`.
 */
import { Avatar, ListRow } from '@bolusi/ui';
import type { ReactNode } from 'react';

import { initialsOf } from '../switcher/model.js';

import type { PinTargetUser } from './pin-target.js';

export interface PinTargetRowProps {
  readonly user: PinTargetUser;
  readonly onPress: () => void;
  /** Optional trailing element — e.g. the unlock screen's "locked" chip. */
  readonly trailing?: ReactNode;
  readonly testID?: string | undefined;
}

export function PinTargetRow({
  user,
  onPress,
  trailing,
  testID,
}: PinTargetRowProps): React.JSX.Element {
  return (
    <ListRow
      primaryText={user.name}
      leading={<Avatar userId={user.id} initials={initialsOf(user.name)} size="row" />}
      trailing={trailing}
      onPress={onPress}
      showChevron={trailing === undefined}
      testID={testID}
    />
  );
}
