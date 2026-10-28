// The counter app's frame once someone is signed in: the sidebar, and the servisan board or the
// intake page beside it. The same frame runs over the offline core and over the seeded demo; what
// differs (who is here, the person menu, the sync line) comes in as props.
import { t } from '@bolusi/i18n';
import {
  IntakePage,
  PrintSettings,
  RepairBoardPage,
  tn,
  type BoardFilters,
  type IntakeDraft,
} from '@bolusi/modules/repair/desktop';
import {
  AppShell,
  Avatar,
  Menu,
  PageHeader,
  Sidebar,
  Tooltip,
  type MenuItem,
} from '@bolusi/ui-web';
import { ChevronsUpDown, Settings, Wrench } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { UpdateNotice, useAppVersion } from './updates.js';

type Page =
  { readonly kind: 'board' } | { readonly kind: 'intake' } | { readonly kind: 'settings' };

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
              onSelect: () => setPage({ kind: 'board' }),
            },
            {
              key: 'settings',
              label: t('core.settings.title'),
              icon: Settings,
              active: page.kind === 'settings',
              onSelect: () => setPage({ kind: 'settings' }),
            },
          ]}
          footer={(compact) => (
            <div className="flex flex-col gap-3">
              <UpdateNotice compact={compact} />
              {sync?.(compact)}
              <PersonMenu person={person} compact={compact} header={menuHeader} items={menuItems} />
            </div>
          )}
        />
      }
    >
      {page.kind === 'settings' ? (
        <SettingsPage />
      ) : page.kind === 'intake' ? (
        <IntakePage
          now={Date.now}
          restoredDraft={restoredDraft}
          onDraftChange={onDraftChange}
          onOpened={(ticketId) => {
            onDraftChange(null);
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
        />
      )}
    </AppShell>
  );
}

/** This PC's own settings; the store's (slip header, intake lists) come with the owner screens. */
function SettingsPage(): React.JSX.Element {
  const version = useAppVersion();
  return (
    <>
      <PageHeader title={t('core.settings.title')} />
      <div className="min-h-0 flex-1 overflow-auto px-6 pb-6" data-testid="desktop.settings">
        <div className="flex max-w-2xl flex-col gap-4">
          <PrintSettings />
          {version === null ? null : (
            <p className="text-small text-text-muted" data-testid="desktop.version">
              {t('core.settings.appVersion')} {version}
            </p>
          )}
        </div>
      </div>
    </>
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
