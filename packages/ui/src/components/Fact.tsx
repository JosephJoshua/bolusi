/**
 * A key fact on a detail screen: a small label over its value, laid out two to a row by `FactGrid`
 * (the servisan's technician and due date, this phone's name and store). The value can carry the
 * one action that changes it ("Ganti" beside the technician). A `wide` fact takes the whole row, for
 * a value too long to share it (a device ID, a list one per line); its action sits at the end of the
 * label's line, so it stays put however many lines the value takes. Values wrap, never truncate.
 */
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { color, size, space, type } from '../tokens.js';

export interface FactProps {
  /** Already-localized. */
  readonly label: string;
  readonly value: string;
  readonly action?: ReactNode;
  readonly wide?: boolean | undefined;
  /** Drawn under the value, e.g. a note that belongs to this fact. */
  readonly children?: ReactNode;
  readonly testID?: string | undefined;
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: space.md },
  fact: { width: '50%', paddingRight: space.sm },
  wide: { width: '100%', paddingRight: 0 },
  label: { ...type.caption, color: color.textMuted },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  labelAction: { marginRight: -space.sm },
  // The action wraps under the value when both don't fit, so a name never breaks around it.
  valueRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: space.sm,
    minHeight: size.control,
  },
  value: { ...type.bodySm, fontWeight: '600', color: color.text, flexShrink: 1 },
});

export function Fact({
  label,
  value,
  action,
  wide = false,
  children,
  testID,
}: FactProps): React.JSX.Element {
  return (
    <View style={[styles.fact, wide ? styles.wide : null]}>
      {wide && action !== undefined && action !== null ? (
        <>
          <View style={styles.labelRow}>
            <Text style={styles.label}>{label}</Text>
            {/* A TextButton's padding is hit area: its text lines up with the value's right edge. */}
            <View style={styles.labelAction}>{action}</View>
          </View>
          <Text style={styles.value} testID={testID} selectable>
            {value}
          </Text>
        </>
      ) : (
        <>
          <Text style={styles.label}>{label}</Text>
          <View style={styles.valueRow}>
            <Text style={styles.value} testID={testID} selectable>
              {value}
            </Text>
            {action}
          </View>
        </>
      )}
      {children}
    </View>
  );
}

export function FactGrid({ children }: { readonly children: ReactNode }): React.JSX.Element {
  return <View style={styles.grid}>{children}</View>;
}
