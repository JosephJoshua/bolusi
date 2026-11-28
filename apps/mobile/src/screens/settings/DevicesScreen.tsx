/**
 * "Perangkat" (owner decision 2026-11-25): the store's phones and PCs with when each last synced, and
 * blocking a lost or stolen one. A blocked device erases all of its data the next time it reaches the
 * server, so the confirmation names its last sync: anything it did after that is lost.
 *
 * ONLINE ONLY, like "Karyawan": the list is the server's, and a block is the server's revoke. This
 * phone is shown first and cannot block itself from here.
 */
import { useDoneNote } from '@bolusi/modules/screen-kit';
import { staffAdminFailure, type StaffAdminFailure } from '@bolusi/core';
import type { DeviceControls } from '@bolusi/device/bootstrap/devices';
import {
  blockConsequence,
  devicesFailureMessage,
  type DeviceList,
  type DeviceRow,
} from '@bolusi/device/models/devices/model';
import { t } from '@bolusi/i18n';
import {
  AppShell,
  Banner,
  ConfirmSheet,
  Icon,
  List,
  ListRow,
  TextButton,
  color,
  size,
  space,
  type,
  type ListState,
  Text,
} from '@bolusi/ui';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useLatestCallback } from '../../hooks/useLatestCallback.js';
import type { SurfaceNav } from '../../navigation/surface.js';

export interface DevicesScreenProps {
  readonly load: DeviceControls['load'];
  readonly onBlock: DeviceControls['block'];
  readonly onClose: () => void;
  readonly onRegisterSurfaceNav?: ((nav: SurfaceNav | null) => void) | undefined;
}

type Loaded =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly reason: StaffAdminFailure }
  | { readonly kind: 'ready'; readonly list: DeviceList };

type Item =
  | { readonly kind: 'device'; readonly row: DeviceRow }
  | { readonly kind: 'blockedHeading' }
  | { readonly kind: 'alone' };

/** In use, then a hint while this is the store's only device, then the blocked ones. */
function itemsOf(list: DeviceList): readonly Item[] {
  return [
    ...list.active.map((row) => ({ kind: 'device', row }) as const),
    ...(list.active.every((row) => row.isThis) ? [{ kind: 'alone' } as const] : []),
    ...(list.blocked.length === 0 ? [] : [{ kind: 'blockedHeading' } as const]),
    ...list.blocked.map((row) => ({ kind: 'device', row }) as const),
  ];
}

export function DevicesScreen({
  load,
  onBlock,
  onClose,
  onRegisterSurfaceNav,
}: DevicesScreenProps): React.JSX.Element {
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const [confirming, setConfirming] = useState<DeviceRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{
    readonly tone: 'info' | 'warning' | 'danger';
    readonly message: string;
  } | null>(null);
  const { note: done, say } = useDoneNote();
  const shown = notice ?? (done === null ? null : { tone: 'info' as const, message: done });

  const latestLoad = useLatestCallback(load);
  const reload = useCallback(async (): Promise<void> => {
    try {
      setLoaded({ kind: 'ready', list: await latestLoad() });
    } catch (error) {
      setLoaded({ kind: 'error', reason: staffAdminFailure(error) });
    }
  }, [latestLoad]);
  useEffect(() => {
    void reload();
  }, [reload]);

  const back = (): void => {
    if (busy) return;
    if (confirming !== null) setConfirming(null);
    else onClose();
  };
  const latestBack = useLatestCallback(back);
  useEffect(() => {
    if (onRegisterSurfaceNav === undefined) return undefined;
    onRegisterSurfaceNav({
      handleBack: () => {
        latestBack();
        return true;
      },
      requestLeave: (proceed) => proceed(),
    });
    return () => onRegisterSurfaceNav(null);
  }, [onRegisterSurfaceNav, latestBack]);

  const block = (row: DeviceRow): void => {
    setConfirming(null);
    setBusy(true);
    setNotice(null);
    void onBlock(row.id).then(
      async () => {
        await reload();
        setBusy(false);
        say(t('auth.devices.blocked', { name: row.name }));
      },
      (error: unknown) => {
        const reason = staffAdminFailure(error);
        setBusy(false);
        setNotice({
          tone: reason === 'offline' ? 'warning' : 'danger',
          message: devicesFailureMessage(reason),
        });
      },
    );
  };

  const listState: ListState<Item> =
    loaded.kind === 'loading'
      ? { kind: 'loading' }
      : loaded.kind === 'error'
        ? {
            kind: 'error',
            error: {
              title: devicesFailureMessage(loaded.reason),
              retryLabel: t('core.action.retry'),
              onRetry: () => {
                setLoaded({ kind: 'loading' });
                void reload();
              },
            },
          }
        : { kind: 'ready', items: itemsOf(loaded.list) };

  return (
    <AppShell
      title={t('auth.devices.title')}
      titleVariant="detail"
      onBack={back}
      backLabel={t('core.action.back')}
      syncChip={null}
      avatar={<View testID="devices-no-avatar" />}
      banner={
        shown === null ? undefined : (
          <Banner
            variant={shown.tone}
            message={shown.message}
            onDismiss={() => {
              setNotice(null);
              say(null);
            }}
            testID="devices-notice"
          />
        )
      }
      overlay={
        confirming === null ? undefined : (
          <ConfirmSheet
            title={t('auth.devices.blockTitle', { name: confirming.name })}
            message={blockConsequence(confirming)}
            confirmLabel={t('auth.devices.blockConfirm')}
            onConfirm={() => block(confirming)}
            cancelLabel={t('core.action.cancel')}
            onCancel={() => setConfirming(null)}
            tone="destructive"
            testID="devices-confirm"
          />
        )
      }
      testID="devices-screen"
    >
      <View style={styles.list}>
        <List
          state={listState}
          keyExtractor={(item) => (item.kind === 'device' ? item.row.id : item.kind)}
          renderRow={(item) =>
            item.kind === 'blockedHeading' ? (
              <Text style={styles.heading} accessibilityRole="header" testID="devices-blocked">
                {t('auth.devices.blockedSection')}
              </Text>
            ) : item.kind === 'alone' ? (
              <View style={styles.alone} testID="devices-alone">
                <Text style={styles.aloneTitle}>{t('auth.devices.empty')}</Text>
                <Text style={styles.aloneHint}>{t('auth.devices.emptyBody')}</Text>
              </View>
            ) : (
              <ListRow
                leading={
                  <Icon
                    name={item.row.blocked ? 'lock' : 'phoneDevice'}
                    size={size.iconInline}
                    color={color.textMuted}
                  />
                }
                primaryText={item.row.name}
                secondaryText={item.row.detail}
                trailing={
                  item.row.isThis || item.row.blocked ? undefined : (
                    <TextButton
                      label={t('auth.devices.block')}
                      tone="danger"
                      disabled={busy}
                      onPress={() => {
                        setNotice(null);
                        setConfirming(item.row);
                      }}
                      accessibilityLabel={t('auth.devices.blockLabel', { name: item.row.name })}
                      testID={`devices-block-${item.row.id}`}
                    />
                  )
                }
                testID={`devices-row-${item.row.id}`}
              />
            )
          }
          testID="devices-list"
        />
      </View>
    </AppShell>
  );
}

const styles = StyleSheet.create({
  list: { flex: 1, marginHorizontal: -space.lg },
  heading: {
    ...type.bodyBold,
    color: color.text,
    paddingHorizontal: space.lg,
    paddingTop: space.xl,
    paddingBottom: space.xs,
  },
  alone: { paddingHorizontal: space.lg, paddingVertical: space.lg, gap: space.xs },
  aloneTitle: { ...type.bodyBold, color: color.text },
  aloneHint: { ...type.bodySm, color: color.textMuted },
});
