// The PC's Settings, the phone's Settings in a desktop layout: the pages down the left, the chosen
// one beside them. Each page shows only for someone allowed to use it (the core and the server
// still decide every change), so a cashier sees their account and this computer, an owner the
// store's people, repair and payment settings too. A page with unsaved changes asks before it is
// left.
import { localeNameKey, localeOptions } from '@bolusi/device/models/settings/model';
import { getLocale, t, type Locale } from '@bolusi/i18n';
import {
  PaymentMethodsSettings,
  managesPaymentMethods,
  tm,
  useMoneyRuntime,
} from '@bolusi/modules/money/desktop';
import {
  CancelFeesSettings,
  DiscardChangesDialog,
  INTAKE_LIST_KEY,
  INTAKE_OPTION_LISTS,
  IntakeListSettings,
  PrintSettings,
  repairAbilities,
  repairSettingsAccess,
  SlipSettings,
  UncollectedSettings,
  tn,
  useRepairRuntime,
  type IntakeOptionList,
} from '@bolusi/modules/repair/desktop';
import {
  Button,
  Card,
  ChoiceList,
  Fact,
  FactGrid,
  PageHeader,
  Section,
  SectionNav,
  SettingsPanel,
  Tooltip,
  type SectionNavGroup,
} from '@bolusi/ui-web';
import { Compass } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { CounterPerson } from '../Counter.js';
import { MediaSettings } from '../media-choice.js';
import { StartWithWindows } from '../startup.js';
import { useAppVersion } from '../updates.js';
import type { SettingsAccess } from './access.js';
import { AccountPanel } from './AccountPanel.js';
import { LimitsPanel } from './LimitsPanel.js';
import { RenameDeviceDialog } from './RenameDevice.js';
import { RolesPanel } from './RolesPanel.js';
import { StaffPanel } from './StaffPanel.js';
import { StaffPinsPanel } from './StaffPinsPanel.js';

type SettingsPageKey =
  | 'account'
  | 'staff'
  | 'staffPins'
  | 'limits'
  | 'roles'
  | 'fees'
  | 'uncollected'
  | 'slip'
  | 'paymentMethods'
  | `options.${IntakeOptionList}`
  | 'computer';

/** Asks the page being left whether it may go; `proceed` runs once it may. */
export type LeaveGuard = (proceed: () => void) => void;

export function SettingsPage({
  person,
  access,
  initialPage = 'account',
  onOpenSetup,
  onRegisterLeaveGuard,
}: {
  readonly person: CounterPerson;
  readonly access: SettingsAccess;
  /** The page to open on, such as "Komputer ini" from the printer reminder. */
  readonly initialPage?: SettingsPageKey | undefined;
  /** Opens this PC's setup guide again. */
  readonly onOpenSetup?: (() => void) | undefined;
  /** Lets the app's own navigation ask before leaving Settings with unsaved changes. */
  readonly onRegisterLeaveGuard?: ((guard: LeaveGuard | null) => void) | undefined;
}): React.JSX.Element {
  const runtime = useRepairRuntime();
  const repair = useMemo(
    () => repairSettingsAccess(repairAbilities(runtime.hasPermission)),
    [runtime],
  );
  const money = useMoneyRuntime();
  const methods = useMemo(() => managesPaymentMethods(money), [money]);
  const { staff, staffPins } = access;
  // Every label below follows a switch of this PC's language.
  const locale = getLocale();
  const groups = useMemo((): readonly SectionNavGroup<SettingsPageKey>[] => {
    return [
      {
        key: 'you',
        title: null,
        items: [{ value: 'account', label: t('auth.pc.settings.account') }],
      },
      {
        key: 'team',
        title: t('core.settings.team'),
        items: [
          ...(staff === undefined
            ? []
            : [{ value: 'staff' as const, label: t('auth.staff.title') }]),
          ...(staffPins === undefined || (!staffPins.canUnlock && !staffPins.canReset)
            ? []
            : [
                {
                  value: 'staffPins' as const,
                  label: t('auth.pin.staff.title'),
                  badge:
                    staffPins.lockedCount > 0
                      ? t('auth.pc.settings.lockedCount', { count: staffPins.lockedCount })
                      : undefined,
                },
              ]),
          ...(staff?.canSetLimits === true
            ? [{ value: 'limits' as const, label: t('auth.limits.title') }]
            : []),
          // The role editor is the main owner's alone.
          ...(staff?.tenantAdmin === true
            ? [{ value: 'roles' as const, label: t('auth.roles.title') }]
            : []),
        ],
      },
      {
        key: 'repair',
        title: tn('repair.board.title'),
        items: [
          ...(repair.cancelFees
            ? [{ value: 'fees' as const, label: tn('repair.fees.title') }]
            : []),
          ...(repair.uncollected
            ? [{ value: 'uncollected' as const, label: tn('repair.uncollected.title') }]
            : []),
          ...(repair.printSettings
            ? [{ value: 'slip' as const, label: tn('repair.printSettings.title') }]
            : []),
        ],
      },
      {
        key: 'money',
        title: tm('money.kas.title'),
        items: methods
          ? [{ value: 'paymentMethods' as const, label: tm('money.methods.title') }]
          : [],
      },
      {
        key: 'intake',
        title: tn('repair.options.title'),
        items: repair.intakeOptions
          ? INTAKE_OPTION_LISTS.map((list) => ({
              value: `options.${list}` as const,
              label: tn(INTAKE_LIST_KEY[list]),
            }))
          : [],
      },
      {
        key: 'computer',
        title: null,
        items: [{ value: 'computer', label: t('auth.pc.settings.thisPc') }],
      },
    ];
  }, [staff, staffPins, repair, methods, locale]);

  const [page, setPage] = useState<SettingsPageKey>(initialPage);
  const [pending, setPending] = useState<(() => void) | null>(null);
  const dirty = useRef(false);
  const onDirtyChange = (next: boolean): void => {
    dirty.current = next;
  };

  const guard: LeaveGuard = (proceed) => {
    if (!dirty.current) proceed();
    else setPending(() => proceed);
  };
  const latestGuard = useRef(guard);
  latestGuard.current = guard;
  useEffect(() => {
    onRegisterLeaveGuard?.((proceed) => latestGuard.current(proceed));
    return () => onRegisterLeaveGuard?.(null);
  }, [onRegisterLeaveGuard]);

  // A page someone lost access to (their grants changed) falls back to their account.
  const offered = groups.some((group) => group.items.some((item) => item.value === page));
  const current: SettingsPageKey = offered ? page : 'account';

  return (
    <>
      <PageHeader title={t('core.settings.title')} />
      <div className="flex min-h-0 flex-1 border-t border-border" data-testid="desktop.settings">
        <div className="w-56 shrink-0 overflow-y-auto border-r border-border px-3 py-4 xl:w-64">
          <SectionNav
            groups={groups}
            value={current}
            onChange={(next) => {
              if (next !== current) guard(() => setPage(next));
            }}
            label={t('core.settings.title')}
            testId="desktop.settings.nav"
          />
        </div>
        <div
          className="min-w-0 flex-1 overflow-y-auto px-6 pt-6"
          data-testid="desktop.settings.page"
        >
          <div
            key={`${current}.${locale}`}
            className="mx-auto flex min-h-full w-full max-w-4xl flex-col"
          >
            <Page
              page={current}
              person={person}
              access={access}
              onDirtyChange={onDirtyChange}
              onOpenSetup={onOpenSetup}
            />
          </div>
        </div>
      </div>
      <DiscardChangesDialog
        open={pending !== null}
        onDiscard={() => {
          const proceed = pending;
          setPending(null);
          dirty.current = false;
          proceed?.();
        }}
        onKeep={() => setPending(null)}
      />
    </>
  );
}

function Page({
  page,
  person,
  access,
  onDirtyChange,
  onOpenSetup,
}: {
  readonly page: SettingsPageKey;
  readonly person: CounterPerson;
  readonly access: SettingsAccess;
  readonly onDirtyChange: (dirty: boolean) => void;
  readonly onOpenSetup: (() => void) | undefined;
}): React.JSX.Element {
  switch (page) {
    case 'account':
      return <AccountPanel person={person} changePin={access.changePin} />;
    case 'staff':
      return (
        <StaffPanel
          controls={access.staff!}
          actorUserId={person.userId}
          resetPin={access.staffPins?.canReset === true ? access.staffPins.resetPin : undefined}
        />
      );
    case 'staffPins':
      return <StaffPinsPanel access={access.staffPins!} actorUserId={person.userId} />;
    case 'limits':
      return (
        <LimitsPanel
          controls={access.staff!}
          actorUserId={person.userId}
          onDirtyChange={onDirtyChange}
        />
      );
    case 'roles':
      return <RolesPanel controls={access.staff!} onDirtyChange={onDirtyChange} />;
    case 'fees':
      return <CancelFeesSettings onDirtyChange={onDirtyChange} />;
    case 'uncollected':
      return <UncollectedSettings onDirtyChange={onDirtyChange} />;
    case 'slip':
      return <SlipSettings onDirtyChange={onDirtyChange} />;
    case 'paymentMethods':
      return <PaymentMethodsSettings />;
    case 'computer':
      return (
        <ComputerPanel
          device={access.device ?? null}
          onRename={access.renameDevice}
          onChooseLocale={access.chooseLocale}
          onOpenSetup={onOpenSetup}
        />
      );
    default:
      return (
        <IntakeListSettings
          list={page.slice('options.'.length) as IntakeOptionList}
          onDirtyChange={onDirtyChange}
        />
      );
  }
}

/** This PC: the printer and paper its slips use, its language, and what it is registered as. */
function ComputerPanel({
  device,
  onRename,
  onChooseLocale,
  onOpenSetup,
}: {
  readonly device: SettingsAccess['device'];
  readonly onRename: SettingsAccess['renameDevice'];
  readonly onChooseLocale: SettingsAccess['chooseLocale'];
  readonly onOpenSetup: (() => void) | undefined;
}): React.JSX.Element {
  const version = useAppVersion();
  const [renaming, setRenaming] = useState(false);
  return (
    <SettingsPanel
      title={t('auth.pc.settings.thisPc')}
      actions={
        onOpenSetup === undefined ? undefined : (
          <Button
            label={t('auth.pc.setup.reopen')}
            icon={Compass}
            size="sm"
            onClick={onOpenSetup}
            data-testid="desktop.settings.setup"
          />
        )
      }
      testId="desktop.settings.computer"
    >
      <PrintSettings />
      <MediaSettings />
      <StartWithWindows />
      {onChooseLocale === undefined ? null : <LanguageSettings onChoose={onChooseLocale} />}
      <Card testId="desktop.settings.device">
        <FactGrid>
          {device === null || device === undefined ? null : (
            <>
              <Fact
                label={t('auth.pc.deviceNameField')}
                value={<span data-testid="desktop.device.name">{device.deviceName}</span>}
                action={
                  onRename === undefined ? undefined : (
                    <Tooltip label={t('auth.rename.titlePc')}>
                      <Button
                        label={t('core.action.edit')}
                        aria-label={t('auth.rename.titlePc')}
                        variant="text"
                        size="sm"
                        className="-my-1"
                        onClick={() => setRenaming(true)}
                        data-testid="desktop.device.rename"
                      />
                    </Tooltip>
                  )
                }
              />
              <Fact label={t('core.settings.store')} value={device.storeName} />
              <Fact label={t('core.settings.business')} value={device.tenantName} />
            </>
          )}
          {version === null ? null : (
            <Fact
              label={t('core.settings.appVersion')}
              value={<span data-testid="desktop.version">{version}</span>}
            />
          )}
          {device === null || device === undefined ? null : (
            <Fact label={t('core.settings.deviceId')} value={device.deviceId} />
          )}
        </FactGrid>
      </Card>
      {renaming && onRename !== undefined && device !== null && device !== undefined ? (
        <RenameDeviceDialog
          current={device.deviceName}
          onRename={onRename}
          onClose={() => setRenaming(false)}
        />
      ) : null}
    </SettingsPanel>
  );
}

/**
 * The language this PC shows, as on the phone: each language in its own name, the same in every
 * language, with the chosen one marked, so someone who picked one they cannot read finds their way
 * back. It is the PC's, so it says it is for everyone here.
 */
function LanguageSettings({
  onChoose,
}: {
  readonly onChoose: (locale: Locale) => Promise<void>;
}): React.JSX.Element {
  const current = getLocale();
  // Marked at once; the words follow when the PC has saved it, and the mark goes back if it could not.
  const [picked, setPicked] = useState<Locale | null>(null);
  return (
    <Card testId="desktop.settings.language">
      <Section title={t('core.settings.language')}>
        <p className="-mt-2 text-small text-text-muted">{t('auth.pc.language.caption')}</p>
        <ChoiceList
          options={localeOptions.map((locale) => ({
            value: locale,
            label: t(localeNameKey(locale) as 'core.language.id'),
          }))}
          value={picked ?? current}
          onChange={(next) => {
            if (next === current) return;
            setPicked(next);
            onChoose(next).then(
              () => setPicked(null),
              () => setPicked(null),
            );
          }}
          label={t('core.settings.language')}
          testId="desktop.settings.language.choice"
        />
      </Section>
    </Card>
  );
}
