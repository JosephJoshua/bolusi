/**
 * Rows — a stack of list rows with a hairline between each pair and none under the last.
 *
 * Rows draw no divider of their own: the line belongs to the list, so it can never dangle under the
 * last row. `List` uses `RowDivider` as its separator; a short list built in a screen wraps its rows
 * here. A `null` or `false` child (a row that is not shown) gets no divider either.
 */
import { Children, Fragment, isValidElement, type ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewProps, type ViewStyle } from 'react-native';

import { border, color, space } from '../tokens.js';

export interface RowsProps {
  readonly children: ReactNode;
  readonly style?: StyleProp<ViewStyle>;
  /** `radiogroup` when the rows are one choice of several. */
  readonly accessibilityRole?: ViewProps['accessibilityRole'];
  readonly testID?: string | undefined;
}

const styles = StyleSheet.create({
  divider: { height: border.hairline, backgroundColor: color.border },
  // Out through the screen gutter, under rows that reach through it themselves.
  edge: { marginHorizontal: -space.lg },
});

/** The hairline between two rows. `edgeToEdge` runs it through the screen's gutter. */
export function RowDivider({
  edgeToEdge = false,
}: {
  readonly edgeToEdge?: boolean | undefined;
}): React.JSX.Element {
  return <View testID="ui.rowDivider" style={[styles.divider, edgeToEdge ? styles.edge : null]} />;
}

export function Rows({ children, style, accessibilityRole, testID }: RowsProps): React.JSX.Element {
  const rows = Children.toArray(children);
  return (
    <View testID={testID} style={style} accessibilityRole={accessibilityRole}>
      {rows.map((row, index) => (
        <Fragment key={isValidElement(row) && row.key !== null ? row.key : index}>
          {index === 0 ? null : <RowDivider />}
          {row}
        </Fragment>
      ))}
    </View>
  );
}
