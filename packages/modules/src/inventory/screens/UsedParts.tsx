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
  Icon,
  QuantityStepper,
  SearchField,
  TextButton,
  border,
  color,
  radius,
  size,
  space,
  touch,
  type,
} from '@bolusi/ui';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useActionRunner, useSettledValue } from '../../screen-kit/index.js';
import {
  FlowScreen,
  QueryView,
  Section,
  type ScreenChrome,
} from '../../screen-kit/screens/views.js';
import { MAX_MOVEMENT_QTY, type PartUseKind } from '../constants.js';
import { stockText } from '../labels.js';
import { ti } from '../i18n.js';
import type { PartRow, UsedPartRow } from '../queries.js';
import { useInventoryQuery, useInventoryRuntime } from '../runtime.js';

/** What the parts are for, as the stock rules record it. */
export interface PartUse {
  readonly kind: PartUseKind;
  readonly id: string;
  /** How it reads in stock history: the servisan number. */
  readonly label: string;
}

/** How many parts the take step lists before the user narrows it with search. */
const PICK_LIMIT = 30;

export interface UsedPartsSectionProps {
  readonly use: PartUse;
  /** The user may take and put back parts on this use now. */
  readonly editable: boolean;
  /** The use is closed without its work (a cancelled servisan): parts still out are flagged. */
  readonly flagUnreturned: boolean;
  readonly onTake: () => void;
  readonly onPutBack: (part: UsedPartRow) => void;
  readonly testID?: string | undefined;
}

export function UsedPartsSection({
  use,
  editable,
  flagUnreturned,
  onTake,
  onPutBack,
  testID = 'inventory.used',
}: UsedPartsSectionProps): React.JSX.Element | null {
  const query = useInventoryQuery(
    async (rt) => (await rt.query('partsForUse', { useKind: use.kind, useId: use.id })).rows[0],
    `used:${use.kind}:${use.id}`,
  );
  // A put-back to zero leaves the part's history, not a row reading "0 dipakai".
  const parts = query.status === 'ready' ? (query.data?.parts ?? []).filter((p) => p.out > 0) : [];
  if (query.status === 'ready' && parts.length === 0 && !editable) return null;
  return (
    <Section
      title={ti('inventory.use.title')}
      action={
        editable ? (
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
      <QueryView query={query} onBack={() => undefined} onRetry={() => undefined} testID={testID}>
        {() =>
          parts.length === 0 ? (
            <Text style={styles.muted}>{ti('inventory.use.none')}</Text>
          ) : (
            <View>
              {parts.map((part) => (
                <View
                  key={part.partId}
                  style={styles.usedRow}
                  testID={`${testID}.part.${part.partId}`}
                >
                  <View style={styles.usedText}>
                    <Text style={styles.name}>{part.name}</Text>
                    <Text style={styles.muted}>{ti('inventory.use.out', { count: part.out })}</Text>
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
                      testID={`${testID}.putBack.${part.partId}`}
                    />
                  ) : null}
                </View>
              ))}
            </View>
          )
        }
      </QueryView>
    </Section>
  );
}

export interface TakePartStepProps {
  readonly chrome: ScreenChrome;
  readonly use: PartUse;
  readonly onDone: () => void;
  readonly onCancel: () => void;
  readonly testID?: string | undefined;
}

/** Pick a part, say how many, take it. Stock may go below zero; the owner sees it flagged. */
export function TakePartStep({
  chrome,
  use,
  onDone,
  onCancel,
  testID = 'inventory.take',
}: TakePartStepProps): React.JSX.Element {
  const runtime = useInventoryRuntime();
  const runner = useActionRunner();
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<PartRow | null>(null);
  const [qty, setQty] = useState(1);
  const typed = text.trim();
  const settled = useSettledValue(typed);
  const searchText = typed === '' ? '' : settled;
  const query = useInventoryQuery(
    async (rt) =>
      (await rt.query('listParts', { text: searchText, filter: 'active', limit: PICK_LIMIT })).rows,
    `take:${searchText}`,
  );

  const take = (): void => {
    if (picked === null) return;
    void runner
      .run(() => runtime.run('takePart', { partId: picked.id, qty, use }))
      .then((result) => {
        if (result !== undefined) onDone();
      });
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
      {picked === null ? null : (
        <View style={styles.picked} testID={`${testID}.picked`}>
          <Text style={styles.pickedName}>{picked.name}</Text>
          <QuantityStepper
            label={ti('inventory.use.qty')}
            value={qty}
            onChange={setQty}
            min={1}
            max={MAX_MOVEMENT_QTY}
            decreaseLabel={ti('inventory.stepper.decrease')}
            increaseLabel={ti('inventory.stepper.increase')}
            caption={ti('inventory.list.stockCount', { count: stockText(picked.onHand) })}
            testID={`${testID}.qty`}
          />
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
      <QueryView query={query} onBack={onCancel} onRetry={() => setText((s) => s)} testID={testID}>
        {(rows) =>
          rows.length === 0 ? (
            <Text style={[styles.muted, styles.empty]}>
              {searchText === '' ? ti('inventory.list.emptyHint') : ti('inventory.list.noMatches')}
            </Text>
          ) : (
            <View style={styles.choices}>
              {rows.map((row) => {
                const selected = picked?.id === row.id;
                return (
                  <Pressable
                    key={row.id}
                    accessibilityRole="radio"
                    accessibilityState={{ selected }}
                    accessibilityLabel={`${row.name}, ${ti('inventory.list.stockCount', { count: stockText(row.onHand) })}`}
                    onPress={() => {
                      setPicked(row);
                      setQty(1);
                    }}
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
                        <Text style={styles.muted} numberOfLines={1}>
                          {row.fits}
                        </Text>
                      )}
                    </View>
                    <Text style={[styles.stock, row.onHand < 0 ? styles.stockOut : null]}>
                      {ti('inventory.list.stockCount', { count: stockText(row.onHand) })}
                    </Text>
                    {selected ? (
                      <Icon name="check" size={size.iconInline} color={color.primary} />
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
          )
        }
      </QueryView>
    </FlowScreen>
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
  const runtime = useInventoryRuntime();
  const runner = useActionRunner();
  const [qty, setQty] = useState(1);
  const putBack = (): void => {
    void runner
      .run(() => runtime.run('putBackPart', { partId: part.partId, qty, use }))
      .then((result) => {
        if (result !== undefined) onDone();
      });
  };
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
  muted: { ...type.bodySm, color: color.textMuted },
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
  pickedName: { ...type.heading, color: color.text },
  message: { marginTop: space.xs, marginBottom: space.lg },
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
  stock: { ...type.bodySm, color: color.textMuted, fontVariant: ['tabular-nums'] },
  stockOut: { color: color.danger },
});
