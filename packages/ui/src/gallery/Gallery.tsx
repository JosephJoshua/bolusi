/**
 * Gallery — DEV-ONLY screen enumerating every component in every mandatory state.
 *
 * It is driven by `stateRegistry`, the same source the coverage test walks, so what you see here
 * and what CI proves can never drift apart. This is the surface where the §9 review checklist
 * ("reviewer navigates to each state") is actually exercisable on a real 2 GB device — contrast in
 * a bright shop and 1.3× font scale are things you look at, not assert.
 *
 * Dev-only by convention: nothing routes to it in a release build (task 24 owns navigation). It is
 * exported so the app can mount it behind a dev flag.
 *
 * Copy arrives as `labels` — even here. `@bolusi/ui` never calls `t()` (08-stack §3.3).
 */
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { border, color, space, type } from '../tokens.js';
import { stateRegistry, type GalleryLabels } from './registry.js';

export interface GalleryProps {
  /** Resolved from the label catalog by the host screen. */
  readonly labels: GalleryLabels;
  readonly testID?: string | undefined;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.surface },
  content: { padding: space.lg },
  component: { marginBottom: space['2xl'] },
  componentName: { ...type.heading, color: color.text, marginBottom: space.sm },
  state: {
    borderTopWidth: border.hairline,
    borderTopColor: color.border,
    paddingTop: space.md,
    marginTop: space.md,
  },
  // The state id is a developer-facing identifier, not product copy — it is intentionally not
  // localized, and it is what a reviewer reads to match a rendering to the design-system section.
  stateId: { ...type.caption, color: color.textMuted, marginBottom: space.sm },
});

export function Gallery({ labels, testID = 'ui.gallery' }: GalleryProps): React.JSX.Element {
  const entries = Object.entries(stateRegistry);

  return (
    <ScrollView testID={testID} style={styles.root} contentContainerStyle={styles.content}>
      {entries.map(([name, states]) => (
        <View key={name} testID={`${testID}.${name}`} style={styles.component}>
          <Text style={styles.componentName}>{name}</Text>
          {states.map((state) => (
            <View key={state.id} testID={`${testID}.${name}.${state.id}`} style={styles.state}>
              <Text style={styles.stateId}>{state.id}</Text>
              {state.render(labels)}
            </View>
          ))}
        </View>
      ))}
    </ScrollView>
  );
}
