// Phone pieces every module's screens share: the four read states around a query, the banner for a
// refused action, a captioned section and a one-task step screen with its bottom action.
import { t, translateErrorCode, translateFailure } from '@bolusi/i18n';
import {
  AppShell,
  Banner,
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  UnauthorizedState,
  color,
  size,
  space,
  type,
} from '@bolusi/ui';
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { QueryState } from '../live.js';

/** The chrome every full-screen step shares: the shell's sync chip and avatar. */
export interface ScreenChrome {
  readonly syncChip: ReactNode;
  readonly avatar: ReactNode;
}

/**
 * Render a read's loading, unauthorized and error states, and `ready` through `children`. A missing
 * entity is the Empty state (the thing asked for is not here), never an error (design-system §5).
 */
export function QueryView<TData>({
  query,
  onBack,
  onRetry,
  testID,
  children,
}: {
  readonly query: QueryState<TData>;
  readonly onBack: () => void;
  readonly onRetry: () => void;
  readonly testID: string;
  readonly children: (data: TData) => ReactNode;
}): React.JSX.Element {
  switch (query.status) {
    case 'loading':
      return (
        <View testID={`${testID}.loading`}>
          <LoadingState variant="spinner" />
        </View>
      );
    case 'unauthorized':
      return (
        <UnauthorizedState
          title={t('core.errors.PERMISSION_DENIED')}
          hint={t('core.unauthorized.askOwner')}
          backLabel={t('core.action.back')}
          onBack={onBack}
          testID={`${testID}.unauthorized`}
        />
      );
    case 'error':
      if (query.code === 'ENTITY_NOT_FOUND') {
        return <EmptyState title={t('core.errors.ENTITY_NOT_FOUND')} testID={`${testID}.empty`} />;
      }
      return (
        <ErrorState
          title={translateErrorCode(query.code)}
          errorCode={query.code}
          retryLabel={t('core.action.retry')}
          onRetry={onRetry}
          testID={`${testID}.error`}
        />
      );
    case 'ready':
      return <>{children(query.data)}</>;
  }
}

/** A refused command, shown where the user tried it. Danger banners cannot be dismissed (§3.6), so a
 * tap clears it instead. */
export function ActionErrorBanner({
  errorCode,
  onDismiss,
  testID,
}: {
  readonly errorCode: string | null;
  readonly onDismiss: () => void;
  readonly testID: string;
}): React.JSX.Element | null {
  if (errorCode === null) return null;
  return (
    <Banner
      variant="danger"
      message={translateFailure(errorCode)}
      onPress={onDismiss}
      testID={testID}
    />
  );
}

/** A captioned group on a detail or review screen, with an optional compact action beside the title. */
export function Section({
  title,
  action,
  first = false,
  children,
  testID,
}: {
  readonly title: string;
  readonly action?: ReactNode;
  /** The screen's first section: the screen's own top padding is room enough above it. */
  readonly first?: boolean | undefined;
  readonly children: ReactNode;
  readonly testID?: string | undefined;
}): React.JSX.Element {
  return (
    <View style={first ? undefined : styles.section} testID={testID}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>{title}</Text>
        {/* A TextButton's padding is hit area: its text lines up with the content's right edge. */}
        {action === undefined ? null : <View style={styles.sectionAction}>{action}</View>}
      </View>
      {children}
    </View>
  );
}

/**
 * One full-screen task (design-system §3.10: flows, not modals): a back arrow, the body, the
 * refused-action banner and one primary action at the bottom, with a hint above it while it waits
 * for something.
 */
export function StepScreen({
  chrome,
  title,
  onBack,
  primaryLabel,
  onPrimary,
  primaryDisabled,
  primaryHint,
  busy,
  errorCode,
  onClearError,
  overlay,
  testID,
  children,
}: {
  readonly chrome: ScreenChrome;
  readonly title: string;
  readonly onBack: () => void;
  readonly primaryLabel: string;
  readonly onPrimary: () => void;
  readonly primaryDisabled?: boolean | undefined;
  /** Said above a disabled primary, so the user knows what it is waiting for. */
  readonly primaryHint?: string | undefined;
  readonly busy: boolean;
  readonly errorCode: string | null;
  readonly onClearError: () => void;
  readonly overlay?: ReactNode;
  readonly testID: string;
  readonly children: ReactNode;
}): React.JSX.Element {
  return (
    <AppShell
      scrollable
      title={title}
      titleVariant="detail"
      onBack={onBack}
      backLabel={t('core.action.back')}
      syncChip={chrome.syncChip}
      avatar={chrome.avatar}
      overlay={overlay}
      banner={
        <ActionErrorBanner
          errorCode={errorCode}
          onDismiss={onClearError}
          testID={`${testID}.error`}
        />
      }
      bottomAction={
        <View>
          {primaryDisabled === true && primaryHint !== undefined ? (
            <Text style={styles.hint} testID={`${testID}.primaryHint`}>
              {primaryHint}
            </Text>
          ) : null}
          <Button
            label={primaryLabel}
            onPress={onPrimary}
            disabled={primaryDisabled === true || busy}
            busy={busy}
            testID={`${testID}.primary`}
          />
        </View>
      }
      testID={testID}
    >
      {children}
    </AppShell>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: space.xl },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: size.control,
    marginBottom: space.sm,
  },
  sectionAction: { marginRight: -space.sm },
  sectionTitle: { ...type.bodyBold, color: color.text, flexShrink: 1 },
  hint: { ...type.bodySm, color: color.textMuted, marginBottom: space.sm, textAlign: 'center' },
});
