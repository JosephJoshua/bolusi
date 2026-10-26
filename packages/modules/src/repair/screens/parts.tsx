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

import { tn } from './i18n.js';
import { staleStepMessage, statusLabel } from './labels.js';
import { statusTone, type StaleStep, type TicketStatus } from '../flows.js';
import type { DeviceModelPhoto, DeviceModelRow } from '../device-models.js';
import { specFacts, type SpecFactKey } from '../device-specs.js';
import { useModelPhoto, useRepairQuery, useRepairThumbnail } from './runtime.js';

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
  full = false,
  testID,
}: {
  readonly photo: ThumbnailRef;
  /** Fill the parent and show the whole photo uncropped (the full-screen viewer). */
  readonly full?: boolean | undefined;
  readonly testID: string;
}): React.JSX.Element {
  const state = useRepairThumbnail(photo);
  const frame = full ? styles.full : styles.placeholder;
  switch (state.kind) {
    case 'ready':
      return (
        <Image
          source={{ uri: state.uri }}
          contentFit={full ? 'contain' : 'cover'}
          style={full ? styles.full : styles.thumb}
          testID={`${testID}.image`}
        />
      );
    case 'loading':
      return (
        <View style={frame} testID={`${testID}.loading`}>
          <LoadingState variant="spinner" />
        </View>
      );
    case 'unavailable':
      return (
        <View style={frame} testID={`${testID}.unavailable`}>
          <Icon name="pending" size={size.iconInline} color={color.textMuted} />
        </View>
      );
    case 'mismatch':
      return (
        <View style={frame} testID={`${testID}.mismatch`}>
          <Icon name="rejected" size={size.iconInline} color={color.danger} />
        </View>
      );
  }
}

/** The catalog model a brand and model name are, when the catalog surely has it (findDeviceModel). */
export function useCatalogModel(brand: string, model: string): DeviceModelRow | null {
  const query = useRepairQuery(
    async (rt) =>
      model.trim() === ''
        ? null
        : ((await rt.query('findDeviceModel', { brand: brand.trim(), model: model.trim() }))
            .rows[0] ?? null),
    `deviceModel:${brand.trim()}\u0000${model.trim()}`,
  );
  return query.status === 'ready' ? query.data : null;
}

/**
 * A catalog picture of a phone model, the whole phone shown uncropped. While it loads, or when there
 * is none (offline, not in the catalog), a plain phone glyph holds its place so rows do not jump.
 */
export function ModelPhoto({
  photo,
  large = false,
  testID,
}: {
  readonly photo: DeviceModelPhoto | null;
  /** The confirmation card's size; rows use the small one. */
  readonly large?: boolean;
  readonly testID: string;
}): React.JSX.Element {
  const uri = useModelPhoto(photo);
  const frame = large ? styles.modelLarge : styles.modelSmall;
  return uri === null ? (
    <View style={[frame, styles.modelEmpty]} testID={`${testID}.none`}>
      <Icon name="device" size={size.iconInline} color={color.textMuted} />
    </View>
  ) : (
    <Image source={{ uri }} contentFit="contain" style={frame} testID={`${testID}.image`} />
  );
}

/** The catalog picture of a ticket's phone, or nothing when the catalog has no picture of it. */
export function CatalogPhoto({
  brand,
  model,
  large = false,
  testID,
}: {
  readonly brand: string;
  readonly model: string;
  readonly large?: boolean;
  readonly testID: string;
}): React.JSX.Element | null {
  const found = useCatalogModel(brand, model);
  const uri = useModelPhoto(found?.photo ?? null);
  if (uri === null) return null;
  return (
    <Image
      source={{ uri }}
      contentFit="contain"
      style={large ? styles.modelLarge : styles.modelSmall}
      testID={`${testID}.image`}
    />
  );
}

const SPEC_LABEL = {
  memory: 'repair.spec.memory',
  screen: 'repair.spec.screen',
  chipset: 'repair.spec.chipset',
  battery: 'repair.spec.battery',
  port: 'repair.spec.port',
  sim: 'repair.spec.sim',
  cardSlot: 'repair.spec.cardSlot',
  os: 'repair.spec.os',
} as const satisfies Record<SpecFactKey, string>;

/**
 * The catalog's specs for a ticket's phone, as the viewer needs them (`specFacts`): memory
 * variants for everyone, the inside of the phone for someone who repairs it. Nothing when the
 * catalog does not know the model or has no specs for it.
 */
export function DeviceSpecs({
  brand,
  model,
  repairs,
  testID,
}: {
  readonly brand: string;
  readonly model: string;
  readonly repairs: boolean;
  readonly testID: string;
}): React.JSX.Element | null {
  const found = useCatalogModel(brand, model);
  const facts = found === null ? [] : specFacts(found.specs, repairs);
  if (facts.length === 0) return null;
  return (
    <Section title={tn('repair.spec.title')} testID={testID}>
      <FactGrid>
        {facts.map((fact) => (
          <Fact
            key={fact.key}
            label={tn(SPEC_LABEL[fact.key])}
            // GSMArena's "No" for a phone without a card slot.
            value={fact.value === 'No' ? tn('repair.spec.none') : fact.value}
            testID={`${testID}.${fact.key}`}
          />
        ))}
      </FactGrid>
    </Section>
  );
}

/** The chrome every full-screen repair step shares: the shell's sync chip and avatar. */
export interface RepairChrome {
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
  overlay,
  stale,
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
  /** The other answer to `question`, drawn beside the primary. */
  readonly secondary?:
    { readonly label: string; readonly onPress: () => void; readonly testID: string } | undefined;
  /** Already-localized question the bottom answers reply to. */
  readonly question?: string | undefined;
  readonly busy: boolean;
  readonly errorCode: string | null;
  readonly onClearError: () => void;
  readonly overlay?: ReactNode;
  /**
   * The ticket changed elsewhere and this step can no longer finish: said in the banner slot, and
   * the bottom action becomes the way back. Held back while the step's own command runs, since
   * that command changes the ticket too and the step closes as it lands: the runner clears `busy`
   * and the step's `onDone` closes it in the same batched update, so the notice never shows.
   */
  readonly stale?: StaleStep | null | undefined;
  readonly testID: string;
  readonly children: ReactNode;
}): React.JSX.Element {
  const staleNow = busy || stale === undefined ? null : stale;
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
      // user had scrolled to when they pressed the bottom action. The stale notice outranks a
      // refusal, since it says why the refusal happened.
      banner={
        staleNow !== null ? (
          <Banner
            variant="warning"
            message={staleStepMessage(staleNow)}
            testID={`${testID}.stale`}
          />
        ) : errorCode === null ? undefined : (
          <ActionErrorBanner
            errorCode={errorCode}
            onDismiss={onClearError}
            testID={`${testID}.error`}
          />
        )
      }
      bottomAction={
        staleNow !== null ? (
          <Button
            label={tn('repair.action.backToTicket')}
            onPress={onBack}
            testID={`${testID}.staleBack`}
          />
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
                    disabled={busy}
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
        {/* A TextButton's padding is hit area: its text lines up with the content's right edge. */}
        {action === undefined ? null : <View style={styles.sectionAction}>{action}</View>}
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

/**
 * A key fact on a detail screen: a small label over its value, laid out two to a row by `FactGrid`.
 * The value can carry the one action that changes it ("Ganti" beside the technician). A `wide` fact
 * takes the whole row, for a value with an action and something drawn under it.
 */
export function Fact({
  label,
  value,
  action,
  wide = false,
  children,
  testID,
}: {
  readonly label: string;
  readonly value: string;
  readonly action?: ReactNode;
  readonly wide?: boolean | undefined;
  readonly children?: ReactNode;
  readonly testID?: string | undefined;
}): React.JSX.Element {
  return (
    <View style={[styles.fact, wide ? styles.factWide : null]}>
      <Text style={styles.factLabel}>{label}</Text>
      <View style={styles.factValueRow}>
        <Text style={styles.factValue} testID={testID}>
          {value}
        </Text>
        {action}
      </View>
      {children}
    </View>
  );
}

export function FactGrid({ children }: { readonly children: ReactNode }): React.JSX.Element {
  return <View style={styles.factGrid}>{children}</View>;
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
  inert: { opacity: 0.45 },
  question: { ...type.bodyBold, color: color.text, marginBottom: space.md, textAlign: 'center' },
  answers: { flexDirection: 'row', gap: space.md },
  answer: { flex: 1 },
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
  full: { width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' },
  // GSMArena's pictures are 160×212 portraits on white, so the frames keep that shape.
  modelSmall: { width: 30, height: 40 },
  modelLarge: { width: 60, height: 80 },
  modelEmpty: {
    borderRadius: radius.sm,
    backgroundColor: color.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
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
  factGrid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: space.md },
  fact: { width: '50%', paddingRight: space.sm },
  factWide: { width: '100%' },
  factLabel: { ...type.caption, color: color.textMuted },
  factValueRow: { flexDirection: 'row', alignItems: 'center', minHeight: size.control },
  factValue: { ...type.bodySm, fontWeight: '600', color: color.text, flexShrink: 1 },
  field: { flexDirection: 'row', justifyContent: 'space-between', marginTop: space.xs },
  fieldLabel: { ...type.bodySm, color: color.textMuted, marginRight: space.md },
  fieldValue: { ...type.bodySm, color: color.text, flexShrink: 1, textAlign: 'right' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
});
