/**
 * PriceForm — add a row to the price list, change one, or copy one to more phones. A row is a repair
 * type, the phones it covers (picked from the intake's phone catalog), an optional quality such as
 * "Ori" or "KW", and the price. "Simpan & tambah lagi" keeps the repair and the phones for the next
 * quality of a run. A store owner also sets what their store charges instead; one who cannot change
 * the list sees its row as facts and sets only that.
 */
import { formatMoney } from '@bolusi/i18n';
import {
  ChipRow,
  ConfirmSheet,
  Fact,
  SwitchRow,
  Text,
  TextButton,
  TextInput,
  ToggleChip,
  color,
  space,
  type,
} from '@bolusi/ui';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import type { DiscardGuard } from '../../screen-kit/index.js';
import { useDiscardConfirm } from '../../screen-kit/screens/discard.js';
import { FlowScreen, type ScreenChrome } from '../../screen-kit/screens/views.js';
import { ModelsField } from '../../inventory/screens/ModelsField.js';
import { acceptsRupiahText, groupedRupiah, parseRupiah } from '../../shared/rupiah.js';
import { MAX_LINE_AMOUNT } from '../constants.js';
import { tn } from '../i18n.js';
import { MAX_PRICE_QUALITY } from '../operations.js';
import {
  priceModelsText,
  priceProblemText,
  priceTitle,
  priceTypeLabel,
  sameQuality,
  usePriceForm,
  usePriceQualities,
  usePriceTypes,
  useRepairCatalog,
  type PriceStart,
} from '../price-list.js';
import type { PriceRow } from '../prices.queries.js';

export interface PriceFormProps {
  readonly chrome: ScreenChrome;
  readonly start: PriceStart;
  /** Saved; the title of the row saved, for the list's notice. */
  readonly onDone: (saved: string) => void;
  readonly onRemoved: () => void;
  /** Start a new row from this one, for other phones. */
  readonly onCopy: (row: PriceRow) => void;
  readonly onCancel: () => void;
  readonly onRegisterDiscardGuard?: ((guard: DiscardGuard | null) => void) | undefined;
  readonly testID?: string | undefined;
}

const amountText = (amount: number): string => (amount === 0 ? '' : groupedRupiah(String(amount)));

export function PriceForm({
  chrome,
  start,
  onDone,
  onRemoved,
  onCopy,
  onCancel,
  onRegisterDiscardGuard,
  testID = 'repair.priceForm',
}: PriceFormProps): React.JSX.Element {
  const types = usePriceTypes('business');
  const form = usePriceForm(start, types);
  const { draft, set, row, abilities, problems, runner } = form;
  const qualities = usePriceQualities();
  const catalog = useRepairCatalog();
  const [notice, setNotice] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const adding = row === null;
  const listEditable = abilities.edit;

  const discard = useDiscardConfirm({
    dirty: form.dirty,
    copy: {
      title: tn('repair.prices.discard.title'),
      message: tn('repair.prices.discard.message'),
      confirm: tn('repair.prices.discard.confirm'),
      keep: tn('repair.prices.discard.keep'),
    },
    onRegisterDiscardGuard,
    testID,
  });

  const save = (another = false): void => {
    setNotice(null);
    void form.save(another).then((saved) => {
      if (saved === undefined) return;
      if (another) setNotice(tn('repair.prices.savedAnother', { price: saved }));
      else onDone(saved);
    });
  };

  const problem = (key: Parameters<typeof priceProblemText>[0]): string | undefined =>
    problems.has(key) ? priceProblemText(key, form.repeated) : undefined;
  const qualityChoices = qualities.filter((q) => !sameQuality(q, draft.quality)).slice(0, 12);
  const typeLabel = priceTypeLabel(types, draft.repairType);

  return (
    <FlowScreen
      chrome={chrome}
      title={tn(
        adding
          ? start.kind === 'copy'
            ? 'repair.prices.copyTitle'
            : 'repair.prices.addTitle'
          : 'repair.prices.editTitle',
      )}
      onBack={() => discard.requestLeave(onCancel)}
      primaryLabel={tn('repair.prices.save')}
      onPrimary={() => save()}
      secondary={
        adding
          ? {
              label: tn('repair.prices.saveAnother'),
              onPress: () => save(true),
              disabled: runner.busy,
              testID: `${testID}.another`,
            }
          : undefined
      }
      notice={notice}
      onClearNotice={() => setNotice(null)}
      busy={runner.busy}
      errorCode={runner.errorCode}
      onClearError={runner.clearError}
      overlay={
        removing ? (
          <ConfirmSheet
            title={tn('repair.prices.remove.title')}
            message={tn('repair.prices.remove.message')}
            confirmLabel={tn('repair.prices.remove.confirm')}
            cancelLabel={tn('repair.prices.discard.keep')}
            onConfirm={() => {
              setRemoving(false);
              void form.remove().then((done) => {
                if (done) onRemoved();
              });
            }}
            onCancel={() => setRemoving(false)}
            testID={`${testID}.removeConfirm`}
          />
        ) : (
          discard.overlay
        )
      }
      testID={testID}
    >
      <View style={styles.fields}>
        {listEditable ? (
          <>
            <View>
              <Text style={styles.label}>{tn('repair.prices.repairType')}</Text>
              <ChipRow testID={`${testID}.type`}>
                {(types ?? []).map((type) => (
                  <ToggleChip
                    key={type.id}
                    label={type.label}
                    selected={type.id === draft.repairType}
                    onToggle={() => set({ repairType: type.id })}
                    testID={`${testID}.type.${type.id}`}
                  />
                ))}
              </ChipRow>
              {problem('repairType') === undefined ? null : (
                <Text style={styles.error}>{problem('repairType')}</Text>
              )}
            </View>
            <View>
              <ModelsField
                label={tn('repair.prices.models')}
                value={draft.models}
                onChange={(models) => set({ models })}
                catalog={catalog}
                testID={`${testID}.models`}
              />
              {(problem('models') ?? problem('repeated')) === undefined ? null : (
                <Text style={styles.error} testID={`${testID}.modelsProblem`}>
                  {problem('models') ?? problem('repeated')}
                </Text>
              )}
            </View>
            <View>
              <TextInput
                label={tn('repair.prices.quality')}
                placeholder={tn('repair.prices.qualityPlaceholder')}
                value={draft.quality}
                onChangeText={(quality) => set({ quality })}
                maxLength={MAX_PRICE_QUALITY}
                autoCorrect={false}
                testID={`${testID}.quality`}
              />
              {qualityChoices.length === 0 ? null : (
                <View style={styles.choices}>
                  <ChipRow testID={`${testID}.qualities`}>
                    {qualityChoices.map((quality) => (
                      <ToggleChip
                        key={quality}
                        label={quality}
                        selected={false}
                        onToggle={() => set({ quality })}
                        testID={`${testID}.quality.${quality}`}
                      />
                    ))}
                  </ChipRow>
                </View>
              )}
            </View>
            <TextInput
              label={tn('repair.prices.amount')}
              placeholder="0"
              value={amountText(draft.amount)}
              onChangeText={(text) => {
                if (acceptsRupiahText(text, MAX_LINE_AMOUNT)) {
                  set({ amount: parseRupiah(text, MAX_LINE_AMOUNT) ?? 0 });
                }
              }}
              keyboardType="number-pad"
              selectTextOnFocus
              errorMessage={problem('amount')}
              testID={`${testID}.amount`}
            />
          </>
        ) : row === null ? null : (
          <View style={styles.facts}>
            <Fact
              label={tn('repair.prices.repairType')}
              value={priceTitle(typeLabel, row.quality)}
            />
            <Fact label={tn('repair.prices.models')} value={priceModelsText(row.models)} wide />
            <Fact label={tn('repair.prices.listAmount')} value={formatMoney(row.listAmount)} />
          </View>
        )}
        {abilities.store && (row !== null || listEditable) ? (
          <View testID={`${testID}.store`}>
            <SwitchRow
              label={tn('repair.prices.storeOwn')}
              caption={tn('repair.prices.storeOwnCaption')}
              value={draft.storeAmount !== null}
              onValueChange={(on) => set({ storeAmount: on ? draft.amount : null })}
              testID={`${testID}.storeOwn`}
            />
            {draft.storeAmount === null ? null : (
              <View style={styles.storeAmount}>
                <TextInput
                  label={tn('repair.prices.storeAmount')}
                  placeholder="0"
                  value={amountText(draft.storeAmount)}
                  onChangeText={(text) => {
                    if (acceptsRupiahText(text, MAX_LINE_AMOUNT)) {
                      set({ storeAmount: parseRupiah(text, MAX_LINE_AMOUNT) ?? 0 });
                    }
                  }}
                  keyboardType="number-pad"
                  selectTextOnFocus
                  errorMessage={problem('storeAmount')}
                  testID={`${testID}.storeAmount`}
                />
              </View>
            )}
          </View>
        ) : null}
        {row !== null && listEditable ? (
          <View style={styles.rowActions}>
            <TextButton
              label={tn('repair.prices.copy')}
              icon="add"
              onPress={() => discard.requestLeave(() => onCopy(row))}
              testID={`${testID}.copy`}
            />
            <TextButton
              label={tn('repair.prices.remove.action')}
              icon="remove"
              tone="danger"
              onPress={() => setRemoving(true)}
              testID={`${testID}.remove`}
            />
          </View>
        ) : null}
      </View>
    </FlowScreen>
  );
}

const styles = StyleSheet.create({
  fields: { gap: space.xl },
  label: { ...type.caption, color: color.textMuted, marginBottom: space.xs },
  error: { ...type.caption, color: color.danger, marginTop: space.xs },
  choices: { marginTop: space.sm },
  facts: { gap: space.md },
  storeAmount: { marginTop: space.md },
  rowActions: { alignItems: 'flex-start', gap: space.sm, marginLeft: -space.sm },
});
