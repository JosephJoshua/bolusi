// The desktop frame: a sidebar of sections with the store and the signed-in person, and the page.
import { clsx } from 'clsx';
import { PanelLeftClose, PanelLeftOpen, type LucideIcon } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';

import { IconButton } from './IconButton.js';
import { Tooltip } from './Tooltip.js';

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
  collapsed = false,
  children,
  testId,
}: {
  readonly sidebar: ReactNode;
  /** The sidebar shows icons only, leaving the page the room. */
  readonly collapsed?: boolean;
  readonly children: ReactNode;
  readonly testId?: string | undefined;
}): React.JSX.Element {
  return (
    <div
      data-testid={testId}
      data-sidebar={collapsed ? 'collapsed' : 'expanded'}
      className={clsx(
        'grid h-full bg-surface transition-[grid-template-columns] duration-200 ease-out motion-reduce:transition-none',
        collapsed ? 'grid-cols-[64px_minmax(0,1fr)]' : 'grid-cols-[232px_minmax(0,1fr)]',
      )}
    >
      {sidebar}
      <main className="flex min-h-0 min-w-0 flex-col">{children}</main>
    </div>
  );
}

/**
 * The app's sections down the left, the store at the top and the signed-in person at the bottom.
 * Collapsed, it keeps only icons, each named in a tooltip; Ctrl+B or the toggle switches it.
 */
export function Sidebar({
  header,
  nav,
  footer,
  label,
  collapsed = false,
  onToggle,
  toggleLabels,
}: {
  /** The store as shown in each state: its name, or a mark that fits the icon rail. */
  readonly header: (collapsed: boolean) => ReactNode;
  readonly nav: readonly NavItem[];
  readonly footer: (collapsed: boolean) => ReactNode;
  readonly label: string;
  readonly collapsed?: boolean;
  readonly onToggle?: (() => void) | undefined;
  readonly toggleLabels?: { readonly collapse: string; readonly expand: string } | undefined;
}): React.JSX.Element {
  useEffect(() => {
    if (onToggle === undefined) return;
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        onToggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onToggle]);

  const toggle =
    onToggle === undefined || toggleLabels === undefined ? null : (
      <IconButton
        icon={collapsed ? PanelLeftOpen : PanelLeftClose}
        label={collapsed ? toggleLabels.expand : toggleLabels.collapse}
        shortcut="Ctrl+B"
        tooltipSide="right"
        size="sm"
        aria-expanded={!collapsed}
        onClick={onToggle}
        data-testid="nav.toggle"
      />
    );
  return (
    <aside
      className="flex min-h-0 min-w-0 flex-col overflow-hidden border-r border-border bg-surface-alt"
      data-testid="nav.sidebar"
    >
      <div
        className={clsx(
          'flex pb-3 pt-4',
          collapsed ? 'flex-col items-center gap-2 px-2' : 'items-center gap-2 pl-4 pr-3',
        )}
      >
        <div className={clsx('min-w-0', !collapsed && 'flex-1')}>{header(collapsed)}</div>
        {toggle}
      </div>
      <nav
        aria-label={label}
        className={clsx('flex flex-1 flex-col gap-1', collapsed ? 'px-2' : 'px-3')}
      >
        {nav.map((item) => {
          const button = (
            <button
              key={item.key}
              type="button"
              aria-current={item.active ? 'page' : undefined}
              aria-label={collapsed ? item.label : undefined}
              onClick={item.onSelect}
              data-testid={`nav.${item.key}`}
              className={clsx(
                'flex min-h-10 cursor-pointer items-center gap-3 rounded-sm py-2 text-body font-semibold transition-colors',
                collapsed ? 'justify-center' : 'px-3',
                item.active
                  ? 'bg-surface text-primary shadow-sm'
                  : 'text-text-muted hover:bg-black/5 hover:text-text',
              )}
            >
              <item.icon size={18} aria-hidden className="shrink-0" />
              {collapsed ? null : (
                <span className="flex-1 break-words text-left leading-tight">{item.label}</span>
              )}
            </button>
          );
          return (
            <Tooltip
              key={item.key}
              label={item.label}
              shortcut={item.shortcut}
              side="right"
              disabled={!collapsed && item.shortcut === undefined}
            >
              {button}
            </Tooltip>
          );
        })}
      </nav>
      <div className={clsx('border-t border-border', collapsed ? 'p-2' : 'p-3')}>
        {footer(collapsed)}
      </div>
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
