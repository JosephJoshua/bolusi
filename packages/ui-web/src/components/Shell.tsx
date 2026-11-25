// The desktop frame: a sidebar of sections with the store and the signed-in person, and the page.
import { clsx } from 'clsx';
import {
  ArrowLeft,
  ChevronRight,
  PanelLeftClose,
  PanelLeftOpen,
  type LucideIcon,
} from 'lucide-react';
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

/**
 * A place with more than one section (Barang: Stok and Belanja): its name over its sections when
 * the sidebar is open, a hairline before them when it is down to icons.
 */
export interface NavGroup {
  readonly key: string;
  readonly label: string;
  readonly items: readonly NavItem[];
}

function isGroup(entry: NavItem | NavGroup): entry is NavGroup {
  return 'items' in entry;
}

export function AppShell({
  titleBar,
  sidebar,
  collapsed = false,
  pageKey,
  children,
  testId,
}: {
  /** The window's own title bar across the top, on the desktop app. */
  readonly titleBar?: ReactNode;
  readonly sidebar: ReactNode;
  /** The sidebar shows icons only, leaving the page the room. */
  readonly collapsed?: boolean;
  /** Names the page on show; a new page rises into place instead of snapping in. */
  readonly pageKey?: string | undefined;
  readonly children: ReactNode;
  readonly testId?: string | undefined;
}): React.JSX.Element {
  const shell = (
    <div
      data-testid={testId}
      data-sidebar={collapsed ? 'collapsed' : 'expanded'}
      className={clsx(
        'grid min-h-0 flex-1 bg-surface transition-[grid-template-columns] duration-200 ease-out motion-reduce:transition-none',
        titleBar === undefined && 'h-full',
        collapsed ? 'grid-cols-[64px_minmax(0,1fr)]' : 'grid-cols-[232px_minmax(0,1fr)]',
      )}
    >
      {sidebar}
      <main className="flex min-h-0 min-w-0 flex-col">
        {pageKey === undefined ? (
          children
        ) : (
          <div key={pageKey} className="flex min-h-0 min-w-0 flex-1 animate-rise-in flex-col">
            {children}
          </div>
        )}
      </main>
    </div>
  );
  if (titleBar === undefined) return shell;
  return (
    <div className="flex h-full flex-col">
      {titleBar}
      {shell}
    </div>
  );
}

/**
 * The app's sections down the left, optionally with the store at the top and the signed-in person at
 * the bottom. Collapsed, it keeps only icons, each named in a tooltip; Ctrl+B switches it, and so
 * does the toggle, drawn here when `toggleLabels` is given or wherever the app puts `SidebarToggle`.
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
  readonly header?: ((collapsed: boolean) => ReactNode) | undefined;
  readonly nav: readonly (NavItem | NavGroup)[];
  readonly footer?: ((collapsed: boolean) => ReactNode) | undefined;
  readonly label: string;
  readonly collapsed?: boolean;
  readonly onToggle?: (() => void) | undefined;
  readonly toggleLabels?: SidebarToggleLabels | undefined;
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
      <SidebarToggle
        collapsed={collapsed}
        onToggle={onToggle}
        labels={toggleLabels}
        tooltipSide="right"
      />
    );
  return (
    <aside
      className="flex min-h-0 min-w-0 flex-col overflow-hidden border-r border-border bg-surface-alt"
      data-testid="nav.sidebar"
    >
      {header === undefined && toggle === null ? null : (
        <div
          className={clsx(
            'flex pb-3 pt-4',
            collapsed ? 'flex-col items-center gap-2 px-2' : 'items-center gap-2 pl-4 pr-3',
          )}
        >
          <div className={clsx('min-w-0', !collapsed && 'flex-1')}>{header?.(collapsed)}</div>
          {toggle}
        </div>
      )}
      <nav
        aria-label={label}
        className={clsx(
          'flex flex-1 flex-col gap-1',
          collapsed ? 'px-2' : 'px-3',
          header === undefined && toggle === null && 'pt-3',
        )}
      >
        {nav.map((entry) =>
          isGroup(entry) ? (
            <div
              key={entry.key}
              role="group"
              aria-label={entry.label}
              className="flex flex-col gap-1"
            >
              {collapsed ? (
                <hr className="mx-2 my-1 border-border" />
              ) : (
                <p className="px-3 pb-0.5 pt-2 text-small font-semibold text-text-muted">
                  {entry.label}
                </p>
              )}
              {entry.items.map((item) => (
                <SidebarItem key={item.key} item={item} collapsed={collapsed} />
              ))}
            </div>
          ) : (
            <SidebarItem key={entry.key} item={entry} collapsed={collapsed} />
          ),
        )}
      </nav>
      {footer === undefined ? null : (
        <div className={clsx('border-t border-border', collapsed ? 'p-2' : 'p-3')}>
          {footer(collapsed)}
        </div>
      )}
    </aside>
  );
}

function SidebarItem({
  item,
  collapsed,
}: {
  readonly item: NavItem;
  readonly collapsed: boolean;
}): React.JSX.Element {
  return (
    <Tooltip
      label={item.label}
      shortcut={item.shortcut}
      side="right"
      disabled={!collapsed && item.shortcut === undefined}
    >
      <button
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
    </Tooltip>
  );
}

export interface SidebarToggleLabels {
  readonly collapse: string;
  readonly expand: string;
}

/** Folds the sidebar to icons and back (Ctrl+B), wherever the app places it. */
export function SidebarToggle({
  collapsed,
  onToggle,
  labels,
  tooltipSide,
  tone,
}: {
  readonly collapsed: boolean;
  readonly onToggle: () => void;
  readonly labels: SidebarToggleLabels;
  readonly tooltipSide: 'right' | 'bottom';
  readonly tone?: 'plain' | 'inverse' | undefined;
}): React.JSX.Element {
  return (
    <IconButton
      icon={collapsed ? PanelLeftOpen : PanelLeftClose}
      label={collapsed ? labels.expand : labels.collapse}
      shortcut="Ctrl+B"
      tooltipSide={tooltipSide}
      tone={tone ?? 'plain'}
      size="sm"
      aria-expanded={!collapsed}
      onClick={onToggle}
      data-testid="nav.toggle"
    />
  );
}

/**
 * One step of the way to a page, from its place down: a link back to that level, or only its name
 * when that level is no page of its own (Barang, over its sections).
 */
export interface Crumb {
  readonly key: string;
  readonly label: string;
  readonly onSelect?: (() => void) | undefined;
}

/**
 * The top of a page: the way to it, its title, then the page's own controls, then its main action
 * on the right.
 *
 * - `trail` names the levels above this page, from its place down ("Barang › Belanja"); each is a
 *   link back to it. A place's own top page has none.
 * - `onBack` puts a back arrow first and takes the mouse's back button and Alt+Left too, so going
 *   back works the same from any page below a place. Unsaved work is the page's to ask about.
 */
export function PageHeader({
  title,
  trail,
  trailLabel,
  onBack,
  backLabel,
  leading,
  children,
  actions,
}: {
  readonly title: string;
  readonly trail?: readonly Crumb[] | undefined;
  /** Names the trail for screen readers ("Lokasi halaman"); required with `trail`. */
  readonly trailLabel?: string | undefined;
  readonly onBack?: (() => void) | undefined;
  /** Required with `onBack`: read aloud and shown as the arrow's tooltip. */
  readonly backLabel?: string | undefined;
  readonly leading?: ReactNode;
  readonly children?: ReactNode;
  readonly actions?: ReactNode;
}): React.JSX.Element {
  useBackGesture(onBack);
  return (
    <header className="flex h-16 shrink-0 items-center gap-6 px-6">
      <div className="flex min-w-0 items-center gap-2">
        {onBack === undefined ? null : (
          <IconButton
            icon={ArrowLeft}
            label={backLabel ?? ''}
            shortcut="Alt+←"
            tooltipSide="bottom"
            className="-ml-2"
            onClick={onBack}
            data-testid="page.back"
          />
        )}
        {leading}
        {trail === undefined || trail.length === 0 ? null : (
          <nav aria-label={trailLabel} className="flex min-w-0 items-center gap-1">
            <ol className="flex min-w-0 items-center gap-1">
              {trail.map((crumb) => (
                <li key={crumb.key} className="flex items-center gap-1">
                  {crumb.onSelect === undefined ? (
                    <span
                      data-testid={`page.crumb.${crumb.key}`}
                      className="whitespace-nowrap text-heading font-semibold text-text-muted"
                    >
                      {crumb.label}
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={crumb.onSelect}
                      data-testid={`page.crumb.${crumb.key}`}
                      className="cursor-pointer whitespace-nowrap rounded-sm text-heading font-semibold text-text-muted hover:text-text hover:underline focus-visible:outline-2 focus-visible:outline-primary"
                    >
                      {crumb.label}
                    </button>
                  )}
                  <ChevronRight size={18} aria-hidden className="shrink-0 text-text-muted" />
                </li>
              ))}
            </ol>
          </nav>
        )}
        <h1 className="whitespace-nowrap text-title font-bold text-text" aria-current="page">
          {title}
        </h1>
      </div>
      <div className="flex min-w-0 flex-1 items-center">{children}</div>
      {actions === undefined ? null : (
        <div className="flex shrink-0 items-center gap-3">{actions}</div>
      )}
    </header>
  );
}

/**
 * The mouse's back button and Alt+Left run `onBack`, as in a browser, while a page that offers back
 * is showing. A dialog open over the page keeps them (it has its own way out).
 */
export function useBackGesture(onBack: (() => void) | undefined): void {
  useEffect(() => {
    if (onBack === undefined) return;
    const overDialog = (): boolean => document.querySelector('[role="dialog"]') !== null;
    const onKey = (event: KeyboardEvent): void => {
      if (event.altKey && event.key === 'ArrowLeft' && !overDialog()) {
        event.preventDefault();
        onBack();
      }
    };
    // Button 3 is the mouse's back button; stop the browser's own history step as well.
    const onMouse = (event: MouseEvent): void => {
      if (event.button !== 3) return;
      event.preventDefault();
      if (event.type === 'mouseup' && !overDialog()) onBack();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onMouse);
    window.addEventListener('mouseup', onMouse);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onMouse);
      window.removeEventListener('mouseup', onMouse);
    };
  }, [onBack]);
}
