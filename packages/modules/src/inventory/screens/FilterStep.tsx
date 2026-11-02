/**
 * FilterStep — narrow the items list beyond its category chips: by stock, by the values of the
 * category's fields (Kualitas: Original), and by tags. The choices are the values items actually
 * carry, most used first, so a filter never offers something that finds nothing. The phones a
 * part fits are left to search, which already matches them typo and all.
 */
import { ChoiceChips, SegmentedControl, color, space, type, Text } from '@bolusi/ui';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { FlowScreen, type ScreenChrome } from '../../screen-kit/screens/views.js';
import { ti } from '../i18n.js';
import {
  NO_FILTER,
  STOCK_VIEW_KEY,
  stockViews,
  useFilterChoices,
  type ListFilter,
} from '../list-filter.js';
import { useInventoryRuntime } from '../runtime.js';

export interface FilterStepProps {
  readonly chrome: ScreenChrome;
  readonly filter: ListFilter;
  readonly onApply: (filter: ListFilter) => void;
  readonly onCancel: () => void;
  readonly testID?: string | undefined;
}

export function FilterStep({
  chrome,
  filter,
  onApply,
  onCancel,
  testID = 'inventory.filterStep',
}: FilterStepProps): React.JSX.Element {
  const runtime = useInventoryRuntime();
  const [draft, setDraft] = useState<ListFilter>(filter);
  const { fields, tags } = useFilterChoices(filter.categoryId);
  const stocks = stockViews(runtime.hasPermission);

  return (
    <FlowScreen
      chrome={chrome}
      title={ti('inventory.filterStep.title')}
      onBack={onCancel}
      primaryLabel={ti('inventory.filterStep.show')}
      onPrimary={() => onApply(draft)}
      secondary={{
        label: ti('inventory.filterStep.clear'),
        // The category stays: it has its own chips on the list.
        onPress: () => onApply({ ...NO_FILTER, categoryId: filter.categoryId }),
        testID: `${testID}.clear`,
      }}
      busy={false}
      errorCode={null}
      onClearError={() => undefined}
      testID={testID}
    >
      <View style={styles.groups}>
        <View>
          <Text style={styles.label}>{ti('inventory.filterStep.stock')}</Text>
          <SegmentedControl
            options={stocks.map((value) => ({ value, label: ti(STOCK_VIEW_KEY[value]) }))}
            value={draft.stock}
            onChange={(stock) => setDraft((current) => ({ ...current, stock }))}
            size="compact"
            wrap
            testID={`${testID}.stock`}
          />
        </View>
        {fields.map(({ field, values: inUse }) => (
          <ChoiceChips
            key={field.id}
            label={field.label}
            options={inUse}
            value={draft.values[field.id] ?? []}
            onChange={(values) =>
              setDraft((current) => ({
                ...current,
                values: { ...current.values, [field.id]: values },
              }))
            }
            multiple
            testID={`${testID}.field.${field.id}`}
          />
        ))}
        {tags.length === 0 ? null : (
          <ChoiceChips
            label={ti('inventory.filterStep.tags')}
            options={tags}
            value={draft.tags}
            onChange={(next) => setDraft((current) => ({ ...current, tags: next }))}
            multiple
            testID={`${testID}.tags`}
          />
        )}
      </View>
    </FlowScreen>
  );
}

const styles = StyleSheet.create({
  groups: { gap: space.lg },
  label: { ...type.caption, color: color.textMuted, marginBottom: space.xs },
});
