/**
 * Parts on a use (a servisan): the section on its page, the step that takes a part off the shelf
 * for it, and the step that puts an unused one back. The customer never sees these: parts used are
 * the store's own record, not lines on the bill (owner decision, 2026-10-28).
 *
 * Whether the user may take or put back now is the owning module's call (the servisan screen knows
 * its state); the stock rules check it again on save and on the server.
 */
import { t } from '@bolusi/i18n';
import {
  AmountRow,
  border,
  color,
  Icon,
  numeric,
  QuantityStepper,
  radius,
  SearchField,
  size,
  space,
  Text,
  TextButton,
  touch,
  type,
  useRevealOnMount,
  ValueText,
} from '@bolusi/ui';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import {
  FlowScreen,
  QueryView,
  Section,
  type ScreenChrome,
} from '../../screen-kit/screens/views.js';
import { MAX_MOVEMENT_QTY } from '../constants.js';
import { stockText } from '../labels.js';
import { ti } from '../i18n.js';
import type { ItemRow, UsedPartRow } from '../queries.js';
import { useInventoryRuntime } from '../runtime.js';
import {
  moreHint,
  overStockHint,
  usePutBack,
  useTakePart,
  useUseCost,
  useUsedParts,
  type PartUse,
} from '../take-part.js';

export type { PartUse };

export interface UsedPartsSectionProps {
  readonly use: PartUse;
  /** The user may put back parts taken for this use now. */
  readonly editable: boolean;
  /** The user may take a new part for this use now (not once a servisan is cancelled). */
  readonly takeable: boolean;
  /** The use is closed without its work (a cancelled servisan): parts still out are flagged. */
  readonly flagUnreturned: boolean;
  readonly onTake: () => void;
  readonly onPutBack: (part: UsedPartRow) => void;
  readonly testID?: string | undefined;
}

export function UsedPartsSection({
  use,
  editable,
  takeable,
  flagUnreturned,
  onTake,
  onPutBack,
  testID = 'inventory.used',
}: UsedPartsSectionProps): React.JSX.Element | null {
  const { query, parts, hidden, retry } = useUsedParts(use, takeable);
  if (hidden) return null;
  return (
    <>
      <Section
        title={ti('inventory.use.title')}
        action={
          takeable ? (
            <TextButton
              label={ti('inventory.use.take')}
              accessibilityLabel={ti('inventory.use.takeTitle')}
              onPress={onTake}
              testID={`${testID}.take`}
            />
          ) : undefined
        }
        testID={testID}
      >
        <QueryView query={query} onBack={() => undefined} onRetry={retry} testID={testID}>
          {() =>
            parts.length === 0 ? (
              <Text style={styles.muted}>{ti('inventory.use.none')}</Text>
            ) : (
              <View>
                {parts.map((part) => (
                  <View
                    key={part.itemId}
                    style={styles.usedRow}
                    testID={`${testID}.part.${part.itemId}`}
                  >
                    <View style={styles.usedText}>
                      <Text style={styles.name}>{part.name}</Text>
                      <Text style={styles.muted}>
                        {ti('inventory.use.out', { count: part.out })}
                      </Text>
                      {flagUnreturned ? (
                        <View style={styles.flag}>
                          <Icon name="warning" size={size.iconChip} color={color.warning} />
                          <Text style={styles.flagText}>{ti('inventory.use.notReturned')}</Text>
                        </View>
                      ) : null}
                    </View>
                    {editable ? (
                      <TextButton
                        label={ti('inventory.use.putBack')}
                        accessibilityLabel={`${ti('inventory.use.putBack')} ${part.name}`}
                        onPress={() => onPutBack(part)}
                        testID={`${testID}.putBack.${part.itemId}`}
                      />
                    ) : null}
                  </View>
                ))}
              </View>
            )
          }
        </QueryView>
      </Section>
      {parts.length === 0 ? null : <UseCostSection use={use} testID={`${testID}.cost`} />}
    </>
  );
}

/** What the parts on a use cost the store, for people who may see buy prices. */
function UseCostSection({
  use,
  testID,
}: {
  readonly use: PartUse;
  readonly testID: string;
}): React.JSX.Element | null {
  const { shown, query, total, unpriced, retry } = useUseCost(use);
  if (!shown) return null;
  return (
    <Section title={ti('inventory.useCost.title')} testID={testID}>
      <QueryView query={query} onBack={() => undefined} onRetry={retry} testID={testID}>
        {(rows) => (
          <View>
            {rows.map((row) => (
              <AmountRow
                key={row.itemId}
                label={row.name}
                detail={ti('inventory.useCost.line', { count: row.out })}
                value={row.cost ?? ti('inventory.useCost.missing')}
                tone={row.cost === null ? 'muted' : 'text'}
                testID={`${testID}.${row.itemId}`}
              />
            ))}
            {rows.length > 1 && unpriced === 0 ? (
              <AmountRow
                label={ti('inventory.useCost.total')}
                value={total}
                strong
                testID={`${testID}.total`}
              />
            ) : null}
            {unpriced === 0 ? null : (
              <Text style={styles.costWarning} testID={`${testID}.unpriced`}>
                {ti('inventory.useCost.unpriced', { count: unpriced })}
              </Text>
            )}
          </View>
        )}
      </QueryView>
    </Section>
  );
}

export interface TakePartStepProps {
  readonly chrome: ScreenChrome;
  readonly use: PartUse;
  /** The phone being repaired: parts that fit it are offered first, before anything is typed. */
  readonly device?: { readonly brand: string; readonly model: string } | undefined;
  readonly onDone: () => void;
  readonly onCancel: () => void;
  readonly testID?: string | undefined;
}

/** Pick a part, say how many, take it. Stock may go below zero; the owner sees it flagged. */
export function TakePartStep({
  chrome,
  use,
  device,
  onDone,
  onCancel,
  testID = 'inventory.take',
}: TakePartStepProps): React.JSX.Element {
  const runtime = useInventoryRuntime();
  const {
    text,
    setText,
    searchText,
    query,
    retry,
    picked,
    pick,
    qty,
    setQty,
    pickCode,
    take,
    runner,
  } = useTakePart(use, device, onDone);

  // How many is asked right under the picked row, where the finger is: a stepper at the top of a
  // long list is out of sight, and the part would be taken as one. The row already says its stock.
  const qtyStepper = (part: ItemRow, showStock: boolean): React.JSX.Element => (
    <QuantityStepper
      label={ti('inventory.use.qty')}
      value={qty}
      onChange={setQty}
      min={1}
      max={MAX_MOVEMENT_QTY}
      decreaseLabel={ti('inventory.stepper.decrease')}
      increaseLabel={ti('inventory.stepper.increase')}
      caption={
        overStockHint(part, qty) ??
        (showStock ? ti('inventory.list.stockCount', { count: stockText(part.onHand) }) : undefined)
      }
      testID={`${testID}.qty`}
    />
  );

  const choice = (row: ItemRow): React.JSX.Element => {
    const selected = picked?.id === row.id;
    return (
      <View key={row.id}>
        <Pressable
          accessibilityRole="radio"
          accessibilityState={{ selected }}
          accessibilityLabel={`${row.name}, ${ti('inventory.list.stockCount', { count: stockText(row.onHand) })}`}
          onPress={() => pick(row)}
          style={({ pressed }) => [
            styles.choice,
            selected ? styles.choiceSelected : null,
            pressed ? styles.choicePressed : null,
          ]}
          testID={`${testID}.choice.${row.id}`}
        >
          <View style={styles.usedText}>
            <Text style={styles.name}>{row.name}</Text>
            {row.fits === null ? null : (
              <ValueText lines={1} style={styles.muted}>
                {row.fits}
              </ValueText>
            )}
          </View>
          <Text style={[styles.stock, row.onHand < 0 ? styles.stockOut : null]}>
            {ti('inventory.list.stockCount', { count: stockText(row.onHand) })}
          </Text>
          {selected ? <Icon name="check" size={size.iconInline} color={color.primary} /> : null}
        </Pressable>
        {selected ? <Revealed style={styles.inlineQty}>{qtyStepper(row, false)}</Revealed> : null}
      </View>
    );
  };
  // While a search loads, no list shows either: the stepper waits for it rather than jumping.
  const listed =
    query.status !== 'ready' ||
    [...query.data.fitting, ...query.data.rest].some((row) => row.id === picked?.id);

  /** A scanned code picks its part when it names exactly one; otherwise it is searched for. */
  const scan = async (): Promise<void> => {
    const code = (await runtime.scanCode?.())?.trim() ?? '';
    if (code === '') return;
    setText(code);
    await pickCode(code);
  };

  return (
    <FlowScreen
      chrome={chrome}
      title={ti('inventory.use.takeTitle')}
      onBack={onCancel}
      primaryLabel={ti('inventory.use.takeAction')}
      onPrimary={take}
      primaryDisabled={picked === null}
      primaryHint={ti('inventory.use.pickFirst')}
      busy={runner.busy}
      errorCode={runner.errorCode}
      onClearError={runner.clearError}
      testID={testID}
    >
      {/* A new search can leave the picked part out of the list: it is named here then. */}
      {picked === null || listed ? null : (
        <View style={styles.picked} testID={`${testID}.picked`}>
          <Text style={styles.pickedName}>{picked.name}</Text>
          {qtyStepper(picked, true)}
        </View>
      )}
      <SearchField
        placeholder={ti('inventory.use.searchHint')}
        accessibilityLabel={t('core.action.search')}
        clearLabel={ti('inventory.list.clearSearch')}
        value={text}
        onChangeText={setText}
        testID={`${testID}.search`}
      />
      {runtime.scanCode === undefined ? null : (
        <View style={styles.scan}>
          <TextButton
            label={ti('inventory.list.scan')}
            icon="scan"
            onPress={() => void scan()}
            testID={`${testID}.scan`}
          />
        </View>
      )}
      <QueryView query={query} onBack={onCancel} onRetry={retry} testID={testID}>
        {({ fitting, rest }) =>
          fitting.length === 0 && rest.length === 0 ? (
            <Text style={[styles.muted, styles.empty]}>
              {searchText === '' ? ti('inventory.list.emptyHint') : ti('inventory.list.noMatches')}
            </Text>
          ) : (
            <View>
              {fitting.length === 0 || device === undefined ? null : (
                <>
                  <Text style={styles.group} testID={`${testID}.fitting`}>
                    {ti('inventory.use.fitsDevice', {
                      model: `${device.brand} ${device.model}`.trim(),
                    })}
                  </Text>
                  <View style={styles.choices}>{fitting.map(choice)}</View>
                  {rest.length === 0 ? null : (
                    <Text style={styles.group}>{ti('inventory.use.otherParts')}</Text>
                  )}
                </>
              )}
              <View style={styles.choices}>{rest.map(choice)}</View>
              {moreHint({ fitting, rest }) === null ? null : (
                <Text style={[styles.muted, styles.more]} testID={`${testID}.more`}>
                  {moreHint({ fitting, rest })}
                </Text>
              )}
            </View>
          )
        }
      </QueryView>
    </FlowScreen>
  );
}

/** Brought into sight as it appears, so it never opens behind the bottom action. */
function Revealed({
  style,
  children,
}: {
  readonly style: StyleProp<ViewStyle>;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  const { anchorRef, onLayout } = useRevealOnMount();
  return (
    <View ref={anchorRef} style={style} onLayout={onLayout}>
      {children}
    </View>
  );
}

export interface PutBackStepProps {
  readonly chrome: ScreenChrome;
  readonly use: PartUse;
  readonly part: UsedPartRow;
  readonly onDone: () => void;
  readonly onCancel: () => void;
  readonly testID?: string | undefined;
}

/** Put unused parts back on the shelf: at most what this use took. */
export function PutBackStep({
  chrome,
  use,
  part,
  onDone,
  onCancel,
  testID = 'inventory.putBack',
}: PutBackStepProps): React.JSX.Element {
  const { qty, setQty, putBack, runner } = usePutBack(use, part, onDone);
  return (
    <FlowScreen
      chrome={chrome}
      title={ti('inventory.use.putBackTitle')}
      onBack={onCancel}
      primaryLabel={ti('inventory.use.putBackAction')}
      onPrimary={putBack}
      busy={runner.busy}
      errorCode={runner.errorCode}
      onClearError={runner.clearError}
      testID={testID}
    >
      <Text style={styles.pickedName}>{part.name}</Text>
      <Text style={[styles.muted, styles.message]}>
        {ti('inventory.use.putBackMessage', { name: part.name })}
      </Text>
      {part.out > 1 ? (
        <QuantityStepper
          label={ti('inventory.use.qty')}
          value={qty}
          onChange={setQty}
          min={1}
          max={part.out}
          decreaseLabel={ti('inventory.stepper.decrease')}
          increaseLabel={ti('inventory.stepper.increase')}
          caption={ti('inventory.use.out', { count: part.out })}
          testID={`${testID}.qty`}
        />
      ) : null}
    </FlowScreen>
  );
}

const styles = StyleSheet.create({
  // A text button lines its text up with the search field's edge, not its hit box.
  scan: { flexDirection: 'row', marginTop: space.xs, marginLeft: -space.sm },
  muted: { ...type.bodySm, color: color.textMuted },
  costWarning: { ...type.bodySm, color: color.warning, marginTop: space.sm },
  empty: { marginTop: space.lg },
  name: { ...type.bodySm, fontWeight: '600', color: color.text },
  usedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.sm,
    borderBottomWidth: border.hairline,
    borderBottomColor: color.border,
  },
  usedText: { flex: 1 },
  flag: { flexDirection: 'row', alignItems: 'center', gap: space.xs, marginTop: space.xs },
  flagText: { ...type.caption, color: color.warning, flexShrink: 1 },
  picked: { marginBottom: space.xl, gap: space.md },
  inlineQty: { paddingTop: space.sm, paddingBottom: space.md },
  more: { marginTop: space.md, textAlign: 'center' },
  pickedName: { ...type.heading, color: color.text },
  message: { marginTop: space.xs, marginBottom: space.lg },
  group: { ...type.caption, fontWeight: '600', color: color.textMuted, marginTop: space.md },
  choices: { marginTop: space.md },
  choice: {
    minHeight: touch.rowMin,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    marginHorizontal: -space.md,
    borderRadius: radius.sm,
  },
  choiceSelected: { backgroundColor: color.surfaceAlt },
  choicePressed: { backgroundColor: color.surfaceAlt },
  stock: { ...type.bodySm, color: color.textMuted, ...numeric },
  stockOut: { color: color.danger },
});
