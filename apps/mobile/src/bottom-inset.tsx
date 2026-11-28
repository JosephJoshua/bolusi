/**
 * Hands the phone's measured bottom system-bar height (`react-native-safe-area-context`) to
 * `@bolusi/ui`, so the shell and every sheet clear the navigation bar or home indicator by exactly
 * its height: 48 dp with Android's three buttons, about 24 dp with gesture navigation.
 */
import type { ReactNode } from 'react';
import { useContext } from 'react';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';

import { BottomInsetProvider } from '@bolusi/ui';

export function MeasuredBottomInset({
  children,
}: {
  readonly children: ReactNode;
}): React.JSX.Element {
  const insets = useContext(SafeAreaInsetsContext);
  return <BottomInsetProvider measured={insets?.bottom}>{children}</BottomInsetProvider>;
}
