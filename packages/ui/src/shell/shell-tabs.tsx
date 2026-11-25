/**
 * The app's place tabs, handed from the app shell to the screen that shows them.
 *
 * The tab bar belongs inside the screen's `AppShell`, not under it: there it shares one bottom
 * dock with the screen's action, and a sheet or confirm in the shell's overlay covers it like the
 * rest of the screen. The app decides WHEN tabs show (only on a place's top level); the shell only
 * draws what it is given. One shell draws them: the shell that takes them hands nothing further down.
 */
import { createContext, useContext, type ReactNode } from 'react';

const ShellTabsContext = createContext<ReactNode>(null);

/** Puts `tabs` (a `<TabBar />`, or null for none) at the bottom of the screen inside. */
export function ShellTabsProvider({
  tabs,
  children,
}: {
  readonly tabs: ReactNode;
  readonly children: ReactNode;
}): React.JSX.Element {
  return <ShellTabsContext.Provider value={tabs}>{children}</ShellTabsContext.Provider>;
}

export function useShellTabs(): ReactNode {
  return useContext(ShellTabsContext);
}
