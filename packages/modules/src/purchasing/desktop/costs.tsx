// What an order's deliveries cost, on the counter PC, for people who may see buy prices: each part
// of each delivery with its price and line total, the total so far, and a dialog to fill in a price
// left for later or fix one. Read apart from the order (`orderCosts`), as on the phone, so on a PC
// holding no costs only this section says it needs internet.
import { formatMoney } from '@bolusi/i18n';
import { Button, Section } from '@bolusi/ui-web';
import { useState } from 'react';

import { MAX_UNIT_COST } from '../../inventory/constants.js';
import { useInventoryRuntime } from '../../inventory/runtime.js';
import { useActionRunner } from '../../screen-kit/index.js';
import { QueryPanel, TaskDialog } from '../../screen-kit/desktop/index.js';
import { MoneyField } from '../../screen-kit/desktop/money-field.js';
import { tp } from '../i18n.js';
import { pricedTotal } from '../order-form.js';
import type { ReceiptCostRow } from '../queries.js';
import { usePurchasingQuery } from '../runtime.js';

export function OrderCostsSection({
  orderId,
  onPrice,
  testId,
}: {
  readonly orderId: string;
  readonly onPrice: (line: ReceiptCostRow) => void;
  readonly testId: string;
}): React.JSX.Element {
  const [reloadNonce, setReloadNonce] = useState(0);
  const query = usePurchasingQuery(
    async (rt) => (await rt.query('orderCosts', { orderId })).rows,
    `desk.orderCosts:${orderId}:${String(reloadNonce)}`,
  );
  return (
    <Section title={tp('purchasing.order.costs')} testId={`${testId}.costs`}>
      <QueryPanel query={query} onRetry={() => setReloadNonce((n) => n + 1)}>
        {(rows) => <CostRows rows={rows} onPrice={onPrice} testId={testId} />}
      </QueryPanel>
    </Section>
  );
}

function CostRows({
  rows,
  onPrice,
  testId,
}: {
  readonly rows: readonly ReceiptCostRow[];
  readonly onPrice: (line: ReceiptCostRow) => void;
  readonly testId: string;
}): React.JSX.Element {
  const total = pricedTotal(rows);
  const unpriced = rows.filter((row) => row.unitCost === null).length;
  return (
    <div>
      <ul>
        {rows.map((row) => (
          <li
            key={row.movementId}
            className="flex items-center gap-4 border-b border-border py-2"
            data-testid={`${testId}.cost.${row.movementId}`}
          >
            <div className="min-w-0 flex-1">
              <div className="text-body text-text">{row.name}</div>
              <div className="tabular text-small text-text-muted">
                {row.unitCost === null
                  ? tp('purchasing.order.qty', { qty: row.qty })
                  : tp('purchasing.order.costLine', {
                      qty: row.qty,
                      price: formatMoney(row.unitCost),
                    })}
              </div>
            </div>
            {row.unitCost === null ? null : (
              <span className="tabular shrink-0 text-right text-body font-semibold text-text">
                {formatMoney(row.qty * row.unitCost)}
              </span>
            )}
            <Button
              label={tp(
                row.unitCost === null
                  ? 'purchasing.action.fillPrice'
                  : 'purchasing.action.fixPrice',
              )}
              variant="text"
              size="sm"
              className="-my-1 shrink-0"
              onClick={() => onPrice(row)}
              data-testid={`${testId}.cost.${row.movementId}.${row.unitCost === null ? 'fill' : 'fix'}`}
            />
          </li>
        ))}
      </ul>
      {total === null ? null : (
        <div
          className="flex items-baseline justify-between gap-4 pt-3"
          data-testid={`${testId}.costTotal`}
        >
          <span className="text-body font-semibold text-text">
            {tp('purchasing.order.costTotal')}
          </span>
          <span className="tabular text-body font-semibold text-text">{formatMoney(total)}</span>
        </div>
      )}
      {unpriced === 0 ? null : (
        <p className="pt-2 text-small text-warning" data-testid={`${testId}.costUnpriced`}>
          {tp('purchasing.order.costUnpriced', { count: unpriced })}
        </p>
      )}
    </div>
  );
}

/** Harga beli: what a piece of one delivered part cost, filled in or fixed. */
export function PriceDialog({
  line,
  onClose,
  onDone,
}: {
  readonly line: ReceiptCostRow;
  readonly onClose: () => void;
  readonly onDone: () => void;
}): React.JSX.Element {
  const inventory = useInventoryRuntime();
  const runner = useActionRunner();
  const [unitCost, setUnitCost] = useState<number | null>(line.unitCost);
  const save = (): void => {
    if (unitCost === null) return;
    void runner
      .run(() => inventory.run('priceStock', { movementId: line.movementId, unitCost }))
      .then((result) => {
        if (result !== undefined) onDone();
      });
  };
  return (
    <TaskDialog
      title={tp('purchasing.price.title')}
      description={`${line.name} · ${tp('purchasing.order.qty', { qty: line.qty })}`}
      runner={runner}
      dirty={unitCost !== line.unitCost}
      discard={{
        title: tp('purchasing.price.discardTitle'),
        message: tp('purchasing.price.discardMessage'),
        confirm: tp('purchasing.discard.confirm'),
        keep: tp('purchasing.discard.keep'),
      }}
      onClose={onClose}
      submitLabel={tp('purchasing.price.save')}
      onSubmit={save}
      submitDisabled={unitCost === null}
      hint={unitCost === null ? tp('purchasing.price.empty') : null}
      size="sm"
      testId="purchasing.desk.price"
    >
      <MoneyField
        label={tp('purchasing.price.field')}
        prefix={tp('purchasing.desk.currency')}
        value={unitCost}
        onChange={setUnitCost}
        max={MAX_UNIT_COST}
        autoFocus
        hint={
          unitCost !== null && line.qty > 1
            ? `${tp('purchasing.order.costTotal')} ${formatMoney(unitCost * line.qty)}`
            : undefined
        }
        data-testid="purchasing.desk.price.amount"
      />
    </TaskDialog>
  );
}
