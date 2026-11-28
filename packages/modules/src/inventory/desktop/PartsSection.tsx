// Barang on the counter PC: the parts list, and the two places it leads to for those who keep it,
// the categories page and the sheet for entering many items at once. Each is a page of its own
// with a way back; the list's filter waits for the person's return.
import { useState } from 'react';

import type { ListFilter } from '../list-filter.js';
import { BulkAddPage, type LeaveGuard } from './bulk.js';
import { CategoriesPage } from './categories.js';
import { PartsPage, type PartsPageProps } from './PartsPage.js';

export interface PartsSectionProps {
  /** Where the list sits when Barang has sections (Barang › Stok). */
  readonly place?: PartsPageProps['place'];
  readonly filter: ListFilter;
  readonly onFilterChange: (filter: ListFilter) => void;
  /** The app asks this before it leaves Barang, so a sheet being filled is not lost. */
  readonly onRegisterLeaveGuard?: ((guard: LeaveGuard | null) => void) | undefined;
}

type View = 'list' | 'categories' | 'bulk';

export function PartsSection({
  place,
  filter,
  onFilterChange,
  onRegisterLeaveGuard,
}: PartsSectionProps): React.JSX.Element {
  const [view, setView] = useState<View>('list');
  const back = (): void => setView('list');
  switch (view) {
    case 'categories':
      return <CategoriesPage onBack={back} />;
    case 'bulk':
      return <BulkAddPage onBack={back} onRegisterLeaveGuard={onRegisterLeaveGuard} />;
    case 'list':
      return (
        <PartsPage
          place={place}
          filter={filter}
          onFilterChange={onFilterChange}
          onOpenCategories={() => setView('categories')}
          onBulkAdd={() => setView('bulk')}
        />
      );
  }
}
