// The counter app's frame once someone is signed in: the title bar (store, update, sync, who is
// here), the sidebar's sections, and the servisan board, the intake page, Kas or Settings beside
// them. The same frame runs over the offline core and over the seeded demo; what differs (who is
// here, the person menu, the sync status) comes in as props.
import { t } from '@bolusi/i18n';
import { KasPage, MONEY_PERMISSION, MoneyRuntimeProvider, tm } from '@bolusi/modules/money/desktop';
import {
  IntakePage,
  RepairBoardPage,
  moneyRuntimeOf,
  tn,
  useRepairRuntime,
  type BoardFilters,
  type IntakeDraft,
} from '@bolusi/modules/repair/desktop';
import {
  AppShell,
  Avatar,
  ConfirmDialog,
  Menu,
  Sidebar,
  SidebarToggle,
  type MenuItem,
} from '@bolusi/ui-web';
import { Banknote, ChevronDown, Settings, Wrench } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { SettingsAccess } from './settings/access.js';
import { SettingsPage, type LeaveGuard } from './settings/SettingsPage.js';
import { DeviceSetupPage, type StoreBasicSetting } from './setup/DeviceSetupPage.js';
import { PrinterReminder } from './setup/PrinterReminder.js';
import { BAR_CONTROL, TitleBar } from './TitleBar.js';
import { UpdateNotice } from './updates.js';

type Page =
  | { readonly kind: 'board' }
  // A warranty claim's intake starts from a draft made from the servisan it claims on.
  | { readonly kind: 'intake'; readonly claim?: IntakeDraft }
  | { readonly kind: 'kas' }
  | { readonly kind: 'settings'; readonly section?: 'computer' | StoreBasicSetting }
  // The first-run setup of this PC (setup/DeviceSetupPage.tsx).
  | { readonly kind: 'setup' };

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
  nameOf,
  menuHeader,
  menuItems,
  sync,
  onOpenSyncStatus,
  settings = {},
  restoredDraft,
  onDraftChange,
  setupPending = false,
  onSetupDone,
}: {
  readonly storeName: string;
  readonly person: CounterPerson;
  /** A colleague's name, for who counted the drawer; null for someone this PC does not know. */
  readonly nameOf: (userId: string) => string | null;
  readonly menuHeader?: ReactNode;
  /** What the person menu offers: switching to someone else, locking the screen. */
  readonly menuItems: readonly MenuItem[];
  /** The sync status in the title bar; absent in the demo, which has nothing to send. */
  readonly sync?: ReactNode;
  /** Opens the sync panel, from a servisan the server refused a change on. */
  readonly onOpenSyncStatus?: (() => void) | undefined;
  /** What Settings may do for this person besides the repair settings; the demo has only staff. */
  readonly settings?: SettingsAccess | undefined;
  /** This person's unfinished intake, kept across a lock or a switch to someone else. */
  readonly restoredDraft: IntakeDraft | null;
  readonly onDraftChange: (draft: IntakeDraft | null) => void;
  /** This PC's first-run setup waits for this person: it opens first. */
  readonly setupPending?: boolean;
  /** The setup was finished or put off; absent where there is none to record (the demo). */
  readonly onSetupDone?: (() => void) | undefined;
}): React.JSX.Element {
  // Someone who left an intake half done comes back to it, as on the phone.
  const [page, setPage] = useState<Page>(() =>
    setupPending
      ? { kind: 'setup' }
      : restoredDraft === null
        ? { kind: 'board' }
        : { kind: 'intake' },
  );
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);
  // A claim asked for while another intake waits unsaved: it would take that intake's place.
  const [claimAsked, setClaimAsked] = useState<IntakeDraft | null>(null);
  const startClaim = (claim: IntakeDraft): void => {
    if (restoredDraft === null) setPage({ kind: 'intake', claim });
    // A claim on the same servisan already started: carry on with it.
    else if (
      restoredDraft.claimOf !== null &&
      restoredDraft.claimOf.ticketId === claim.claimOf?.ticketId
    ) {
      setPage({ kind: 'intake' });
    } else setClaimAsked(claim);
  };
  // The queue and search the person was on are still there when they come back from an intake.
  const [filters, setFilters] = useState<BoardFilters | null>(null);
  const [collapsed, toggleSidebar] = useSidebarCollapsed();
  // The ledger as Kas and the payment settings read it: repair's money port, live on its feed.
  const repair = useRepairRuntime();
  const money = useMemo(() => moneyRuntimeOf(repair, nameOf), [repair, nameOf]);
  // Kas is for whoever counts the drawer or reads the store's money, as on the phone.
  const showsKas =
    money.hasPermission(MONEY_PERMISSION.read) || money.hasPermission(MONEY_PERMISSION.countCash);
  // Settings asks before it is left with unsaved changes.
  const leaveGuard = useRef<LeaveGuard | null>(null);
  const leave = (proceed: () => void): void => {
    const guard = leaveGuard.current;
    if (guard === null) proceed();
    else guard(proceed);
  };
  // Each opening of Settings at a section is a fresh Settings, so it lands there again even when
  // the person had moved to another section since.
  const [settingsVisit, setSettingsVisit] = useState(0);
  const go = (next: Page): void => {
    // Settings opened at a section (the printer reminder) goes there even from Settings.
    const toSection = next.kind === 'settings' && next.section !== undefined;
    if (next.kind !== page.kind || toSection) {
      leave(() => {
        if (toSection) setSettingsVisit((n) => n + 1);
        setPage(next);
      });
    }
  };
  // The core reads whom the setup waits for just after the session opens; it may land after this.
  useEffect(() => {
    if (setupPending) setPage({ kind: 'setup' });
  }, [setupPending]);
  const finishSetup = (): void => {
    onSetupDone?.();
    setPage(restoredDraft === null ? { kind: 'board' } : { kind: 'intake' });
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

  const shell = (
    <AppShell
      testId="desktop.shell"
      collapsed={collapsed}
      titleBar={
        <TitleBar
          storeName={storeName}
          leading={
            <SidebarToggle
              collapsed={collapsed}
              onToggle={toggleSidebar}
              labels={{ collapse: t('core.nav.collapse'), expand: t('core.nav.expand') }}
              tooltipSide="bottom"
              tone="inverse"
            />
          }
        >
          <UpdateNotice />
          {page.kind === 'setup' ? null : (
            <PrinterReminder
              recheck={page.kind}
              onChoose={() => go({ kind: 'settings', section: 'computer' })}
            />
          )}
          {sync}
          <PersonMenu person={person} header={menuHeader} items={personMenu} />
        </TitleBar>
      }
      sidebar={
        <Sidebar
          label={t('core.nav.main')}
          collapsed={collapsed}
          onToggle={toggleSidebar}
          nav={[
            {
              key: 'repair',
              label: tn('repair.board.title'),
              icon: Wrench,
              active:
                page.kind === 'board' ||
                page.kind === 'intake' ||
                (page.kind === 'kas' && !showsKas),
              onSelect: () => go({ kind: 'board' }),
            },
            ...(showsKas
              ? [
                  {
                    key: 'kas',
                    label: tm('money.kas.title'),
                    icon: Banknote,
                    active: page.kind === 'kas',
                    onSelect: () => go({ kind: 'kas' }),
                  },
                ]
              : []),
            {
              key: 'settings',
              label: t('core.settings.title'),
              icon: Settings,
              active: page.kind === 'settings',
              onSelect: () => go({ kind: 'settings' }),
            },
          ]}
        />
      }
    >
      {page.kind === 'setup' ? (
        <DeviceSetupPage
          onDone={finishSetup}
          onOpenSetting={(section) => {
            onSetupDone?.();
            setSettingsVisit((n) => n + 1);
            setPage({ kind: 'settings', section });
          }}
        />
      ) : page.kind === 'settings' ? (
        <SettingsPage
          key={`${page.section ?? 'settings'}.${settingsVisit}`}
          person={person}
          access={settings}
          initialPage={page.section}
          onOpenSetup={() => setPage({ kind: 'setup' })}
          onRegisterLeaveGuard={registerLeaveGuard}
        />
      ) : page.kind === 'kas' && showsKas ? (
        <KasPage now={Date.now} />
      ) : page.kind === 'intake' ? (
        <IntakePage
          // A claim starts from its servisan; kept like any intake, it survives a lock or a visit to
          // another section and reopens as the intake in progress.
          key={page.claim === undefined ? 'intake' : 'claim'}
          now={Date.now}
          restoredDraft={page.claim ?? restoredDraft}
          prefilled={page.claim !== undefined}
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
          waitingDraft={
            restoredDraft === null ? null : restoredDraft.claimOf === null ? 'intake' : 'claim'
          }
          onStartClaim={startClaim}
          onOpenSyncStatus={onOpenSyncStatus}
        />
      )}
      <ConfirmDialog
        open={claimAsked !== null}
        title={tn('repair.warrantyClaim.replaceTitle')}
        message={tn('repair.warrantyClaim.replaceMessage')}
        confirmLabel={tn('repair.warrantyClaim.replaceConfirm')}
        cancelLabel={t('core.action.cancel')}
        closeLabel={t('core.action.close')}
        destructive
        onConfirm={() => {
          if (claimAsked !== null) setPage({ kind: 'intake', claim: claimAsked });
          setClaimAsked(null);
        }}
        onCancel={() => setClaimAsked(null)}
        testId="desktop.claimReplacesIntake"
      />
    </AppShell>
  );
  return <MoneyRuntimeProvider runtime={money}>{shell}</MoneyRuntimeProvider>;
}

function PersonMenu({
  person,
  header,
  items,
}: {
  readonly person: CounterPerson;
  readonly header?: ReactNode;
  readonly items: readonly MenuItem[];
}): React.JSX.Element {
  // The bar gives the face and, when there is room, the name; the menu says who in full, with roles.
  return (
    <Menu
      align="end"
      tooltip={{ label: person.name, side: 'bottom' }}
      header={
        <span className="flex max-w-64 flex-col gap-2">
          <span className="flex flex-col">
            <span className="break-words text-body font-semibold text-text">{person.name}</span>
            {person.role === '' ? null : (
              <span className="break-words text-small font-normal text-text-muted">
                {person.role}
              </span>
            )}
          </span>
          {header}
        </span>
      }
      items={items}
      trigger={
        <button
          type="button"
          aria-label={t('core.account.menu')}
          data-testid="desktop.person"
          className={`${BAR_CONTROL} pl-1`}
        >
          <Avatar userId={person.userId} name={person.name} size={28} />
          <span className="hidden max-w-40 truncate font-semibold text-chrome-text @min-[56rem]:inline">
            {person.name}
          </span>
          <ChevronDown size={14} aria-hidden className="shrink-0" />
        </button>
      }
    />
  );
}
