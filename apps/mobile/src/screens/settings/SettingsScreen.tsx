/**
 * Settings (07-i18n §1.2; api/04-push §3/§5). Renders `model.ts`; the reasoning is there.
 *
 * The language rows are the reason this screen is not a list of switches: picking a language you
 * cannot read is the one setting change a tech-inadept user cannot undo by reading the screen. So
 * the options render as ENDONYMS ("Bahasa Indonesia", "English") — identical in every locale, by
 * design (07-i18n §10.1) — and the active one is marked with a check, not merely with a colour. Both
 * choices mean a user who lands in the wrong language can still see which row is theirs and tap back.
 */
import { getLocale, t } from '@bolusi/i18n';
import type { Locale } from '@bolusi/i18n';
import {
  AppShell,
  AvatarButton,
  Fact,
  FactGrid,
  Icon,
  ListRow,
  SyncChip,
  border,
  color,
  radius,
  size,
  space,
  type,
  type IconName,
  type SyncChipState,
} from '@bolusi/ui';
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { syncChipAccessibilityLabels } from '../sync-status/chip-a11y.js';
import { initialsOf } from '@bolusi/device/models/switcher/model';
import { roleLabel } from '../switcher/UserRow.js';

import {
  localeNameKey,
  localeOptions,
  MUTABLE_PUSH_CATEGORIES,
  type DeviceInfo,
  type MutablePushCategory,
} from '@bolusi/device/models/settings/model';

/** A module's section in Settings, its copy resolved by the caller. */
export interface SettingsModuleSection {
  readonly section: string;
  readonly testID: string;
  readonly rows: readonly SettingsModuleRow[];
}

export interface SettingsModuleRow {
  readonly icon: IconName;
  readonly title: string;
  readonly summary: string;
  readonly onOpen: () => void;
  readonly testID: string;
}

export interface SettingsScreenProps {
  readonly locale: Locale;
  readonly onSelectLocale: (locale: Locale) => void;
  /**
   * Open the OS notification settings for a category (api/04-push §5; D18 §1). v0 muting is the OS's,
   * not the app's — the row deep-links, it does not toggle a mute flag.
   */
  readonly onOpenNotificationSettings: (category: MutablePushCategory) => void;
  readonly device: DeviceInfo;
  readonly currentUser: {
    readonly id: string;
    readonly name: string;
    readonly roleKeys: readonly string[];
  };
  readonly onBack: () => void;
  readonly onOpenSwitcher: () => void;
  /** Open the Change-PIN screen (api/02-auth §6.6; task 186a). Self-service, every role. */
  readonly onOpenChangePin: () => void;
  /** Open this phone's setup guide again (permissions, paper); absent where there is none. */
  readonly onOpenSetup?: (() => void) | undefined;
  /**
   * Open the owner's staff PIN screen (unlock / reset) — present ONLY when the acting user may do
   * either, so the row is absent for everyone else rather than shown-and-denied. Core still enforces.
   */
  readonly onOpenStaffPins?: (() => void) | undefined;
  /** How many colleagues' PINs are locked right now, so the owner sees it without opening the row. */
  readonly lockedStaffCount?: number | undefined;
  /**
   * Open "Karyawan" (add, change, deactivate staff) — present ONLY for someone who may add staff
   * here (`auth.user_create`), so the row is absent for everyone else. The server still decides.
   */
  readonly onOpenStaff?: (() => void) | undefined;
  /** Open "Batas wewenang" — present ONLY for someone who may set limits here. */
  readonly onOpenLimits?: (() => void) | undefined;
  /**
   * The modules' settings (repair's intake lists and fees, money's payment methods) — each row present
   * ONLY for someone who may change it at this store, and a section absent when it has no rows; core
   * still enforces them. The caller supplies the modules' copy, so this screen never imports their
   * screens (whose lists would nest a FlatList in this scrolling shell).
   */
  readonly modules?: readonly SettingsModuleSection[] | undefined;
  readonly syncChip: SyncChipState;
  /** Count of unsent `local` ops — the `pending` chip shows it and its a11y label announces it. */
  readonly pendingCount: number;
  readonly onOpenSync: () => void;
}

export function SettingsScreen({
  locale,
  onSelectLocale,
  onOpenNotificationSettings,
  device,
  currentUser,
  onBack,
  onOpenSwitcher,
  onOpenChangePin,
  onOpenSetup,
  onOpenStaffPins,
  lockedStaffCount = 0,
  onOpenStaff,
  onOpenLimits,
  modules = [],
  syncChip,
  pendingCount,
  onOpenSync,
}: SettingsScreenProps): React.JSX.Element {
  const role = roleLabel(currentUser.roleKeys);
  return (
    <AppShell
      // Plain views (no FlatList): a dozen rows plus the device facts overflow a small screen or a
      // raised font scale, so the content scrolls (task 206).
      scrollable
      title={t('core.settings.title')}
      titleVariant="detail"
      onBack={onBack}
      backLabel={t('core.action.back')}
      syncChip={
        <SyncChip
          state={syncChip}
          pendingCount={pendingCount}
          accessibilityLabels={syncChipAccessibilityLabels({ pendingCount })}
          onPress={onOpenSync}
        />
      }
      avatar={
        <AvatarButton
          userId={currentUser.id}
          initials={initialsOf(currentUser.name)}
          accessibilityLabel={t('auth.switcher.title')}
          onPress={onOpenSwitcher}
        />
      }
      testID="settings-screen"
    >
      {/* Who these settings are for: the PIN rows below are this person's. */}
      <View style={styles.who} testID="settings-who">
        <Text style={styles.whoName}>{currentUser.name}</Text>
        {/* The store is in "HP ini" below, so only the role here. */}
        {role === '' ? null : <Text style={styles.whoMeta}>{role}</Text>}
      </View>

      <Section title={t('core.settings.security')} testID="settings-section-security">
        <ListRow
          leading={<RowIcon name="pin" />}
          primaryText={t('auth.pin.change.title')}
          secondaryText={t('core.settings.changePinSummary')}
          onPress={onOpenChangePin}
          testID="settings-change-pin"
        />
      </Section>

      {onOpenStaff === undefined &&
      onOpenStaffPins === undefined &&
      onOpenLimits === undefined ? null : (
        // The owner's people: who works here, and their PINs.
        <Section title={t('core.settings.team')} testID="settings-section-team">
          {onOpenStaff === undefined ? null : (
            <ListRow
              leading={<RowIcon name="staff" />}
              primaryText={t('auth.staff.title')}
              secondaryText={t('auth.staff.settingsSummary')}
              onPress={onOpenStaff}
              testID="settings-staff"
            />
          )}
          {onOpenLimits === undefined ? null : (
            <ListRow
              leading={<RowIcon name="limits" />}
              primaryText={t('auth.limits.title')}
              secondaryText={t('auth.limits.settingsSummary')}
              onPress={onOpenLimits}
              testID="settings-limits"
            />
          )}
          {onOpenStaffPins === undefined ? null : (
            // Owner-only: shown only when the acting user may unlock or reset a colleague's PIN.
            <ListRow
              leading={<RowIcon name="pin" />}
              primaryText={t('auth.pin.staff.title')}
              secondaryText={
                lockedStaffCount > 0
                  ? t('core.settings.staffPinsLocked', { count: lockedStaffCount })
                  : t('core.settings.staffPinsSummary')
              }
              onPress={onOpenStaffPins}
              testID="settings-staff-pins"
            />
          )}
        </Section>
      )}

      {modules
        .filter((module) => module.rows.length > 0)
        .map((module) => (
          <Section key={module.testID} title={module.section} testID={module.testID}>
            {module.rows.map((row) => (
              <ListRow
                key={row.testID}
                leading={<RowIcon name={row.icon} />}
                primaryText={row.title}
                secondaryText={row.summary}
                onPress={row.onOpen}
                testID={row.testID}
              />
            ))}
          </Section>
        ))}

      {/*
        The testID carries the locale `t()` is actually resolving in (read from the i18next instance,
        not the prop), so a device test can tell when the copy and the state disagree. It wraps a
        visible child: Maestro drops zero-size nodes from the hierarchy it queries.
      */}
      <View testID={`settings-rendered-locale-${getLocale()}`}>
        <Section title={t('core.settings.language')} testID="settings-section-language">
          {localeOptions.map((option) => (
            // ENDONYMS, identical in every locale (07-i18n §10.1), and the active one is checked, not
            // merely coloured: someone stranded in a language they cannot read can still find theirs.
            <ListRow
              key={option}
              leading={<RowIcon name="language" />}
              primaryText={t(localeNameKey(option) as 'core.language.id')}
              selected={option === locale}
              onPress={() => onSelectLocale(option)}
              testID={`settings-locale-${option}`}
            />
          ))}
        </Section>
      </View>

      <Section title={t('core.settings.notifications')} testID="settings-section-notifications">
        {MUTABLE_PUSH_CATEGORIES.map((category) => (
          // A row that OPENS the OS notification settings, not a mute switch (api/04-push §5; D18 §1):
          // Android forbids changing a channel's importance after creation and iOS has no channels,
          // so muting is the user's, in the phone's own settings.
          <ListRow
            key={category}
            leading={<RowIcon name="notifications" />}
            primaryText={t(NOTIFICATION_KEY[category])}
            secondaryText={t('core.settings.notificationsSummary')}
            onPress={() => onOpenNotificationSettings(category)}
            testID={`settings-notifications-${category}`}
          />
        ))}
      </Section>

      <Section
        title={t('core.settings.device')}
        rows={false}
        above={
          onOpenSetup === undefined ? null : (
            <ListRow
              leading={<RowIcon name="phoneDevice" />}
              primaryText={t('auth.setup.reopen')}
              secondaryText={t('auth.setup.reopenSummary')}
              onPress={onOpenSetup}
              testID="settings-setup"
            />
          )
        }
        testID="settings-section-device"
      >
        <View style={styles.facts} testID="settings-device-info">
          <FactGrid>
            <Fact
              label={t('core.settings.deviceName')}
              value={device.deviceName}
              testID="settings-device-name"
            />
            <Fact
              label={t('core.settings.store')}
              value={device.storeName}
              testID="settings-device-store"
            />
            <Fact
              label={t('core.settings.business')}
              value={device.tenantName}
              testID="settings-device-tenant"
            />
            <Fact
              label={t('core.settings.appVersion')}
              value={[device.appVersion, PLATFORM_NAME[device.platform]]
                .filter((part) => part !== '')
                .join(' · ')}
              testID="settings-device-platform"
            />
            <Fact
              label={t('core.settings.deviceId')}
              value={device.deviceId}
              wide
              testID="settings-device-id"
            />
          </FactGrid>
        </View>
      </Section>
    </AppShell>
  );
}

/** A titled group of rows. Rows run edge to edge; the title lines up with the screen gutter. */
function Section({
  title,
  children,
  rows = true,
  above,
  testID,
}: {
  readonly title: string;
  readonly children: ReactNode;
  /** False for content that is not a list of rows (the device facts). */
  readonly rows?: boolean;
  /** Rows above content that is not rows (the setup guide over the device facts). */
  readonly above?: ReactNode;
  readonly testID: string;
}): React.JSX.Element {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle} accessibilityRole="header" testID={testID}>
        {title}
      </Text>
      {above === undefined || above === null ? null : <View style={styles.rows}>{above}</View>}
      <View style={rows ? styles.rows : styles.plain}>{children}</View>
    </View>
  );
}

function RowIcon({ name }: { readonly name: IconName }): React.JSX.Element {
  return (
    <View style={styles.rowIcon}>
      <Icon name={name} size={size.iconInline} color={color.textMuted} />
    </View>
  );
}

/** The notification categories in the words of what they are about, not the push titles. */
const NOTIFICATION_KEY = {
  conflict: 'core.settings.notifyConflict',
  device: 'core.settings.notifyDevice',
} as const satisfies Record<MutablePushCategory, string>;

/** Brand names, the same in every language. */
const PLATFORM_NAME = { android: 'Android', ios: 'iOS', windows: 'Windows' } as const;

const styles = StyleSheet.create({
  who: { paddingTop: space.sm },
  whoName: { ...type.title, color: color.text },
  whoMeta: { ...type.bodySm, color: color.textMuted },
  section: { marginTop: space.xl },
  sectionTitle: { ...type.bodyBold, color: color.text, marginBottom: space.xs },
  rows: {
    marginHorizontal: -space.lg,
    borderTopWidth: border.hairline,
    borderTopColor: color.border,
  },
  plain: { marginTop: space.sm },
  rowIcon: {
    width: size.avatarRow,
    height: size.avatarRow,
    borderRadius: radius.full,
    backgroundColor: color.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Read-only facts sit on a quiet tinted box, so they never look like tappable rows.
  facts: {
    backgroundColor: color.surfaceAlt,
    borderRadius: radius.md,
    padding: space.lg,
    marginBottom: space.lg,
  },
});
