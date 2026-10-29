// Screen pieces every module's phone screens share: the four read states around a query, the
// banner for a refused action, a captioned section and the full-screen step of a flow. React Native
// only, so this lives under a `screens/` path (the platform-free boundary).
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
  Text,
} from '@bolusi/ui';
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import type { QueryState } from '../live.js';

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

/** The chrome every full-screen step shares: the shell's sync chip and avatar. */
export interface ScreenChrome {
  readonly syncChip: ReactNode;
  readonly avatar: ReactNode;
}

/**
 * One full-screen step of a flow (design-system §3.10: flows, not modals): a back arrow, the body,
 * the refused-action banner and one primary action at the bottom. A step whose choices are its rows
 * (picking a technician) has no primary action. A step that asks a yes/no question (did the customer
 * agree?) puts the question over both answers, the "no" beside the primary as its equal.
 */
export function FlowScreen({
  chrome,
  title,
  onBack,
  primaryLabel,
  onPrimary,
  primaryDisabled,
  primaryHint,
  primaryVariant,
  secondary,
  question,
  busy,
  errorCode,
  onClearError,
  notice,
  onClearNotice,
  overlay,
  stale,
  scrollKey,
  testID,
  children,
}: {
  readonly chrome: ScreenChrome;
  readonly title: string;
  readonly onBack: () => void;
  readonly primaryLabel?: string | undefined;
  readonly onPrimary?: (() => void) | undefined;
  readonly primaryDisabled?: boolean | undefined;
  /** Said above a disabled primary, so the user knows what it is waiting for. */
  readonly primaryHint?: string | undefined;
  readonly primaryVariant?: 'primary' | 'destructive' | undefined;
  /** The other answer to `question`, drawn beside the primary. */
  readonly secondary?:
    | {
        readonly label: string;
        readonly onPress: () => void;
        readonly disabled?: boolean | undefined;
        readonly testID: string;
      }
    | undefined;
  /** Already-localized question the bottom answers reply to. */
  readonly question?: string | undefined;
  readonly busy: boolean;
  readonly errorCode: string | null;
  readonly onClearError: () => void;
  /** Already-localized word on what the last action did, shown when nothing was refused. */
  readonly notice?: string | null | undefined;
  readonly onClearNotice?: (() => void) | undefined;
  readonly overlay?: ReactNode;
  /**
   * The record changed elsewhere and this step can no longer finish: `message` is said in the
   * banner slot, and the bottom action becomes the way back, labelled `backLabel`. Held back while the step's own command runs, since
   * that command changes the ticket too and the step closes as it lands: the runner clears `busy`
   * and the step's `onDone` closes it in the same batched update, so the notice never shows.
   */
  readonly stale?: { readonly message: string; readonly backLabel: string } | null | undefined;
  /** A multi-step flow's step: each step opens scrolled to the top (AppShell `scrollKey`). */
  readonly scrollKey?: string | number | undefined;
  readonly testID: string;
  readonly children: ReactNode;
}): React.JSX.Element {
  const staleNow = busy || stale === undefined ? null : stale;
  return (
    <AppShell
      scrollable
      scrollKey={scrollKey}
      title={title}
      titleVariant="detail"
      onBack={onBack}
      backLabel={t('core.action.back')}
      syncChip={chrome.syncChip}
      avatar={chrome.avatar}
      overlay={overlay}
      // In the fixed banner slot, not the scrolling content: a refusal must be seen wherever the
      // user had scrolled to when they pressed the bottom action. The stale notice outranks a
      // refusal, since it says why the refusal happened.
      banner={
        staleNow !== null ? (
          <Banner variant="warning" message={staleNow.message} testID={`${testID}.stale`} />
        ) : errorCode !== null ? (
          <ActionErrorBanner
            errorCode={errorCode}
            onDismiss={onClearError}
            testID={`${testID}.error`}
          />
        ) : notice !== null && notice !== undefined ? (
          <Banner
            variant="info"
            message={notice}
            onPress={onClearNotice}
            testID={`${testID}.notice`}
          />
        ) : undefined
      }
      bottomAction={
        staleNow !== null ? (
          <Button label={staleNow.backLabel} onPress={onBack} testID={`${testID}.staleBack`} />
        ) : primaryLabel === undefined || onPrimary === undefined ? undefined : (
          <View>
            {primaryDisabled === true && primaryHint !== undefined ? (
              <Text style={styles.hint} testID={`${testID}.primaryHint`}>
                {primaryHint}
              </Text>
            ) : null}
            {question === undefined ? null : (
              <Text style={styles.question} testID={`${testID}.question`}>
                {question}
              </Text>
            )}
            <View style={styles.answers}>
              {secondary === undefined ? null : (
                <View style={styles.answer}>
                  <Button
                    label={secondary.label}
                    onPress={secondary.onPress}
                    variant="secondary"
                    disabled={secondary.disabled === true || busy}
                    testID={secondary.testID}
                  />
                </View>
              )}
              <View style={styles.answer}>
                <Button
                  label={primaryLabel}
                  onPress={onPrimary}
                  variant={primaryVariant ?? 'primary'}
                  disabled={primaryDisabled === true || busy}
                  busy={busy}
                  testID={`${testID}.primary`}
                />
              </View>
            </View>
          </View>
        )
      }
      testID={testID}
    >
      {/* Once stale, kept in view so the user sees what they had filled in, but not workable. */}
      <View
        pointerEvents={staleNow === null ? 'auto' : 'none'}
        style={staleNow === null ? undefined : styles.inert}
        testID={`${testID}.body`}
      >
        {children}
      </View>
    </AppShell>
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

const styles = StyleSheet.create({
  hint: { ...type.bodySm, color: color.textMuted, marginBottom: space.sm, textAlign: 'center' },
  inert: { opacity: 0.45 },
  question: { ...type.bodyBold, color: color.text, marginBottom: space.md, textAlign: 'center' },
  answers: { flexDirection: 'row', gap: space.md },
  answer: { flex: 1 },
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
});
