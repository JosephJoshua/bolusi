/**
 * ModelsField — the phones a part fits, picked from the phone catalog the intake uses: type a few
 * letters, tap the model. A phone the catalog does not know can still be added as typed. Picked
 * models list above the search, each with a way to take it off.
 */
import { ListRow, SearchField, TextButton, color, space, type } from '@bolusi/ui';
import { StyleSheet, Text, View } from 'react-native';
import { useState } from 'react';

import { useSettledValue } from '../../screen-kit/index.js';
import { compactModel } from '../../shared/model-key.js';
import { MAX_PART_FITS } from '../constants.js';
import { ti } from '../i18n.js';
import type { ItemFitRow } from '../queries.js';
import { useInventoryQuery, useInventoryRuntime } from '../runtime.js';

const SUGGESTIONS = 5;

export interface ModelsFieldProps {
  readonly value: readonly ItemFitRow[];
  readonly onChange: (next: readonly ItemFitRow[]) => void;
  readonly testID: string;
}

const keyOf = (fit: ItemFitRow): string => compactModel(fit.brand, fit.model);

/** "Samsung Galaxy A14", or the model alone when it was typed without a brand. */
export function fitLabel(fit: ItemFitRow): string {
  return `${fit.brand} ${fit.model}`.trim();
}

export function ModelsField({ value, onChange, testID }: ModelsFieldProps): React.JSX.Element {
  const runtime = useInventoryRuntime();
  const [text, setText] = useState('');
  const typed = text.trim();
  const settled = useSettledValue(typed);
  const searchText = typed === '' ? '' : settled;
  const found = useInventoryQuery(
    async (rt) =>
      searchText === '' || rt.searchModels === undefined
        ? []
        : rt.searchModels(searchText, SUGGESTIONS + value.length),
    `fitModels:${searchText}`,
  );
  const picked = new Set(value.map(keyOf));
  const suggestions = (found.status === 'ready' ? found.data : [])
    .filter((option) => !picked.has(keyOf(option)))
    .slice(0, SUGGESTIONS);
  // A model the catalog has no exact spelling for can still be added just as typed.
  const typedKey = compactModel(typed);
  const offerTyped =
    typed !== '' &&
    !picked.has(typedKey) &&
    !suggestions.some((option) => [keyOf(option), compactModel(option.model)].includes(typedKey));
  const full = value.length >= MAX_PART_FITS;

  const add = (fit: ItemFitRow): void => {
    onChange([...value, { brand: fit.brand, model: fit.model }]);
    setText('');
  };

  return (
    <View testID={testID}>
      <Text style={styles.label}>{ti('inventory.form.fits')}</Text>
      {value.map((fit, i) => (
        <ListRow
          key={keyOf(fit)}
          primaryText={fitLabel(fit)}
          trailing={
            <TextButton
              label={ti('inventory.form.removeFit')}
              accessibilityLabel={`${ti('inventory.form.removeFit')} ${fitLabel(fit)}`}
              onPress={() => onChange(value.filter((_, j) => j !== i))}
              testID={`${testID}.remove.${String(i)}`}
            />
          }
          testID={`${testID}.picked.${String(i)}`}
        />
      ))}
      {full ? null : (
        <View style={value.length === 0 ? null : styles.search}>
          <SearchField
            value={text}
            onChangeText={setText}
            placeholder={ti('inventory.form.fitsSearch')}
            accessibilityLabel={ti('inventory.form.fitsSearch')}
            clearLabel={ti('inventory.list.clearSearch')}
            testID={`${testID}.search`}
          />
        </View>
      )}
      {suggestions.map((option) => (
        <ListRow
          key={option.key}
          primaryText={option.model}
          secondaryText={option.caption}
          onPress={() => add(option)}
          testID={`${testID}.option.${option.key}`}
        />
      ))}
      {offerTyped && !full ? (
        <ListRow
          primaryText={ti('inventory.form.addTyped', { model: typed })}
          secondaryText={
            runtime.searchModels === undefined ? undefined : ti('inventory.form.notInCatalog')
          }
          onPress={() => add({ brand: '', model: typed })}
          testID={`${testID}.typed`}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  label: { ...type.caption, color: color.textMuted, marginBottom: space.xs },
  search: { marginTop: space.sm },
});
