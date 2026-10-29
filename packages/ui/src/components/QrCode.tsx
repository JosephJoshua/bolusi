/**
 * QrCode — a QR for a phone to scan off this screen (a QRIS payment): black modules on white with
 * the quiet zone scanners need, whatever the theme. Drawn as one view per run of dark modules, so
 * it needs no SVG renderer, and each module is a whole number of pixels so the edges stay crisp.
 * The code is the PC's (`@bolusi/ui/qr`), so both draw the same QR for the same text.
 */
import { useMemo } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';

import { qrModules } from '../qr.js';
import { radius } from '../tokens.js';

export interface QrCodeProps {
  readonly value: string;
  /** Already-localized: what the code is for, read out instead of the picture. */
  readonly accessibilityLabel: string;
  /** The largest side it may take, in dp; it draws at most this. */
  readonly size?: number;
  readonly testID?: string | undefined;
}

const styles = StyleSheet.create({
  code: { backgroundColor: '#ffffff', borderRadius: radius.sm, alignSelf: 'center' },
  dark: { position: 'absolute', backgroundColor: '#000000' },
});

export function QrCode({
  value,
  accessibilityLabel,
  size = 240,
  testID = 'ui.qrCode',
}: QrCodeProps): React.JSX.Element {
  const qr = useMemo(() => qrModules(value), [value]);
  // Whole device pixels per module, so no run blurs into the next.
  const { scale } = useWindowDimensions();
  const module = Math.max(1, Math.floor((size * scale) / qr.size)) / scale;
  const side = module * qr.size;
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
      style={[styles.code, { width: side, height: side }]}
      testID={testID}
    >
      {qr.runs.map((run) => (
        <View
          key={`${String(run.y)}:${String(run.x)}`}
          style={[
            styles.dark,
            {
              left: run.x * module,
              top: run.y * module,
              width: run.length * module,
              height: module,
            },
          ]}
        />
      ))}
    </View>
  );
}
