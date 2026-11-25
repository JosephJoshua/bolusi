// What a part costs this store, on the counter PC, for people who may see buy prices: the average
// cost per piece and what the latest deliveries cost. Read apart from the part (`itemCost`), as on
// the phone, so on a PC holding no costs only this section says it needs internet.
import { formatDate, formatMoney } from '@bolusi/i18n';
import { Section } from '@bolusi/ui-web';
import { useState } from 'react';

import { QueryPanel } from '../../screen-kit/desktop/index.js';
import { ti } from '../i18n.js';
import type { ItemCostRow } from '../queries.js';
import { useInventoryQuery } from '../runtime.js';

/** How many of the latest deliveries the section lists. */
const RECEIPTS_SHOWN = 5;

export function PartCostSection({ itemId }: { readonly itemId: string }): React.JSX.Element {
  const [reloadNonce, setReloadNonce] = useState(0);
  const query = useInventoryQuery(
    async (rt) => (await rt.query('itemCost', { itemId })).rows[0],
    `desk.itemCost:${itemId}:${String(reloadNonce)}`,
  );
  return (
    <Section title={ti('inventory.cost.title')} testId="inventory.desk.part.cost">
      <QueryPanel query={query} onRetry={() => setReloadNonce((n) => n + 1)}>
        {(cost) => (cost === undefined ? null : <CostBody cost={cost} />)}
      </QueryPanel>
    </Section>
  );
}

function CostBody({ cost }: { readonly cost: ItemCostRow }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="text-small text-text-muted">{ti('inventory.cost.average')}</p>
        <p
          className={
            cost.average === null
              ? 'text-body text-text-muted'
              : 'tabular text-heading font-bold text-text'
          }
          data-testid="inventory.desk.part.cost.average"
        >
          {cost.average === null
            ? ti('inventory.cost.noAverage')
            : ti('inventory.cost.perPiece', { amount: formatMoney(cost.average) })}
        </p>
        {cost.unpriced === 0 ? null : (
          <p className="text-small text-warning" data-testid="inventory.desk.part.cost.unpriced">
            {ti('inventory.cost.unpriced', { count: cost.unpriced })}
          </p>
        )}
      </div>
      {cost.receipts.length === 0 ? null : (
        <ul>
          {cost.receipts.slice(0, RECEIPTS_SHOWN).map((receipt) => (
            <li
              key={receipt.movementId}
              className="flex items-start gap-4 border-t border-border py-2"
              data-testid={`inventory.desk.part.cost.${receipt.movementId}`}
            >
              <div className="min-w-0 flex-1">
                <div className="text-body text-text">
                  {receipt.label === null
                    ? ti('inventory.cost.receiptNoLabel', { qty: receipt.qty })
                    : ti('inventory.cost.receipt', { qty: receipt.qty, label: receipt.label })}
                </div>
                <div className="tabular text-small text-text-muted">{formatDate(receipt.at)}</div>
              </div>
              <span
                className={
                  receipt.unitCost === null
                    ? 'shrink-0 text-right text-body text-warning'
                    : 'tabular shrink-0 text-right text-body font-semibold text-text'
                }
              >
                {receipt.unitCost === null
                  ? ti('inventory.cost.missing')
                  : ti('inventory.cost.perPiece', { amount: formatMoney(receipt.unitCost) })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
