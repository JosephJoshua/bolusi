/**
 * The react-native-web visual harness root (task 116).
 *
 * Reads its target from the query string — `?screen=<screen>&state=<state>` — so the Playwright suite
 * navigates to a deterministic screen-state by URL. With no (or an unknown) target it renders an
 * INDEX listing every available entry, which doubles as a "the harness actually booted" smoke check.
 *
 * i18n is booted by the entry (`index.web.tsx`) BEFORE this renders, because every screen resolves
 * labels through `t()` which throws if the instance is not up (07-i18n) — a device has the same rule.
 */
/* eslint-disable bolusi/no-hardcoded-strings --
 * DEV-ONLY visual harness index page (task 116) — never shipped. Its labels are harness chrome, not
 * product UI, and must NOT enter the @bolusi/i18n catalog guarded by the id/en parity gate
 * (07-i18n §7.3). The real screens it links to resolve all their copy through the catalog. */
import { color, space, type } from '@bolusi/ui';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { ENTRIES, findEntry } from './gallery.js';

/** Parse `?screen=&state=` from the browser URL. Empty when neither is present. */
export function readTarget(search: string): { screen: string | null; state: string | null } {
  const params = new URLSearchParams(search);
  return { screen: params.get('screen'), state: params.get('state') };
}

export function WebHarnessRoot(): React.JSX.Element {
  const { screen, state } = readTarget(typeof window === 'undefined' ? '' : window.location.search);

  if (screen !== null && state !== null) {
    const entry = findEntry(screen, state);
    if (entry !== undefined) return entry.render();
    return (
      <View testID="web-harness-unknown" style={styles.pad}>
        <Text style={styles.title}>
          Unknown screen/state: {screen}/{state}
        </Text>
      </View>
    );
  }

  return (
    <ScrollView testID="web-harness-index" style={styles.index} contentContainerStyle={styles.pad}>
      <View testID="rnw-approx-label" style={styles.label}>
        <Text style={styles.labelText}>RNW browser approximation — NOT device-verified</Text>
      </View>
      <Text style={styles.title}>Bolusi RN screens — web visual harness</Text>
      <Text style={styles.note}>
        Append ?screen=&lt;screen&gt;&amp;state=&lt;state&gt; (optionally &amp;locale=id|en) to open
        one.
      </Text>
      {ENTRIES.map((entry) => (
        <Text
          key={`${entry.screen}/${entry.state}`}
          testID={`index-link-${entry.screen}-${entry.state}`}
          accessibilityRole="link"
          style={styles.link}
          onPress={() => {
            if (typeof window !== 'undefined') {
              window.location.search = `?screen=${entry.screen}&state=${entry.state}`;
            }
          }}
        >
          {entry.screen} / {entry.state}
        </Text>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  index: { flex: 1, backgroundColor: color.surfaceAlt },
  pad: { padding: space.lg, gap: space.xs },
  label: {
    backgroundColor: color.danger,
    paddingVertical: space.xs,
    paddingHorizontal: space.sm,
    alignItems: 'center',
    marginBottom: space.md,
  },
  labelText: { ...type.caption, color: color.onDanger, fontWeight: '700' },
  title: { ...type.heading, color: color.text, marginBottom: space.sm },
  note: { ...type.bodySm, color: color.textMuted, marginBottom: space.md },
  link: { ...type.bodySm, color: color.primary, paddingVertical: space.sm },
});
