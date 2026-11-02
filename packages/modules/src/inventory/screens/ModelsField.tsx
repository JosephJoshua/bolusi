/**
 * ModelsField — the phones a part fits, picked from the phone catalog the intake uses: type a few
 * letters, tap the model. A phone the catalog does not know can still be added as typed. Picked
 * models list above the search, each with a way to take it off.
 */
import { ListRow, SearchField, TextButton, color, space, type, Text } from '@bolusi/ui';
import { StyleSheet, View } from 'react-native';
import { useState } from 'react';

import { ti } from '../i18n.js';
import { fitKey, fitLabel, useModelOptions } from '../model-options.js';
import type { ItemFitRow } from '../queries.js';

export interface ModelsFieldProps {
  /** Already-localized; a category's phones field brings its own ("HP"). */
  readonly label?: string | undefined;
  readonly value: readonly ItemFitRow[];
  readonly onChange: (next: readonly ItemFitRow[]) => void;
  readonly testID: string;
}

export function ModelsField({
  label = ti('inventory.form.fits'),
  value,
  onChange,
  testID,
}: ModelsFieldProps): React.JSX.Element {
  const [text, setText] = useState('');
  const typed = text.trim();
  const { suggestions, offerTyped, hasCatalog, full } = useModelOptions(text, value);

  const add = (fit: ItemFitRow): void => {
    onChange([...value, { brand: fit.brand, model: fit.model }]);
    setText('');
  };

  return (
    <View testID={testID}>
      <Text style={styles.label}>{label}</Text>
      {value.map((fit, i) => (
        <ListRow
          key={fitKey(fit)}
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
          secondaryText={hasCatalog ? ti('inventory.form.notInCatalog') : undefined}
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
