/**
 * `react-native-safe-area-context` double: the real context object shape, no native provider. A test
 * that wants live insets renders `SafeAreaInsetsContext.Provider` itself; without one, App falls back
 * to the status-bar read, as it does before the native insets arrive.
 */
import { createContext, type ReactNode } from 'react';

export interface EdgeInsets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export const SafeAreaInsetsContext = createContext<EdgeInsets | null>(null);

export function SafeAreaProvider({ children }: { readonly children?: ReactNode }): ReactNode {
  return children;
}
