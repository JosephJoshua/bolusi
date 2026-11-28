// "Perangkat" (owner decision 2026-11-25), the phone's page on the PC: the store's phones and PCs with
// when each last synced, and blocking a lost one. A blocked device erases its data the next time it
// reaches the server, so the confirmation names its last sync. Online only; the phone's list model
// decides the rows and their words, and this PC cannot block itself from here.
import { staffAdminFailure, type StaffAdminFailure } from '@bolusi/core';
import type { DeviceControls } from '@bolusi/device/bootstrap/devices';
import {
  blockConsequence,
  devicesFailureMessage,
  type DeviceList,
  type DeviceRow,
} from '@bolusi/device/models/devices/model';
import { t } from '@bolusi/i18n';
import { Banner, Button, ConfirmDialog, SettingsPanel, Skeleton, StatePanel } from '@bolusi/ui-web';
import { CircleAlert, Lock, MonitorSmartphone, WifiOff } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

type Loaded =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly reason: StaffAdminFailure }
  | { readonly kind: 'ready'; readonly list: DeviceList };

export function DevicesPanel({
  controls,
}: {
  readonly controls: DeviceControls;
}): React.JSX.Element {
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const [confirming, setConfirming] = useState<DeviceRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{
    readonly tone: 'success' | 'warning' | 'danger';
    readonly text: string;
  } | null>(null);
  const latest = useRef(controls);
  latest.current = controls;

  const reload = useCallback(async (): Promise<void> => {
    try {
      setLoaded({ kind: 'ready', list: await latest.current.load() });
    } catch (error) {
      setLoaded({ kind: 'error', reason: staffAdminFailure(error) });
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  const block = (row: DeviceRow): void => {
    setConfirming(null);
    setBusy(true);
    setNotice(null);
    void latest.current.block(row.id).then(
      async () => {
        await reload();
        setBusy(false);
        setNotice({ tone: 'success', text: t('auth.devices.blocked', { name: row.name }) });
      },
      (error: unknown) => {
        const reason = staffAdminFailure(error);
        setBusy(false);
        setNotice({
          tone: reason === 'offline' ? 'warning' : 'danger',
          text: devicesFailureMessage(reason),
        });
      },
    );
  };

  return (
    <SettingsPanel
      title={t('auth.devices.title')}
      lead={t('auth.devices.settingsSummary')}
      testId="desktop.settings.devices"
    >
      {notice === null ? null : (
        <Banner
          tone={notice.tone}
          message={notice.text}
          onDismiss={() => setNotice(null)}
          dismissLabel={t('core.action.close')}
        />
      )}
      {loaded.kind === 'loading' ? (
        <div className="flex flex-col gap-2" aria-busy>
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-14" />
          ))}
        </div>
      ) : loaded.kind === 'error' ? (
        <StatePanel
          icon={loaded.reason === 'offline' ? WifiOff : CircleAlert}
          tone={loaded.reason === 'offline' ? 'neutral' : 'danger'}
          title={devicesFailureMessage(loaded.reason)}
          action={
            <Button
              label={t('core.action.retry')}
              variant="secondary"
              onClick={() => {
                setLoaded({ kind: 'loading' });
                void reload();
              }}
            />
          }
          testId="desktop.settings.devices.error"
        />
      ) : (
        <>
          <DeviceRows
            rows={loaded.list.active}
            label={t('auth.devices.title')}
            busy={busy}
            onBlock={(row) => {
              setNotice(null);
              setConfirming(row);
            }}
          />
          {loaded.list.active.every((row) => row.isThis) ? (
            <StatePanel
              icon={MonitorSmartphone}
              title={t('auth.devices.empty')}
              hint={t('auth.devices.emptyBody')}
              testId="desktop.settings.devices.alone"
            />
          ) : null}
          {loaded.list.blocked.length === 0 ? null : (
            <section className="flex flex-col gap-2">
              <h3 className="text-body font-semibold text-text">
                {t('auth.devices.blockedSection')}
              </h3>
              <DeviceRows
                rows={loaded.list.blocked}
                label={t('auth.devices.blockedSection')}
                busy={busy}
                onBlock={undefined}
              />
            </section>
          )}
        </>
      )}
      <ConfirmDialog
        open={confirming !== null}
        title={confirming === null ? '' : t('auth.devices.blockTitle', { name: confirming.name })}
        message={confirming === null ? '' : blockConsequence(confirming)}
        confirmLabel={t('auth.devices.blockConfirm')}
        cancelLabel={t('core.action.cancel')}
        closeLabel={t('core.action.close')}
        destructive
        onConfirm={() => {
          if (confirming !== null) block(confirming);
        }}
        onCancel={() => setConfirming(null)}
        testId="desktop.settings.devices.confirm"
      />
    </SettingsPanel>
  );
}

function DeviceRows({
  rows,
  label,
  busy,
  onBlock,
}: {
  readonly rows: readonly DeviceRow[];
  readonly label: string;
  readonly busy: boolean;
  /** Absent for the blocked list: there is nothing more to do with them. */
  readonly onBlock: ((row: DeviceRow) => void) | undefined;
}): React.JSX.Element {
  return (
    <ul
      className="divide-y divide-border rounded-md border border-border bg-surface"
      aria-label={label}
    >
      {rows.map((row) => {
        const Icon = row.blocked ? Lock : MonitorSmartphone;
        return (
          <li
            key={row.id}
            className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3"
            data-testid={`desktop.settings.devices.row.${row.id}`}
          >
            <div className="flex min-w-0 flex-1 basis-64 items-center gap-3">
              <Icon className="size-5 shrink-0 text-text-muted" aria-hidden />
              <div className="flex min-w-0 flex-col">
                <p className="break-words text-body font-semibold text-text">{row.name}</p>
                <p className="break-words text-small text-text-muted">{row.detail}</p>
              </div>
            </div>
            {onBlock === undefined || row.isThis ? null : (
              <div className="ml-auto flex shrink-0 items-center">
                <Button
                  label={t('auth.devices.block')}
                  variant="dangerText"
                  size="sm"
                  disabled={busy}
                  aria-label={t('auth.devices.blockLabel', { name: row.name })}
                  onClick={() => onBlock(row)}
                  data-testid={`desktop.settings.devices.block.${row.id}`}
                />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
