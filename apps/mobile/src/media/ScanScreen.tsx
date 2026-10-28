// The scanner surface: the viewfinder fills the screen with a frame to aim the code into and one
// line saying what to do. A scan needs no button: the first code the camera reads ends it.
import { t } from '@bolusi/i18n';
import {
  AppShell,
  LoadingState,
  UnauthorizedState,
  border,
  color,
  radius,
  space,
  type,
} from '@bolusi/ui';
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { ScanScreenState } from './ScanHost.js';

export interface ScanScreenProps {
  readonly state: ScanScreenState;
  /** The live scanner on a device; a plain node under test. */
  readonly preview: ReactNode;
  readonly syncChip: ReactNode;
  readonly avatar: ReactNode;
  readonly onBack: () => void;
}

export function ScanScreen({
  state,
  preview,
  syncChip,
  avatar,
  onBack,
}: ScanScreenProps): React.JSX.Element {
  return (
    <AppShell
      title={t('media.scan.title')}
      titleVariant="detail"
      onBack={onBack}
      backLabel={t('core.action.back')}
      syncChip={syncChip}
      avatar={avatar}
      testID="scan-screen"
    >
      {state.kind === 'permission_pending' ? (
        <LoadingState variant="spinner" testID="scan-loading" />
      ) : state.kind === 'permission_denied' ? (
        <UnauthorizedState
          title={t('media.permission.cameraDeniedTitle')}
          hint={t('media.permission.cameraDeniedBody')}
          backLabel={t('core.action.back')}
          onBack={onBack}
          testID="scan-unauthorized"
        />
      ) : (
        <View style={styles.viewfinder} testID="scan-viewfinder">
          {preview}
          <View style={styles.overlay} pointerEvents="none">
            <View style={styles.frame} />
            <Text style={styles.hint}>{t('media.scan.hint')}</Text>
          </View>
        </View>
      )}
    </AppShell>
  );
}

const styles = StyleSheet.create({
  viewfinder: {
    flex: 1,
    backgroundColor: color.surfaceAlt,
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  overlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.lg,
    gap: space.lg,
  },
  // Wide rather than square: most codes on parts are 1D barcodes; a QR code fits too.
  frame: {
    width: '80%',
    aspectRatio: 1.6,
    borderWidth: border.hairline * 3,
    borderColor: color.surface,
    borderRadius: radius.md,
  },
  hint: {
    ...type.bodySm,
    color: color.text,
    backgroundColor: color.surface,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.sm,
    textAlign: 'center',
  },
});
