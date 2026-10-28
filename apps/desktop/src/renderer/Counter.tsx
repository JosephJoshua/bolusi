// The counter app's frame once someone is signed in: the sidebar, and the servisan board or the
// intake page beside it. The same frame runs over the offline core and over the seeded demo; what
// differs (who is here, the person menu, the sync line) comes in as props.
import { t } from '@bolusi/i18n';
import {
  IntakePage,
  RepairBoardPage,
  tn,
  type BoardFilters,
  type IntakeDraft,
} from '@bolusi/modules/repair/desktop';
import { AppShell, Avatar, Menu, Sidebar, Tooltip, type MenuItem } from '@bolusi/ui-web';
import { ChevronsUpDown, Settings, Wrench } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import type { SettingsAccess } from './settings/access.js';
import { SettingsPage, type LeaveGuard } from './settings/SettingsPage.js';
import { UpdateNotice } from './updates.js';

type Page =
  | { readonly kind: 'board' }
  // A warranty claim's intake starts from a draft made from the servisan it claims on.
  | { readonly kind: 'intake'; readonly claim?: IntakeDraft }
  | { readonly kind: 'settings' };

const SIDEBAR_KEY = 'bolusi.sidebar';
const NARROW_PX = 1280;

/**
 * Whether the sidebar is down to icons: as the person last left it on this PC, else collapsed while
 * the window is too narrow for the board and an open servisan beside a full sidebar.
 */
function useSidebarCollapsed(): readonly [boolean, () => void] {
  const [saved, setSaved] = useState<boolean | null>(() => {
    try {
      const value = window.localStorage.getItem(SIDEBAR_KEY);
      return value === null ? null : value === 'collapsed';
    } catch {
      // Storage blocked: follow the window's width.
      return null;
    }
  });
  const [narrow, setNarrow] = useState(() => window.innerWidth < NARROW_PX);
  useEffect(() => {
    const onResize = (): void => setNarrow(window.innerWidth < NARROW_PX);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const collapsed = saved ?? narrow;
  const toggle = useCallback(() => {
    const next = !collapsed;
    setSaved(next);
    try {
      window.localStorage.setItem(SIDEBAR_KEY, next ? 'collapsed' : 'expanded');
    } catch {
      // Not remembered; the toggle still works.
    }
  }, [collapsed]);
  return [collapsed, toggle];
}

/** Who is signed in, as the sidebar shows them. */
export interface CounterPerson {
  readonly userId: string;
  readonly name: string;
  /** Their roles, already in words. */
  readonly role: string;
}

export function Counter({
  storeName,
  person,
  menuHeader,
  menuItems,
  sync,
  onOpenSyncStatus,
  settings = {},
  restoredDraft,
  onDraftChange,
}: {
  readonly storeName: string;
  readonly person: CounterPerson;
  readonly menuHeader?: ReactNode;
  /** What the person menu offers: switching to someone else, locking the screen. */
  readonly menuItems: readonly MenuItem[];
  /** The sync line at the foot of the sidebar; absent in the demo, which has nothing to send. */
  readonly sync?: ((compact: boolean) => ReactNode) | undefined;
  /** Opens the sync panel, from a servisan the server refused a change on. */
  readonly onOpenSyncStatus?: (() => void) | undefined;
  /** What Settings may do for this person besides the repair settings; the demo has none. */
  readonly settings?: SettingsAccess | undefined;
  /** This person's unfinished intake, kept across a lock or a switch to someone else. */
  readonly restoredDraft: IntakeDraft | null;
  readonly onDraftChange: (draft: IntakeDraft | null) => void;
}): React.JSX.Element {
  // Someone who left an intake half done comes back to it, as on the phone.
  const [page, setPage] = useState<Page>(() =>
    restoredDraft === null ? { kind: 'board' } : { kind: 'intake' },
  );
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);
  // The queue and search the person was on are still there when they come back from an intake.
  const [filters, setFilters] = useState<BoardFilters | null>(null);
  const [collapsed, toggleSidebar] = useSidebarCollapsed();
  // Settings asks before it is left with unsaved changes.
  const leaveGuard = useRef<LeaveGuard | null>(null);
  const leave = (proceed: () => void): void => {
    const guard = leaveGuard.current;
    if (guard === null) proceed();
    else guard(proceed);
  };
  const go = (next: Page): void => {
    if (next.kind !== page.kind) leave(() => setPage(next));
  };
  // Settings opens from the person menu too, as on the phone. Switching person leaves Settings
  // as well; locking keeps everything as it is.
  const personMenu: readonly MenuItem[] = [
    ...menuItems.map((item) =>
      item.key === 'lock' ? item : { ...item, onSelect: () => leave(item.onSelect) },
    ),
    {
      key: 'settings',
      label: t('core.settings.title'),
      icon: Settings,
      separated: true,
      onSelect: () => go({ kind: 'settings' }),
    },
  ];
  const registerLeaveGuard = useCallback((guard: LeaveGuard | null) => {
    leaveGuard.current = guard;
  }, []);

  return (
    <AppShell
      testId="desktop.shell"
      collapsed={collapsed}
      sidebar={
        <Sidebar
          label={t('core.nav.main')}
          collapsed={collapsed}
          onToggle={toggleSidebar}
          toggleLabels={{ collapse: t('core.nav.collapse'), expand: t('core.nav.expand') }}
          header={(compact) =>
            compact ? (
              <Tooltip label={storeName} side="right">
                <span
                  className="flex size-9 items-center justify-center rounded-sm bg-primary text-heading font-bold text-white"
                  data-testid="desktop.store"
                >
                  {storeName.trim().charAt(0).toUpperCase()}
                </span>
              </Tooltip>
            ) : (
              <span
                className="block break-words text-heading font-bold leading-tight text-text"
                data-testid="desktop.store"
              >
                {storeName}
              </span>
            )
          }
          nav={[
            {
              key: 'repair',
              label: tn('repair.board.title'),
              icon: Wrench,
              active: page.kind !== 'settings',
              onSelect: () => go({ kind: 'board' }),
            },
            {
              key: 'settings',
              label: t('core.settings.title'),
              icon: Settings,
              active: page.kind === 'settings',
              onSelect: () => go({ kind: 'settings' }),
            },
          ]}
          footer={(compact) => (
            <div className="flex flex-col gap-3">
              <UpdateNotice compact={compact} />
              {sync?.(compact)}
              <PersonMenu
                person={person}
                compact={compact}
                header={menuHeader}
                items={personMenu}
              />
            </div>
          )}
        />
      }
    >
      {page.kind === 'settings' ? (
        <SettingsPage person={person} access={settings} onRegisterLeaveGuard={registerLeaveGuard} />
      ) : page.kind === 'intake' ? (
        <IntakePage
          // A claim is its own intake: it starts from its servisan and leaves the other one be.
          key={page.claim === undefined ? 'intake' : 'claim'}
          now={Date.now}
          restoredDraft={page.claim ?? restoredDraft}
          onDraftChange={page.claim === undefined ? onDraftChange : undefined}
          onOpened={(ticketId) => {
            if (page.claim === undefined) onDraftChange(null);
            setSelectedTicketId(ticketId);
            setPage({ kind: 'board' });
          }}
          onCancel={() => setPage({ kind: 'board' })}
        />
      ) : (
        <RepairBoardPage
          selectedTicketId={selectedTicketId}
          onSelectTicket={setSelectedTicketId}
          filters={filters}
          onFiltersChange={setFilters}
          onNewIntake={() => setPage({ kind: 'intake' })}
          onStartClaim={(claim) => setPage({ kind: 'intake', claim })}
          onOpenSyncStatus={onOpenSyncStatus}
        />
      )}
    </AppShell>
  );
}

function PersonMenu({
  person,
  compact,
  header,
  items,
}: {
  readonly person: CounterPerson;
  /** Only the face, in the collapsed sidebar; the tooltip names who it is. */
  readonly compact: boolean;
  readonly header?: ReactNode;
  readonly items: readonly MenuItem[];
}): React.JSX.Element {
  return (
    <Menu
      align="start"
      tooltip={compact ? { label: person.name, side: 'right' } : undefined}
      header={header}
      items={items}
      trigger={
        compact ? (
          <button
            type="button"
            aria-label={t('core.account.menu')}
            data-testid="desktop.person"
            className="flex w-full cursor-pointer justify-center rounded-sm p-1 hover:bg-black/5"
          >
            <Avatar userId={person.userId} name={person.name} size={32} />
          </button>
        ) : (
          <button
            type="button"
            aria-label={t('core.account.menu')}
            data-testid="desktop.person"
            className="flex w-full cursor-pointer items-center gap-3 rounded-sm p-2 text-left hover:bg-black/5"
          >
            <Avatar userId={person.userId} name={person.name} size={32} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="break-words text-body font-semibold text-text">{person.name}</span>
              {person.role === '' ? null : (
                <span className="break-words text-small text-text-muted">{person.role}</span>
              )}
            </span>
            <ChevronsUpDown size={16} aria-hidden className="shrink-0 text-text-muted" />
          </button>
        )
      }
    />
  );
}
