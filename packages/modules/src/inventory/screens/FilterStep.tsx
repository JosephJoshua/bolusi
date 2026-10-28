/**
 * FilterStep — narrow the items list beyond its category chips: by stock, by the values of the
 * category's fields (Kualitas: Original), and by tags. The choices are the values items actually
 * carry, most used first, so a filter never offers something that finds nothing. The phones a
 * part fits are left to search, which already matches them typo and all.
 */
import { ChoiceChips, SegmentedControl, color, space, type } from '@bolusi/ui';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { FlowScreen, type ScreenChrome } from '../../screen-kit/screens/views.js';
import { INVENTORY_PERMISSION, TAG_FACET } from '../constants.js';
import { ti, type InventoryKey } from '../i18n.js';
import { NO_CATEGORY, type CategoryRow, type FacetValueRow, type PartFilter } from '../queries.js';
import { useInventoryQuery, useInventoryRuntime } from '../runtime.js';
import { NO_FILTER, type ListFilter } from './PartList.js';

const STOCK_KEY: Readonly<Record<PartFilter, InventoryKey>> = {
  active: 'inventory.filter.active',
  outOfStock: 'inventory.filter.outOfStock',
  belowZero: 'inventory.filter.belowZero',
  archived: 'inventory.filter.archived',
};

export interface FilterStepProps {
  readonly chrome: ScreenChrome;
  readonly filter: ListFilter;
  readonly onApply: (filter: ListFilter) => void;
  readonly onCancel: () => void;
  readonly testID?: string | undefined;
}

interface Choices {
  readonly category: CategoryRow | null;
  readonly facets: readonly FacetValueRow[];
}

export function FilterStep({
  chrome,
  filter,
  onApply,
  onCancel,
  testID = 'inventory.filterStep',
}: FilterStepProps): React.JSX.Element {
  const runtime = useInventoryRuntime();
  // Stock below zero and archived items are the owner's to sort out, as on the list.
  const canManage = runtime.hasPermission(INVENTORY_PERMISSION.manageItems);
  const [draft, setDraft] = useState<ListFilter>(filter);
  const categoryId =
    filter.categoryId === null || filter.categoryId === NO_CATEGORY ? null : filter.categoryId;

  const choices = useInventoryQuery<Choices>(
    async (rt) => ({
      category:
        categoryId === null
          ? null
          : ((await rt.query('listCategories', { includeArchived: true })).rows.find(
              (row) => row.id === categoryId,
            ) ?? null),
      facets: (await rt.query('facetValues', { categoryId })).rows,
    }),
    `itemFilter:${categoryId ?? ''}`,
  );
  const loaded = choices.status === 'ready' ? choices.data : { category: null, facets: [] };
  const inUse = (facet: string): string[] =>
    loaded.facets.filter((row) => row.facet === facet).map((row) => row.value);
  // Fields with nothing in use offer nothing to filter by; phones go through search.
  const fields = (loaded.category?.fields ?? []).filter(
    (field) => field.kind !== 'phones' && inUse(field.id).length > 0,
  );
  const tags = inUse(TAG_FACET);
  const stocks: readonly PartFilter[] = canManage
    ? ['active', 'outOfStock', 'belowZero', 'archived']
    : ['active', 'outOfStock'];

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
            options={stocks.map((value) => ({ value, label: ti(STOCK_KEY[value]) }))}
            value={draft.stock}
            onChange={(stock) => setDraft((current) => ({ ...current, stock }))}
            size="compact"
            wrap
            testID={`${testID}.stock`}
          />
        </View>
        {fields.map((field) => (
          <ChoiceChips
            key={field.id}
            label={field.label}
            options={inUse(field.id)}
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
