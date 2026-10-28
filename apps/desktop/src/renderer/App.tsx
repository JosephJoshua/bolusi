// The counter app's frame: the sidebar, and the servisan board or the intake page beside it.
import { t, translateRoleKey } from '@bolusi/i18n';
import {
  IntakePage,
  PaperSettings,
  RepairBoardPage,
  RepairRuntimeProvider,
  tn,
  type BoardFilters,
  type IntakeDraft,
} from '@bolusi/modules/repair/desktop';
import { AppShell, Avatar, Menu, PageHeader, Sidebar, Tooltip } from '@bolusi/ui-web';
import { ChevronsUpDown, Settings, Wrench } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { DEMO_PEOPLE, DEMO_STORE_NAME, demoRuntimeFor, type DemoPerson } from './demo.js';

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

export function App(): React.JSX.Element {
  const [person, setPerson] = useState<DemoPerson>(DEMO_PEOPLE[0]!);
  const runtime = useMemo(() => demoRuntimeFor(person), [person]);
  return (
    <RepairRuntimeProvider runtime={runtime}>
      <Counter key={person.userId} person={person} onSwitchPerson={setPerson} />
    </RepairRuntimeProvider>
  );
}

function Counter({
  person,
  onSwitchPerson,
}: {
  readonly person: DemoPerson;
  readonly onSwitchPerson: (person: DemoPerson) => void;
}): React.JSX.Element {
  const [page, setPage] = useState<Page>({ kind: 'board' });
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);
  // The queue and search the person was on are still there when they come back from an intake.
  const [filters, setFilters] = useState<BoardFilters | null>(null);
  // An unfinished intake survives going back to the board, as on the phone.
  const [draft, setDraft] = useState<IntakeDraft | null>(null);
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
              <Tooltip label={DEMO_STORE_NAME} side="right">
                <span
                  className="flex size-9 items-center justify-center rounded-sm bg-primary text-heading font-bold text-white"
                  data-testid="desktop.store"
                >
                  {DEMO_STORE_NAME.trim().charAt(0).toUpperCase()}
                </span>
              </Tooltip>
            ) : (
              <span
                className="block break-words text-heading font-bold leading-tight text-text"
                data-testid="desktop.store"
              >
                {DEMO_STORE_NAME}
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
            <PersonMenu person={person} compact={compact} onSwitchPerson={onSwitchPerson} />
          )}
        />
      }
    >
      {page.kind === 'settings' ? (
        <SettingsPage />
      ) : page.kind === 'intake' ? (
        <IntakePage
          now={Date.now}
          restoredDraft={draft}
          onDraftChange={setDraft}
          onOpened={(ticketId) => {
            setDraft(null);
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
  return (
    <>
      <PageHeader title={t('core.settings.title')} />
      <div className="min-h-0 flex-1 overflow-auto px-6 pb-6" data-testid="desktop.settings">
        <div className="flex max-w-2xl flex-col gap-4">
          <PaperSettings />
        </div>
      </div>
    </>
  );
}

function PersonMenu({
  person,
  compact,
  onSwitchPerson,
}: {
  readonly person: DemoPerson;
  /** Only the face, in the collapsed sidebar; the tooltip names who it is. */
  readonly compact: boolean;
  readonly onSwitchPerson: (person: DemoPerson) => void;
}): React.JSX.Element {
  return (
    <Menu
      align="start"
      tooltip={compact ? { label: person.name, side: 'right' } : undefined}
      header={
        <span className="text-small font-semibold text-text-muted">
          {t('core.account.switchUser')}
        </span>
      }
      items={DEMO_PEOPLE.filter((other) => other.userId !== person.userId).map((other) => ({
        key: other.userId,
        label: other.name,
        onSelect: () => onSwitchPerson(other),
      }))}
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
              <span className="break-words text-small text-text-muted">
                {translateRoleKey(person.roleKey)}
              </span>
            </span>
            <ChevronsUpDown size={16} aria-hidden className="shrink-0 text-text-muted" />
          </button>
        )
      }
    />
  );
}
