/**
 * Settings (07-i18n §1.2; api/04-push §3/§5). Renders `model.ts`; the reasoning is there.
 *
 * The language rows are the reason this screen is not a list of switches: picking a language you
 * cannot read is the one setting change a tech-inadept user cannot undo by reading the screen. So
 * the options render as ENDONYMS ("Bahasa Indonesia", "English") — identical in every locale, by
 * design (ui-labels.md) — and the active one is marked with a check, not merely with a colour. Both
 * choices mean a user who lands in the wrong language can still see which row is theirs and tap back.
 */
import { t } from '@bolusi/i18n';
import type { Locale } from '@bolusi/i18n';
import {
  AppShell,
  AvatarButton,
  Chip,
  ListRow,
  SyncChip,
  color,
  space,
  type,
  type SyncChipState,
} from '@bolusi/ui';
import { StyleSheet, Text, View } from 'react-native';

import {
  categoryNameKey,
  localeNameKey,
  localeOptions,
  MUTABLE_PUSH_CATEGORIES,
  type DeviceInfo,
  type MutablePushCategory,
  type PushMuteState,
} from './model.js';

export interface SettingsScreenProps {
  readonly locale: Locale;
  readonly onSelectLocale: (locale: Locale) => void;
  readonly muted: PushMuteState;
  readonly onToggleMute: (category: MutablePushCategory, muted: boolean) => void;
  readonly device: DeviceInfo;
  readonly currentUser: { readonly id: string; readonly initials: string };
  readonly onBack: () => void;
  readonly onOpenSwitcher: () => void;
  readonly syncChip: SyncChipState;
  readonly onOpenSync: () => void;
}

export function SettingsScreen({
  locale,
  onSelectLocale,
  muted,
  onToggleMute,
  device,
  currentUser,
  onBack,
  onOpenSwitcher,
  syncChip,
  onOpenSync,
}: SettingsScreenProps): React.JSX.Element {
  return (
    <AppShell
      title={t('core.settings.language')}
      titleVariant="detail"
      onBack={onBack}
      backLabel={t('core.action.back')}
      syncChip={
        <SyncChip
          state={syncChip}
          accessibilityLabel={t('sync.status.lastSynced', { relative: '' })}
          onPress={onOpenSync}
        />
      }
      avatar={
        <AvatarButton
          userId={currentUser.id}
          initials={currentUser.initials}
          accessibilityLabel={t('auth.switcher.title')}
          onPress={onOpenSwitcher}
        />
      }
      testID="settings-screen"
    >
      <Text style={styles.section}>{t('core.settings.language')}</Text>
      {localeOptions.map((option) => (
        <ListRow
          key={option}
          primaryText={t(localeNameKey(option) as 'core.language.id')}
          onPress={() => onSelectLocale(option)}
          testID={`settings-locale-${option}`}
          trailing={
            option === locale ? (
              // A check, not just a colour: §6.3 forbids colour-only signalling, and a user stranded
              // in the wrong language needs to see which row is currently theirs.
              <Chip
                label={t('core.action.ok')}
                icon="success"
                tone="success"
                testID={`settings-locale-active-${option}`}
              />
            ) : undefined
          }
        />
      ))}

      <Text style={styles.section}>{t('push.device.title')}</Text>
      {MUTABLE_PUSH_CATEGORIES.map((category) => (
        <ListRow
          key={category}
          primaryText={t(categoryNameKey(category) as 'push.device.title')}
          onPress={() => onToggleMute(category, !muted[category])}
          testID={`settings-mute-${category}`}
          trailing={
            <Chip
              label={muted[category] ? t('core.action.no') : t('core.action.yes')}
              icon={muted[category] ? 'pending' : 'success'}
              tone={muted[category] ? 'neutral' : 'success'}
              testID={`settings-mute-state-${category}`}
            />
          }
        />
      ))}

      <Text style={styles.section}>{t('auth.enroll.title')}</Text>
      <View testID="settings-device-info">
        <ListRow
          primaryText={device.deviceName}
          secondaryText={device.deviceId}
          testID="settings-device-id"
        />
        <ListRow
          primaryText={device.storeName}
          secondaryText={device.tenantName}
          testID="settings-device-store"
        />
        <ListRow
          primaryText={device.platform}
          secondaryText={device.appVersion}
          testID="settings-device-platform"
        />
      </View>
    </AppShell>
  );
}

const styles = StyleSheet.create({
  section: { ...type.heading, color: color.text, marginTop: space.xl, marginBottom: space.sm },
});
