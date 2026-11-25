// Find a part on the business's list from the counter PC, to add to an order or a transfer.
import { SearchField } from '@bolusi/ui-web';
import { Plus } from 'lucide-react';
import { useState } from 'react';

import { useSettledValue } from '../../screen-kit/index.js';
import { QueryPanel } from '../../screen-kit/desktop/index.js';
import { ti } from '../i18n.js';
import { stockText } from '../labels.js';
import type { ItemRow } from '../queries.js';
import { useInventoryQuery, useInventoryRuntime } from '../runtime.js';

const PICK_LIMIT = 8;

/**
 * Find a part to add: typing ranks the parts list, a click adds the part (one more when it is
 * already picked). A USB scanner types a code and presses Enter, which adds the part it names.
 */
export function PartSearch({
  picked,
  label,
  onPick,
  testId,
}: {
  /** Parts already picked, marked so a second click reads as "one more". */
  readonly picked: ReadonlySet<string>;
  /** The field's label ("Tambah sparepart"). */
  readonly label: string;
  readonly onPick: (item: ItemRow) => void;
  readonly testId: string;
}): React.JSX.Element {
  const inventory = useInventoryRuntime();
  const [text, setText] = useState('');
  const [reloadNonce, setReloadNonce] = useState(0);
  const typed = text.trim();
  const settled = useSettledValue(typed);
  const searchText = typed === '' ? '' : settled;
  const query = useInventoryQuery(
    async (rt) =>
      searchText === ''
        ? []
        : (await rt.query('listItems', { text: searchText, filter: 'active', limit: PICK_LIMIT }))
            .rows,
    `desk.pick:${searchText}:${String(reloadNonce)}`,
  );
  const pick = (item: ItemRow): void => {
    onPick(item);
    setText('');
  };
  const pickCode = async (): Promise<void> => {
    const found = await inventory
      .query('findByCode', { code: typed })
      .then((page) => page.rows)
      .catch(() => []);
    const only = found.length === 1 ? found[0] : undefined;
    if (only !== undefined && !only.archived) pick(only);
  };
  return (
    <div
      onKeyDown={(event) => {
        if (event.key === 'Enter' && event.target instanceof HTMLInputElement && typed !== '') {
          event.preventDefault();
          void pickCode();
        }
      }}
    >
      <SearchField
        value={text}
        onChange={setText}
        placeholder={ti('inventory.pick.searchHint')}
        label={label}
        clearLabel={ti('inventory.pick.clear')}
        testId={`${testId}.search`}
      />
      {searchText === '' ? null : (
        <div className="mt-1 max-h-64 overflow-y-auto rounded-sm border border-border">
          <QueryPanel query={query} onRetry={() => setReloadNonce((n) => n + 1)}>
            {(rows) =>
              rows.length === 0 ? (
                <p className="px-3 py-4 text-center text-body text-text-muted">
                  {ti('inventory.pick.noMatches')}
                </p>
              ) : (
                <ul>
                  {rows.map((row) => (
                    <li key={row.id}>
                      <button
                        type="button"
                        onClick={() => pick(row)}
                        className="flex w-full cursor-pointer items-center gap-3 border-b border-border px-3 py-2 text-left last:border-b-0 hover:bg-surface-alt focus-visible:bg-surface-alt focus-visible:outline-none"
                        data-testid={`${testId}.choice.${row.id}`}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block text-body font-semibold text-text">
                            {row.name}
                          </span>
                          {picked.has(row.id) ? (
                            <span className="block text-small text-text-muted">
                              {ti('inventory.pick.onList')}
                            </span>
                          ) : row.code === null ? null : (
                            <span className="tabular block text-small text-text-muted">
                              {row.code}
                            </span>
                          )}
                        </span>
                        <span
                          className={
                            row.onHand < 0
                              ? 'tabular shrink-0 text-small font-semibold text-danger'
                              : 'tabular shrink-0 text-small text-text-muted'
                          }
                        >
                          {ti('inventory.pick.stock', { count: stockText(row.onHand) })}
                        </span>
                        <Plus size={16} aria-hidden className="shrink-0 text-primary" />
                      </button>
                    </li>
                  ))}
                </ul>
              )
            }
          </QueryPanel>
        </div>
      )}
    </div>
  );
}
