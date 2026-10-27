/**
 * The react-native-web visual harness root (task 116), also served as the hosted preview
 * (docs/previews.md).
 *
 * Reads its target from the query string — `?screen=<screen>&state=<state>` — so the Playwright suite
 * navigates to a deterministic screen-state by URL. With no (or an unknown) target it renders the
 * preview HOME: sign in as a demo role, or open any single screen state. That page doubles as the
 * "the harness actually booted" smoke check.
 *
 * On a wide browser window everything renders in a phone-width column, because these are phone
 * screens; stretched across a laptop they read nothing like the app. `&frame=tablet` drops that
 * column so the window is the tablet, for checking the tablet layouts.
 *
 * i18n is booted by the entry (`index.web.tsx`) BEFORE this renders, because every screen resolves
 * labels through `t()` which throws if the instance is not up (07-i18n) — a device has the same rule.
 */
/* eslint-disable bolusi/no-hardcoded-strings --
 * DEV-ONLY preview chrome (task 116) — never shipped in the native app. Its labels are harness
 * chrome, not product UI, and must NOT enter the @bolusi/i18n catalog guarded by the id/en parity
 * gate (07-i18n §7.3). The real screens it links to resolve all their copy through the catalog. */
import { getLocale, type Locale } from '@bolusi/i18n';
import {
  Avatar,
  ListRow,
  SegmentedControl,
  ViewportProvider,
  color,
  radius,
  space,
  type,
} from '@bolusi/ui';
import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { ENTRIES, findEntry } from './gallery.js';
import { DEMO_REPAIR_ROLES, type DemoRepairRole } from './repair-demo.js';

/** Parse `?screen=&state=` from the browser URL. Empty when neither is present. */
export function readTarget(search: string): {
  screen: string | null;
  state: string | null;
  tablet: boolean;
} {
  const params = new URLSearchParams(search);
  return {
    screen: params.get('screen'),
    state: params.get('state'),
    tablet: params.get('frame') === 'tablet',
  };
}

/** Open a screen state (or the home page with no target), keeping the chosen language. */
function go(target: { screen: string; state: string } | null, locale: Locale = getLocale()): void {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams();
  if (target !== null) {
    params.set('screen', target.screen);
    params.set('state', target.state);
  }
  params.set('locale', locale);
  if (readTarget(window.location.search).tablet) params.set('frame', 'tablet');
  window.location.search = `?${params.toString()}`;
}

/** Which build this is, stamped by the preview deploy (e.g. "PR #31 · 1a2b3c4"). Absent locally. */
const BUILD_LABEL = process.env['EXPO_PUBLIC_PREVIEW_LABEL'] ?? '';

const COPY = {
  id: {
    title: 'Bolusi',
    subtitle: 'Pratinjau aplikasi HP dengan data contoh.',
    signInAs: 'Masuk sebagai',
    note: 'Perubahan hanya tersimpan di tab ini. Muat ulang untuk mulai dari awal. Kamera, tanda tangan dan sinkron hanya tiruan.',
    allScreens: 'Semua layar',
    home: 'Pratinjau',
    roles: {
      owner: 'Pemilik usaha',
      storeOwner: 'Pemilik toko',
      counter: 'Kasir',
      technician: 'Teknisi',
    },
  },
  en: {
    title: 'Bolusi',
    subtitle: 'A preview of the phone app with sample data.',
    signInAs: 'Sign in as',
    note: 'Changes stay in this tab only. Reload to start over. Camera, signature and sync are simulated.',
    allScreens: 'All screens',
    home: 'Preview',
    roles: {
      owner: 'Business owner',
      storeOwner: 'Store owner',
      counter: 'Counter',
      technician: 'Technician',
    },
  },
} as const;

const ROLE_ORDER: readonly DemoRepairRole[] = ['counter', 'technician', 'storeOwner', 'owner'];

function initials(name: string): string {
  return name
    .split(' ')
    .map((part) => part.charAt(0))
    .join('')
    .slice(0, 2);
}

/** Centres a phone-width column on wide windows; a no-op at phone width. */
function PhoneColumn({
  tablet,
  children,
}: {
  readonly tablet: boolean;
  readonly children: ReactNode;
}): React.JSX.Element {
  return (
    <View style={styles.backdrop}>
      {/* The screens size themselves to this column, not to the browser window around it. */}
      <ViewportProvider style={[styles.column, tablet ? styles.tablet : null]}>
        {children}
      </ViewportProvider>
    </View>
  );
}

function PreviewHome(): React.JSX.Element {
  // Only id and en are selectable (SELECTABLE_LOCALES); anything else reads in English.
  const locale = getLocale() === 'id' ? 'id' : 'en';
  const copy = COPY[locale];
  const screens = [...new Set(ENTRIES.map((entry) => entry.screen))];

  return (
    <ScrollView testID="web-harness-index" style={styles.home} contentContainerStyle={styles.pad}>
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.title}>{copy.title}</Text>
          <Text style={styles.muted}>{copy.subtitle}</Text>
        </View>
        <SegmentedControl
          testID="preview.locale"
          size="compact"
          options={[
            { value: 'id', label: 'ID' },
            { value: 'en', label: 'EN' },
          ]}
          value={locale}
          onChange={(next) => go(null, next)}
        />
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{copy.signInAs}</Text>
        <View style={styles.card}>
          {ROLE_ORDER.map((role) => {
            const person = DEMO_REPAIR_ROLES[role];
            return (
              <ListRow
                key={role}
                testID={`preview.role.${role}`}
                primaryText={copy.roles[role]}
                secondaryText={person.name}
                leading={<Avatar userId={person.userId} initials={initials(person.name)} />}
                showChevron
                onPress={() => go({ screen: 'repair', state: role })}
              />
            );
          })}
        </View>
        <Text style={styles.caption}>{copy.note}</Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{copy.allScreens}</Text>
        {screens.map((screen) => (
          <View key={screen} style={styles.group}>
            <Text style={styles.groupTitle}>{screen}</Text>
            <View style={styles.states}>
              {ENTRIES.filter((entry) => entry.screen === screen).map((entry) => (
                <Pressable
                  key={entry.state}
                  testID={`index-link-${entry.screen}-${entry.state}`}
                  accessibilityRole="link"
                  style={styles.state}
                  onPress={() => go(entry)}
                >
                  <Text style={styles.stateText}>{entry.state}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        ))}
      </View>

      {BUILD_LABEL === '' ? null : (
        <Text testID="preview.build" style={styles.caption}>
          {BUILD_LABEL}
        </Text>
      )}
    </ScrollView>
  );
}

export function WebHarnessRoot(): React.JSX.Element {
  const { screen, state, tablet } = readTarget(
    typeof window === 'undefined' ? '' : window.location.search,
  );

  if (screen !== null && state !== null) {
    const entry = findEntry(screen, state);
    if (entry !== undefined) return <PhoneColumn tablet={tablet}>{entry.render()}</PhoneColumn>;
    return (
      <View testID="web-harness-unknown" style={styles.pad}>
        <Text style={styles.title}>
          Unknown screen/state: {screen}/{state}
        </Text>
      </View>
    );
  }

  return (
    <PhoneColumn tablet={tablet}>
      <PreviewHome />
    </PhoneColumn>
  );
}

/** The widest a phone gets; beyond it the column stops growing and the backdrop shows. */
const PHONE_MAX_WIDTH = 480;

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: color.surfaceAlt },
  column: {
    flex: 1,
    width: '100%',
    maxWidth: PHONE_MAX_WIDTH,
    alignSelf: 'center',
    backgroundColor: color.surface,
    overflow: 'hidden',
  },
  tablet: { maxWidth: '100%' },
  home: { flex: 1, backgroundColor: color.surface },
  pad: { padding: space.lg, gap: space.xl },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  headerText: { flex: 1, gap: space.xs },
  title: { ...type.title, color: color.text },
  muted: { ...type.bodySm, color: color.textMuted },
  section: { gap: space.sm },
  sectionTitle: { ...type.bodyBold, color: color.text },
  card: {
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    overflow: 'hidden',
  },
  caption: { ...type.caption, color: color.textMuted },
  group: { gap: space.xs, paddingVertical: space.xs },
  groupTitle: { ...type.caption, color: color.textMuted, fontWeight: '600' },
  states: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  state: {
    paddingVertical: space.xs,
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
    backgroundColor: color.surfaceAlt,
  },
  stateText: { ...type.caption, color: color.primary, fontWeight: '600' },
});
