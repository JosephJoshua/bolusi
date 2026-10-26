// The counter app's frame: the sidebar, and the servisan board or the intake page beside it.
import { t, translateRoleKey } from '@bolusi/i18n';
import {
  IntakePage,
  RepairBoardPage,
  RepairRuntimeProvider,
  tn,
  type BoardFilters,
  type IntakeDraft,
} from '@bolusi/modules/repair/desktop';
import { AppShell, Avatar, Menu, Sidebar } from '@bolusi/ui-web';
import { ChevronsUpDown, Wrench } from 'lucide-react';
import { useMemo, useState } from 'react';

import { DEMO_PEOPLE, DEMO_STORE_NAME, demoRuntimeFor, type DemoPerson } from './demo.js';

type Page = { readonly kind: 'board' } | { readonly kind: 'intake' };

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

  return (
    <AppShell
      testId="desktop.shell"
      sidebar={
        <Sidebar
          label={t('core.nav.main')}
          header={
            <div className="flex h-10 items-center">
              <span className="truncate text-heading font-bold text-text">{DEMO_STORE_NAME}</span>
            </div>
          }
          nav={[
            {
              key: 'repair',
              label: tn('repair.board.title'),
              icon: Wrench,
              active: true,
              onSelect: () => setPage({ kind: 'board' }),
            },
          ]}
          footer={<PersonMenu person={person} onSwitchPerson={onSwitchPerson} />}
        />
      }
    >
      {page.kind === 'intake' ? (
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

function PersonMenu({
  person,
  onSwitchPerson,
}: {
  readonly person: DemoPerson;
  readonly onSwitchPerson: (person: DemoPerson) => void;
}): React.JSX.Element {
  return (
    <Menu
      align="start"
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
        <button
          type="button"
          aria-label={t('core.account.menu')}
          data-testid="desktop.person"
          className="flex w-full cursor-pointer items-center gap-3 rounded-sm p-2 text-left hover:bg-black/5"
        >
          <Avatar userId={person.userId} name={person.name} size={32} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-body font-semibold text-text">{person.name}</span>
            <span className="truncate text-small text-text-muted">
              {translateRoleKey(person.roleKey)}
            </span>
          </span>
          <ChevronsUpDown size={16} aria-hidden className="text-text-muted" />
        </button>
      }
    />
  );
}
