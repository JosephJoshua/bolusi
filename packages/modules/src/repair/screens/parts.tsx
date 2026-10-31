// Small pieces every repair screen shares: a verified photo thumbnail, the ticket status chip, the
// repair flow step, and the shared read-state and banner pieces (screen-kit) re-exported.
import { formatMoney } from '@bolusi/i18n';
import {
  Chip,
  Fact,
  FactGrid,
  Icon,
  LoadingState,
  RollingText,
  color,
  radius,
  size,
  space,
  type,
  useViewport,
  type IconName,
  Text,
} from '@bolusi/ui';
import { Image } from 'expo-image';
import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import type { ThumbnailRef } from '../../screen-kit/index.js';
import {
  ActionErrorBanner,
  FlowScreen as BaseFlowScreen,
  QueryView,
  Section,
  type ScreenChrome,
} from '../../screen-kit/screens/views.js';

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

/** Shared with every module's screens; re-exported so the repair screens keep importing them here. */
export { ActionErrorBanner, QueryView, Section };

/** The chrome every full-screen repair step shares: the shell's sync chip and avatar. */
export type RepairChrome = ScreenChrome;

/**
 * A full-screen repair step (screen-kit `FlowScreen`). A ticket that changed elsewhere while the
 * step was open says how, and its way back is "back to the servisan".
 */
export function FlowScreen({
  stale,
  ...props
}: Omit<Parameters<typeof BaseFlowScreen>[0], 'stale'> & {
  readonly stale?: StaleStep | null | undefined;
}): React.JSX.Element {
  return (
    <BaseFlowScreen
      {...props}
      stale={
        stale === undefined || stale === null
          ? stale
          : { message: staleStepMessage(stale), backLabel: tn('repair.action.backToTicket') }
      }
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
 * Under a total: what an owner took off it, the down payment taken off it, then what the customer
 * still pays, or what the store gives back when they paid more. Nothing when neither was taken.
 * `total` is what is owed, already less `reduced`. `action` sits beside the down payment, the one
 * thing it changes.
 */
export function DownPaymentRows({
  total,
  downPayment,
  reduced = 0,
  paidLabel = 'repair.price.downPayment',
  action,
  typing = false,
  testID,
}: {
  readonly total: number;
  readonly downPayment: number | null;
  readonly reduced?: number | undefined;
  /** What the amount paid is called: the DP, or once the phone went home, all that was paid. */
  readonly paidLabel?: RepairKey;
  readonly action?: ReactNode;
  /** The figures follow a DP being typed just above, so they change without rolling. */
  readonly typing?: boolean;
  readonly testID: string;
}): React.JSX.Element | null {
  const paid = downPayment ?? 0;
  if (paid === 0 && reduced === 0) return null;
  const balance = balanceAfterDownPayment(total, paid);
  // Before pickup an overpaid DP goes back at the handover; after it, it is still owed back.
  const owedBackLabel: RepairKey =
    paidLabel === 'repair.price.paid' ? 'repair.price.owedBack' : 'repair.price.refund';
  return (
    <View style={styles.paidRows} testID={`${testID}.downPaymentRows`}>
      {reduced === 0 ? null : (
        <View style={[repairStyles.row, styles.paidRow]}>
          <Text style={styles.paidText}>{tn('repair.price.reduced')}</Text>
          <Text style={[styles.paidText, styles.amount]} testID={`${testID}.reduced`}>
            {formatMoney(-reduced)}
          </Text>
        </View>
      )}
      {paid === 0 ? null : (
        <View style={[repairStyles.row, styles.paidRow]}>
          <View style={styles.paidLabel}>
            <Text style={styles.paidText}>{tn(paidLabel)}</Text>
            {action}
          </View>
          <RollingText
            value={paid}
            still={typing}
            style={[styles.paidText, styles.amount]}
            testID={`${testID}.downPayment`}
          >
            {formatMoney(-paid)}
          </RollingText>
        </View>
      )}
      <View style={[repairStyles.row, styles.paidRow]}>
        <Text style={styles.balanceLabel}>
          {tn(balance.kind === 'due' ? 'repair.price.balance' : owedBackLabel)}
        </Text>
        <RollingText
          value={balance.kind === 'due' ? balance.amount : -balance.amount}
          still={typing}
          style={[styles.balanceValue, styles.amount]}
          testID={`${testID}.balance`}
        >
          {formatMoney(balance.amount)}
        </RollingText>
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
  /** Choice chips that wrap, where a whole screen holds them (not a strip in a long form). */
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
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
