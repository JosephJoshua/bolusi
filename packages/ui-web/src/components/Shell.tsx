// The desktop frame: a sidebar of sections with the store and the signed-in person, and the page.
import { clsx } from 'clsx';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export interface NavItem {
  readonly key: string;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly active: boolean;
  readonly onSelect: () => void;
  readonly shortcut?: string | undefined;
}

export function AppShell({
  sidebar,
  children,
  testId,
}: {
  readonly sidebar: ReactNode;
  readonly children: ReactNode;
  readonly testId?: string | undefined;
}): React.JSX.Element {
  return (
    <div data-testid={testId} className="grid h-full grid-cols-[232px_minmax(0,1fr)] bg-surface">
      {sidebar}
      <main className="flex min-h-0 min-w-0 flex-col">{children}</main>
    </div>
  );
}

export function Sidebar({
  header,
  nav,
  footer,
  label,
}: {
  readonly header: ReactNode;
  readonly nav: readonly NavItem[];
  readonly footer: ReactNode;
  readonly label: string;
}): React.JSX.Element {
  return (
    <aside className="flex min-h-0 flex-col border-r border-border bg-surface-alt">
      <div className="px-4 pb-3 pt-4">{header}</div>
      <nav aria-label={label} className="flex flex-1 flex-col gap-1 px-3">
        {nav.map((item) => (
          <button
            key={item.key}
            type="button"
            aria-current={item.active ? 'page' : undefined}
            onClick={item.onSelect}
            data-testid={`nav.${item.key}`}
            className={clsx(
              'flex h-10 cursor-pointer items-center gap-3 rounded-sm px-3 text-body font-semibold transition-colors',
              item.active
                ? 'bg-surface text-primary shadow-sm'
                : 'text-text-muted hover:bg-black/5 hover:text-text',
            )}
          >
            <item.icon size={18} aria-hidden />
            <span className="flex-1 text-left">{item.label}</span>
          </button>
        ))}
      </nav>
      <div className="border-t border-border p-3">{footer}</div>
    </aside>
  );
}

/** The top of a page: its title, then the page's own controls, then its main action on the right. */
export function PageHeader({
  title,
  leading,
  children,
  actions,
}: {
  readonly title: string;
  readonly leading?: ReactNode;
  readonly children?: ReactNode;
  readonly actions?: ReactNode;
}): React.JSX.Element {
  return (
    <header className="flex h-16 shrink-0 items-center gap-6 px-6">
      <div className="flex min-w-0 items-center gap-2">
        {leading}
        <h1 className="whitespace-nowrap text-title font-bold text-text">{title}</h1>
      </div>
      <div className="flex min-w-0 flex-1 items-center">{children}</div>
      {actions === undefined ? null : (
        <div className="flex shrink-0 items-center gap-3">{actions}</div>
      )}
    </header>
  );
}
