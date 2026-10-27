/**
 * One person in a list of staff: the switcher, and the owner's staff PIN list. The same identity
 * object everywhere (colour hue + initials, design-system §1.5), so a colleague has the same face on
 * the lock screen as in Settings.
 *
 * Name in bold, role under it, and an optional status chip under them ("PIN terkunci"). Text wraps
 * rather than truncating (design guide §4), so a long name or a large font grows the row.
 */
import { translateRoleKey } from '@bolusi/i18n';
import { Avatar, ListRow } from '@bolusi/ui';
import type { ReactNode } from 'react';

import { initialsOf } from './model.js';

export interface UserRowProps {
  readonly id: string;
  readonly name: string;
  /** Top-privilege role keys; each is localized, unknown ones drop out. */
  readonly roleKeys?: readonly string[] | undefined;
  /** A status chip ("PIN terkunci"), shown under the role so a long name keeps the full width. */
  readonly status?: ReactNode;
  /** Absent for a row that only informs (someone the viewer may not change). */
  readonly onPress?: (() => void) | undefined;
  readonly testID?: string | undefined;
}

export function UserRow({
  id,
  name,
  roleKeys = [],
  status,
  onPress,
  testID,
}: UserRowProps): React.JSX.Element {
  const role = roleLabel(roleKeys);
  return (
    <ListRow
      primaryText={name}
      secondaryText={role === '' ? undefined : role}
      leading={<Avatar userId={id} initials={initialsOf(name)} size="row" />}
      below={status ?? undefined}
      onPress={onPress}
      emphasis
      testID={testID}
    />
  );
}

/** "Pemilik Toko", or several tied roles joined; a role with no catalog entry is left out. */
export function roleLabel(roleKeys: readonly string[]): string {
  return roleKeys
    .map((key) => translateRoleKey(key))
    .filter((label): label is string => label !== null)
    .join(', ');
}

/** "Pemilik Toko · Servis Ponsel Maju": who someone is here, under their name (account menu, Settings). */
export function roleAndStore(roleKeys: readonly string[], storeName: string): string {
  const role = roleLabel(roleKeys);
  return [role, storeName].filter((part) => part !== '').join(' · ');
}
