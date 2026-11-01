// Parts on a use (a servisan) on the counter PC: the section in its pane, with the dialogs that take
// a part off the shelf for it and put an unused one back. The customer never sees these: parts used
// are the store's own record, not lines on the bill (owner decision, 2026-10-28).
//
// Whether the user may take or put back now is the owning module's call (the servisan pane knows
// its state); the stock rules check it again on save and on the server.
import { t } from '@bolusi/i18n';
import { Button, SearchField, Section } from '@bolusi/ui-web';
import { Check, TriangleAlert } from 'lucide-react';
import { useState } from 'react';

import { useActionRunner, useSettledValue } from '../../screen-kit/index.js';
import { QueryPanel, TaskDialog } from '../../screen-kit/desktop/index.js';
import { MAX_MOVEMENT_QTY } from '../constants.js';
import { ti } from '../i18n.js';
import { stockText } from '../labels.js';
import type { ItemRow, UsedPartRow } from '../queries.js';
import { useInventoryQuery, useInventoryRuntime } from '../runtime.js';
import { partForCode, useTakeChoices, type PartUse } from '../take-part.js';
import { discardCopy } from './dialogs.js';
import { QtyField } from './fields.js';

export interface UsedPartsSectionProps {
  readonly use: PartUse;
  /** The phone being repaired: parts that fit it are offered first, before anything is typed. */
  readonly device?: { readonly brand: string; readonly model: string } | undefined;
  /** The user may put back parts taken for this use now. */
  readonly editable: boolean;
  /** The user may take a new part for this use now (not once a servisan is cancelled). */
  readonly takeable: boolean;
  /** The use is closed without its work (a cancelled servisan): parts still out are flagged. */
  readonly flagUnreturned: boolean;
  /** A take or put-back landed, in words for the pane's banner. */
  readonly onDone: (message: string) => void;
  readonly testId?: string | undefined;
}

type Task =
  | { readonly kind: 'none' }
  | { readonly kind: 'take' }
  | { readonly kind: 'putBack'; readonly part: UsedPartRow };

export function UsedPartsSection({
  use,
  device,
  editable,
  takeable,
  flagUnreturned,
  onDone,
  testId = 'inventory.desk.used',
}: UsedPartsSectionProps): React.JSX.Element | null {
  const [reloadNonce, setReloadNonce] = useState(0);
  const [task, setTask] = useState<Task>({ kind: 'none' });
  const query = useInventoryQuery(
    async (rt) => (await rt.query('partsForUse', { useKind: use.kind, useId: use.id })).rows[0],
    `desk.used:${use.kind}:${use.id}:${String(reloadNonce)}`,
  );
  // A put-back to zero leaves the part's history, not a row reading "0 diambil".
  const parts = query.status === 'ready' ? (query.data?.parts ?? []).filter((p) => p.out > 0) : [];
  if (query.status === 'ready' && parts.length === 0 && !takeable) return null;
  const finish = (message: string): void => {
    setTask({ kind: 'none' });
    onDone(message);
  };
  return (
    <Section
      title={ti('inventory.use.title')}
      action={
        takeable ? (
          <Button
            label={ti('inventory.use.take')}
            aria-label={ti('inventory.use.takeTitle')}
            variant="text"
            size="sm"
            className="-my-1"
            onClick={() => setTask({ kind: 'take' })}
            data-testid={`${testId}.take`}
          />
        ) : undefined
      }
      testId={testId}
    >
      <QueryPanel query={query} onRetry={() => setReloadNonce((n) => n + 1)}>
        {() =>
          parts.length === 0 ? (
            <p className="text-body text-text-muted">{ti('inventory.use.none')}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {parts.map((part) => (
                <li
                  key={part.itemId}
                  className="flex items-center gap-4 py-2"
                  data-testid={`${testId}.part.${part.itemId}`}
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-body font-semibold text-text">{part.name}</p>
                    <p className="text-small text-text-muted">
                      {ti('inventory.use.out', { count: part.out })}
                    </p>
                    {flagUnreturned ? (
                      <p className="mt-1 flex items-center gap-1 text-small font-semibold text-warning">
                        <TriangleAlert size={14} aria-hidden />
                        {ti('inventory.use.notReturned')}
                      </p>
                    ) : null}
                  </div>
                  {editable ? (
                    <Button
                      label={ti('inventory.use.putBack')}
                      aria-label={`${ti('inventory.use.putBack')} ${part.name}`}
                      variant="text"
                      size="sm"
                      onClick={() => setTask({ kind: 'putBack', part })}
                      data-testid={`${testId}.putBack.${part.itemId}`}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          )
        }
      </QueryPanel>
      {task.kind === 'take' ? (
        <TakePartDialog
          use={use}
          device={device}
          onClose={() => setTask({ kind: 'none' })}
          onDone={() => finish(ti('inventory.done.taken'))}
        />
      ) : task.kind === 'putBack' ? (
        <PutBackDialog
          use={use}
          part={task.part}
          onClose={() => setTask({ kind: 'none' })}
          onDone={() => finish(ti('inventory.done.putBack'))}
        />
      ) : null}
    </Section>
  );
}

/** Pick a part, say how many, take it. Stock may go below zero; the owner sees it flagged. */
function TakePartDialog({
  use,
  device,
  onClose,
  onDone,
}: {
  readonly use: PartUse;
  readonly device?: { readonly brand: string; readonly model: string } | undefined;
  readonly onClose: () => void;
  readonly onDone: () => void;
}): React.JSX.Element {
  const runtime = useInventoryRuntime();
  const runner = useActionRunner();
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<ItemRow | null>(null);
  const [qty, setQty] = useState(1);
  const [reloadNonce, setReloadNonce] = useState(0);
  const typed = text.trim();
  const settled = useSettledValue(typed);
  const searchText = typed === '' ? '' : settled;
  const query = useTakeChoices(searchText, device, reloadNonce);
  const testId = 'inventory.desk.take';

  const pick = (row: ItemRow): void => {
    setPicked(row);
    setQty(1);
  };
  /** A scanned code picks its part when it names exactly one; otherwise it stays a search. */
  const pickCode = async (): Promise<void> => {
    if (typed === '') return;
    const part = await partForCode(runtime, typed);
    if (part !== null) pick(part);
  };
  const take = (): void => {
    if (picked === null) return;
    void runner
      .run(() => runtime.run('takePart', { itemId: picked.id, qty, use }))
      .then((result) => {
        if (result !== undefined) onDone();
      });
  };

  const choice = (row: ItemRow): React.JSX.Element => {
    const selected = picked?.id === row.id;
    return (
      <li key={row.id}>
        <button
          type="button"
          role="radio"
          aria-checked={selected}
          onClick={() => pick(row)}
          className={
            selected
              ? 'flex w-full cursor-pointer items-center gap-3 rounded-sm bg-info-bg px-3 py-2 text-left'
              : 'flex w-full cursor-pointer items-center gap-3 rounded-sm px-3 py-2 text-left hover:bg-surface-alt'
          }
          data-testid={`${testId}.choice.${row.id}`}
        >
          <span className="min-w-0 flex-1">
            <span className="block text-body font-semibold text-text">{row.name}</span>
            {row.fits === null ? null : (
              <span className="block truncate text-small text-text-muted">{row.fits}</span>
            )}
          </span>
          <span
            className={
              row.onHand < 0
                ? 'tabular shrink-0 text-small font-semibold text-danger'
                : 'tabular shrink-0 text-small text-text-muted'
            }
          >
            {ti('inventory.list.stockCount', { count: stockText(row.onHand) })}
          </span>
          <Check
            size={16}
            aria-hidden
            className={selected ? 'shrink-0 text-primary' : 'invisible shrink-0'}
          />
        </button>
      </li>
    );
  };

  return (
    <TaskDialog
      title={ti('inventory.use.takeTitle')}
      description={use.label}
      runner={runner}
      dirty={picked !== null}
      discard={discardCopy()}
      onClose={onClose}
      submitLabel={ti('inventory.use.takeAction')}
      onSubmit={take}
      submitDisabled={picked === null}
      hint={picked === null ? ti('inventory.use.pickFirst') : null}
      size="md"
      testId={testId}
    >
      {/* A USB scanner types the code and presses Enter: that picks the part it names. */}
      <div
        onKeyDown={(event) => {
          if (event.key === 'Enter' && event.target instanceof HTMLInputElement && typed !== '') {
            event.preventDefault();
            void pickCode();
          }
        }}
      >
        {/* The search has the keyboard from the start, so a scanner's code lands in it. */}
        <SearchField
          autoFocus
          value={text}
          onChange={setText}
          placeholder={ti('inventory.use.searchHint')}
          label={t('core.action.search')}
          clearLabel={ti('inventory.list.clearSearch')}
          testId={`${testId}.search`}
        />
      </div>
      <div
        className="max-h-80 min-h-40 overflow-y-auto"
        role="radiogroup"
        aria-label={ti('inventory.use.title')}
      >
        <QueryPanel query={query} onRetry={() => setReloadNonce((n) => n + 1)}>
          {({ fitting, rest }) =>
            fitting.length === 0 && rest.length === 0 ? (
              <p className="py-6 text-center text-body text-text-muted">
                {searchText === ''
                  ? ti('inventory.list.emptyHint')
                  : ti('inventory.list.noMatches')}
              </p>
            ) : (
              <>
                {fitting.length === 0 || device === undefined ? null : (
                  <>
                    <p
                      className="px-3 pb-1 pt-2 text-small font-semibold text-text-muted"
                      data-testid={`${testId}.fitting`}
                    >
                      {ti('inventory.use.fitsDevice', {
                        model: `${device.brand} ${device.model}`.trim(),
                      })}
                    </p>
                    <ul>{fitting.map(choice)}</ul>
                    {rest.length === 0 ? null : (
                      <p className="px-3 pb-1 pt-3 text-small font-semibold text-text-muted">
                        {ti('inventory.use.otherParts')}
                      </p>
                    )}
                  </>
                )}
                <ul>{rest.map(choice)}</ul>
              </>
            )
          }
        </QueryPanel>
      </div>
      {picked === null ? null : (
        <div
          className="flex flex-col gap-3 border-t border-border pt-4"
          data-testid={`${testId}.picked`}
        >
          {/* Named here too: a new search can leave the picked part out of the list. */}
          <p className="text-body font-semibold text-text">{picked.name}</p>
          <QtyField
            label={ti('inventory.use.qty')}
            value={qty}
            onChange={setQty}
            min={1}
            max={MAX_MOVEMENT_QTY}
            hint={ti('inventory.list.stockCount', { count: stockText(picked.onHand) })}
            testId={`${testId}.qty`}
          />
        </div>
      )}
    </TaskDialog>
  );
}

/** Put unused parts back on the shelf: at most what this use took. */
function PutBackDialog({
  use,
  part,
  onClose,
  onDone,
}: {
  readonly use: PartUse;
  readonly part: UsedPartRow;
  readonly onClose: () => void;
  readonly onDone: () => void;
}): React.JSX.Element {
  const runtime = useInventoryRuntime();
  const runner = useActionRunner();
  const [qty, setQty] = useState(1);
  const putBack = (): void => {
    void runner
      .run(() => runtime.run('putBackPart', { itemId: part.itemId, qty, use }))
      .then((result) => {
        if (result !== undefined) onDone();
      });
  };
  return (
    <TaskDialog
      title={ti('inventory.use.putBackTitle')}
      description={ti('inventory.use.putBackMessage', { name: part.name })}
      runner={runner}
      dirty={false}
      discard={discardCopy()}
      onClose={onClose}
      submitLabel={ti('inventory.use.putBackAction')}
      onSubmit={putBack}
      testId="inventory.desk.putBack"
    >
      {part.out > 1 ? (
        <QtyField
          label={ti('inventory.use.qty')}
          value={qty}
          onChange={setQty}
          min={1}
          max={part.out}
          hint={ti('inventory.use.out', { count: part.out })}
          testId="inventory.desk.putBack.qty"
        />
      ) : null}
    </TaskDialog>
  );
}
