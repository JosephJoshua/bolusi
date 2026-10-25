// Small pieces every repair screen shares: the four read states around a query, a verified photo
// thumbnail, the ticket status chip and the banner for a refused action.
import { t, translateErrorCode } from '@bolusi/i18n';
import {
  AppShell,
  Banner,
  Button,
  Chip,
  EmptyState,
  ErrorState,
  Icon,
  LoadingState,
  UnauthorizedState,
  color,
  radius,
  size,
  space,
  type,
  type IconName,
} from '@bolusi/ui';
import { Image } from 'expo-image';
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { QueryState, ThumbnailRef } from '../../screen-kit/index.js';

import { statusLabel } from './labels.js';
import { statusTone, type TicketStatus } from '../flows.js';
import { useRepairThumbnail } from './runtime.js';

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
      message={translateErrorCode(errorCode)}
      onPress={onDismiss}
      testID={testID}
    />
  );
}

const STATUS_ICON: Readonly<Record<TicketStatus, IconName>> = {
  received: 'pending',
  in_repair: 'repair',
  waiting_for_parts: 'warning',
  repaired: 'success',
  cancelled: 'rejected',
  returned: 'check',
};

export function StatusChip({
  status,
  testID,
}: {
  readonly status: TicketStatus;
  readonly testID: string;
}): React.JSX.Element {
  return (
    <Chip
      label={statusLabel(status)}
      icon={STATUS_ICON[status]}
      tone={statusTone(status)}
      testID={testID}
    />
  );
}

/** A photo by its signed ref, verified before display; honest placeholders otherwise (06 §6). */
export function PhotoThumb({
  photo,
  testID,
}: {
  readonly photo: ThumbnailRef;
  readonly testID: string;
}): React.JSX.Element {
  const state = useRepairThumbnail(photo);
  switch (state.kind) {
    case 'ready':
      return (
        <Image
          source={{ uri: state.uri }}
          contentFit="cover"
          style={styles.thumb}
          testID={`${testID}.image`}
        />
      );
    case 'loading':
      return (
        <View style={styles.placeholder} testID={`${testID}.loading`}>
          <LoadingState variant="spinner" />
        </View>
      );
    case 'unavailable':
      return (
        <View style={styles.placeholder} testID={`${testID}.unavailable`}>
          <Icon name="pending" size={size.iconInline} color={color.textMuted} />
        </View>
      );
    case 'mismatch':
      return (
        <View style={styles.placeholder} testID={`${testID}.mismatch`}>
          <Icon name="rejected" size={size.iconInline} color={color.danger} />
        </View>
      );
  }
}

/** The chrome every full-screen repair step shares: the shell's sync chip and avatar. */
export interface RepairChrome {
  readonly syncChip: ReactNode;
  readonly avatar: ReactNode;
}

/**
 * One full-screen step of a flow (design-system §3.10: flows, not modals): a back arrow, the body,
 * the refused-action banner and one primary action at the bottom. A step whose choices are its rows
 * (picking a technician) has no primary action.
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
  busy,
  errorCode,
  onClearError,
  overlay,
  testID,
  children,
}: {
  readonly chrome: RepairChrome;
  readonly title: string;
  readonly onBack: () => void;
  readonly primaryLabel?: string | undefined;
  readonly onPrimary?: (() => void) | undefined;
  readonly primaryDisabled?: boolean | undefined;
  /** Said above a disabled primary, so the user knows what it is waiting for. */
  readonly primaryHint?: string | undefined;
  readonly primaryVariant?: 'primary' | 'destructive' | undefined;
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
      // In the fixed banner slot, not the scrolling content: a refusal must be seen wherever the
      // user had scrolled to when they pressed the bottom action.
      banner={
        errorCode === null ? undefined : (
          <ActionErrorBanner
            errorCode={errorCode}
            onDismiss={onClearError}
            testID={`${testID}.error`}
          />
        )
      }
      bottomAction={
        primaryLabel === undefined || onPrimary === undefined ? undefined : (
          <View>
            {primaryDisabled === true && primaryHint !== undefined ? (
              <Text style={styles.hint} testID={`${testID}.primaryHint`}>
                {primaryHint}
              </Text>
            ) : null}
            <Button
              label={primaryLabel}
              onPress={onPrimary}
              variant={primaryVariant ?? 'primary'}
              disabled={primaryDisabled === true || busy}
              busy={busy}
              testID={`${testID}.primary`}
            />
          </View>
        )
      }
      testID={testID}
    >
      {children}
    </AppShell>
  );
}

/** A captioned group on a detail or review screen, with an optional compact action beside the title. */
export function Section({
  title,
  action,
  children,
  testID,
}: {
  readonly title: string;
  readonly action?: ReactNode;
  readonly children: ReactNode;
  readonly testID?: string | undefined;
}): React.JSX.Element {
  return (
    <View style={styles.section} testID={testID}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>{title}</Text>
        {action}
      </View>
      {children}
    </View>
  );
}

/** A label and its value on one line, e.g. "IMEI  356789…". */
export function Field({
  label,
  value,
  testID,
}: {
  readonly label: string;
  readonly value: string;
  readonly testID?: string | undefined;
}): React.JSX.Element {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={styles.fieldValue} testID={testID}>
        {value}
      </Text>
    </View>
  );
}

/** Photos laid out in a wrapping grid. */
export function PhotoGrid({ children }: { readonly children: ReactNode }): React.JSX.Element {
  return <View style={styles.grid}>{children}</View>;
}

export const repairStyles = StyleSheet.create({
  gridCell: { width: '31%' },
  caption: { ...type.caption, color: color.textMuted, marginTop: space.xs },
  muted: { ...type.bodySm, color: color.textMuted },
  body: { ...type.body, color: color.text },
  heading: { ...type.heading, color: color.text },
  gap: { marginTop: space.md },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  /** The growing side of a `row`: wraps instead of pushing the amount beside it off screen. */
  rowText: { flexShrink: 1, marginRight: space.md },
  warning: { ...type.bodySm, color: color.warning },
});

const styles = StyleSheet.create({
  hint: { ...type.bodySm, color: color.textMuted, marginBottom: space.sm, textAlign: 'center' },
  thumb: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: radius.md,
    backgroundColor: color.surfaceAlt,
  },
  placeholder: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: radius.md,
    backgroundColor: color.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  section: { marginTop: space.lg },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: space.sm,
  },
  sectionTitle: { ...type.bodyBold, color: color.textMuted, flexShrink: 1 },
  field: { flexDirection: 'row', justifyContent: 'space-between', marginTop: space.xs },
  fieldLabel: { ...type.bodySm, color: color.textMuted, marginRight: space.md },
  fieldValue: { ...type.bodySm, color: color.text, flexShrink: 1, textAlign: 'right' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
});
