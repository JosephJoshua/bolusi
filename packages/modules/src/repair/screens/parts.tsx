// Small pieces every repair screen shares: a verified photo thumbnail, the ticket status chip, the
// flow step screen and the price rows. The read states and sections every module shares are in
// screen-kit/screens.
import { formatMoney, t } from '@bolusi/i18n';
import {
  AppShell,
  Banner,
  Button,
  Chip,
  Fact,
  FactGrid,
  Icon,
  LoadingState,
  color,
  radius,
  size,
  space,
  type,
  useViewport,
  type IconName,
} from '@bolusi/ui';
import { Image } from 'expo-image';
import type { ReactNode } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import type { ThumbnailRef } from '../../screen-kit/index.js';
import { ActionErrorBanner, Section } from '../../screen-kit/screens/index.js';

import { tn, type RepairKey } from '../i18n.js';
import { SPEC_FACT_KEY, staleStepMessage, statusLabel } from '../labels.js';
import {
  balanceAfterDownPayment,
  statusTone,
  type StaleStep,
  type TicketStatus,
} from '../flows.js';
import type { DeviceModelPhoto } from '../device-models.js';
import { specFacts } from '../device-specs.js';
import { useCatalogModel } from '../model-picker.js';
import { useModelPhoto, useRepairThumbnail } from '../runtime.js';

// Shared with every module's phone screens.
export { ActionErrorBanner, QueryView, Section } from '../../screen-kit/screens/index.js';

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
            label={tn(SPEC_FACT_KEY[fact.key])}
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
  notice,
  onClearNotice,
  overlay,
  stale,
  scrollKey,
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
   * The ticket changed elsewhere and this step can no longer finish: said in the banner slot, and
   * the bottom action becomes the way back. Held back while the step's own command runs, since
   * that command changes the ticket too and the step closes as it lands: the runner clears `busy`
   * and the step's `onDone` closes it in the same batched update, so the notice never shows.
   */
  readonly stale?: StaleStep | null | undefined;
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
          <Banner
            variant="warning"
            message={staleStepMessage(staleNow)}
            testID={`${testID}.stale`}
          />
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

/** Moved to `@bolusi/ui`; re-exported so the repair screens keep importing it from here. */
export { Fact, FactGrid };

/**
 * Under a total: the down payment taken off it, then what the customer still pays, or what the
 * store gives back when the down payment was more. Nothing when no down payment was taken. `action`
 * sits beside the down payment, the one thing it changes.
 */
export function DownPaymentRows({
  total,
  downPayment,
  paidLabel = 'repair.price.downPayment',
  action,
  testID,
}: {
  readonly total: number;
  readonly downPayment: number | null;
  /** What the amount paid is called: the DP, or once the phone went home, all that was paid. */
  readonly paidLabel?: RepairKey;
  readonly action?: ReactNode;
  readonly testID: string;
}): React.JSX.Element | null {
  if (downPayment === null || downPayment === 0) return null;
  const balance = balanceAfterDownPayment(total, downPayment);
  return (
    <View style={styles.paidRows} testID={`${testID}.downPaymentRows`}>
      <View style={[repairStyles.row, styles.paidRow]}>
        <View style={styles.paidLabel}>
          <Text style={styles.paidText}>{tn(paidLabel)}</Text>
          {action}
        </View>
        <Text style={[styles.paidText, styles.amount]} testID={`${testID}.downPayment`}>
          {formatMoney(-downPayment)}
        </Text>
      </View>
      <View style={[repairStyles.row, styles.paidRow]}>
        <Text style={styles.balanceLabel}>
          {tn(balance.kind === 'due' ? 'repair.price.balance' : 'repair.price.refund')}
        </Text>
        <Text style={[styles.balanceValue, styles.amount]} testID={`${testID}.balance`}>
          {formatMoney(balance.amount)}
        </Text>
      </View>
    </View>
  );
}

/** Photos laid out in a wrapping grid. */
export function PhotoGrid({ children }: { readonly children: ReactNode }): React.JSX.Element {
  return <View style={styles.grid}>{children}</View>;
}

/**
 * One cell of a `PhotoGrid`: three to a row on a phone, four on a tablet, where three would make
 * each photo the size of a phone screen and push everything under them out of sight.
 */
export function usePhotoGridCell(): StyleProp<ViewStyle> {
  return useViewport().widthClass === 'compact' ? styles.gridCell : styles.gridCellWide;
}

export const repairStyles = StyleSheet.create({
  caption: { ...type.caption, color: color.textMuted, marginTop: space.xs },
  muted: { ...type.bodySm, color: color.textMuted },
  body: { ...type.body, color: color.text },
  heading: { ...type.heading, color: color.text },
  gap: { marginTop: space.md },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  /** The growing side of a `row`: wraps instead of pushing the amount beside it off screen. */
  rowText: { flexShrink: 1, marginRight: space.md },
  /** The amount side of a `row`: never shrinks, so "Rp" and its number stay on one line. */
  rowValue: { flexShrink: 0 },
  warning: { ...type.bodySm, color: color.warning },
});

const styles = StyleSheet.create({
  // Room below "Sisa bayar" too, so the next row does not read as part of the sum.
  paidRows: { marginBottom: space.sm },
  paidRow: { marginTop: space.sm, minHeight: space['2xl'] },
  paidLabel: { flexDirection: 'row', alignItems: 'center', flexShrink: 1, marginRight: space.md },
  paidText: { ...type.bodySm, color: color.text },
  balanceLabel: { ...type.bodyBold, color: color.text },
  balanceValue: { ...type.heading, color: color.text },
  amount: { fontVariant: ['tabular-nums'] },
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
  field: { flexDirection: 'row', justifyContent: 'space-between', marginTop: space.xs },
  fieldLabel: { ...type.bodySm, color: color.textMuted, marginRight: space.md },
  fieldValue: { ...type.bodySm, color: color.text, flexShrink: 1, textAlign: 'right' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  gridCell: { width: '31%' },
  gridCellWide: { width: '23%' },
});
