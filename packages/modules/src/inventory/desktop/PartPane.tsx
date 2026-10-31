// One item beside the parts list: what this store has, what it is (its category and fields, codes,
// phones and tags) and every movement here. Owners correct its stock, edit it or take it off the
// list; the history stays either way. Live like the phone's: a sync redraws it.
import { formatDateTime, t } from '@bolusi/i18n';
import {
  Banner,
  Button,
  Chip,
  ConfirmDialog,
  Fact,
  FactGrid,
  IconButton,
  Section,
  StatePanel,
  Timeline,
} from '@bolusi/ui-web';
import { Archive, SearchX, TriangleAlert, X } from 'lucide-react';
import { useState } from 'react';

import { useActionRunner } from '../../screen-kit/index.js';
import { ActionError, QueryPanel } from '../../screen-kit/desktop/index.js';
import { INVENTORY_PERMISSION } from '../constants.js';
import { ti } from '../i18n.js';
import { itemFacts } from '../item-facts.js';
import { movementTitle, signedQty, stockText } from '../labels.js';
import { itemDetails, type ItemDetailRow } from '../queries.js';
import { useInventoryQuery, useInventoryRuntime } from '../runtime.js';
import { CountDialog, PartDialog } from './dialogs.js';

export interface PartPaneProps {
  readonly itemId: string;
  readonly onClose: () => void;
  /** What the list's last task did ("Barang ditambahkan."), shown until dismissed. */
  readonly notice: string | null;
  readonly onClearNotice: () => void;
}

type Task = 'none' | 'edit' | 'count' | 'archive';

export function PartPane({
  itemId,
  onClose,
  notice,
  onClearNotice,
}: PartPaneProps): React.JSX.Element {
  const runtime = useInventoryRuntime();
  const canManage = runtime.hasPermission(INVENTORY_PERMISSION.manageItems);
  const canCount = runtime.hasPermission(INVENTORY_PERMISSION.count);
  const runner = useActionRunner();
  const [reloadNonce, setReloadNonce] = useState(0);
  const [task, setTask] = useState<Task>('none');
  const [done, setDone] = useState<string | null>(null);
  const say = (message: string | null): void => {
    onClearNotice();
    setDone(message);
  };

  const query = useInventoryQuery(
    async (rt) => (await rt.query('getItem', { itemId })).rows[0],
    `desk.part:${itemId}:${String(reloadNonce)}`,
  );
  const part = query.status === 'ready' ? query.data : undefined;
  const shown = done ?? notice;

  const setArchived = (row: ItemDetailRow, archived: boolean): void => {
    setTask('none');
    say(null);
    void runner
      .run(() => runtime.run('editItem', { itemId: row.id, archived, ...itemDetails(row) }))
      .then((result) => {
        if (result !== undefined)
          setDone(ti(archived ? 'inventory.done.archived' : 'inventory.done.restored'));
      });
  };

  const banner =
    runner.errorCode !== null ? (
      <ActionError errorCode={runner.errorCode} onDismiss={runner.clearError} />
    ) : shown !== null ? (
      <Banner
        tone="success"
        message={shown}
        onDismiss={() => say(null)}
        dismissLabel={t('core.action.close')}
      />
    ) : null;

  return (
    <section
      aria-label={part?.name ?? ti('inventory.list.title')}
      data-testid="inventory.desk.part"
      // Focusable so Enter on the list can move the keyboard here.
      tabIndex={-1}
      className="flex min-h-0 flex-1 flex-col border-l border-border bg-surface focus:outline-none"
    >
      <QueryPanel query={query} onRetry={() => setReloadNonce((n) => n + 1)}>
        {(row) =>
          row === undefined ? (
            <StatePanel
              icon={SearchX}
              title={t('core.errors.ENTITY_NOT_FOUND')}
              action={<Button label={t('core.action.close')} onClick={onClose} />}
              testId="inventory.desk.part.missing"
            />
          ) : (
            <>
              {renderHeader(row)}
              <div className="min-h-0 flex-1 overflow-y-auto">
                <div className="flex flex-col gap-8 px-6 pb-10 pt-4">
                  {banner}
                  {renderBody(row)}
                </div>
              </div>
            </>
          )
        }
      </QueryPanel>
      {part === undefined ? null : renderTask(part)}
    </section>
  );

  function renderHeader(row: ItemDetailRow): React.JSX.Element {
    const below = row.onHand < 0;
    return (
      <header className="flex flex-col gap-4 border-b border-border px-6 pb-4 pt-4">
        <div className="flex items-start gap-2">
          <h2
            className="min-w-0 flex-1 text-title font-bold text-text"
            data-testid="inventory.desk.part.name"
          >
            {row.name}
          </h2>
          <IconButton
            icon={X}
            label={ti('inventory.desk.closePart')}
            className="-mr-2 shrink-0"
            onClick={onClose}
            data-testid="inventory.desk.part.close"
          />
        </div>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-small text-text-muted">{ti('inventory.detail.stockHere')}</p>
            <p
              className={
                below
                  ? 'tabular text-display font-bold text-danger'
                  : 'tabular text-display font-bold text-text'
              }
              data-testid="inventory.desk.part.stock"
            >
              {stockText(row.onHand)}
            </p>
            {below || row.archived ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {below ? (
                  <Chip
                    label={ti('inventory.list.belowZero')}
                    icon={TriangleAlert}
                    tone="warning"
                  />
                ) : null}
                {row.archived ? (
                  <Chip label={ti('inventory.list.archived')} icon={Archive} />
                ) : null}
              </div>
            ) : null}
          </div>
          {canCount && !row.archived ? (
            <Button
              label={ti('inventory.action.count')}
              variant="primary"
              onClick={() => {
                say(null);
                setTask('count');
              }}
              disabled={runner.busy}
              data-testid="inventory.desk.part.count"
            />
          ) : null}
        </div>
      </header>
    );
  }

  function renderBody(row: ItemDetailRow): React.JSX.Element {
    const facts = itemFacts(row);
    return (
      <>
        {facts.length === 0 && !canManage ? null : (
          <Section
            title={ti('inventory.detail.title')}
            action={
              canManage ? (
                <Button
                  label={ti('inventory.action.edit')}
                  variant="text"
                  size="sm"
                  className="-my-1"
                  onClick={() => {
                    say(null);
                    setTask('edit');
                  }}
                  disabled={runner.busy}
                  data-testid="inventory.desk.part.edit"
                />
              ) : undefined
            }
            testId="inventory.desk.part.details"
          >
            <FactGrid>
              {facts.map((fact) => (
                <Fact
                  key={fact.key}
                  label={fact.label}
                  value={fact.value}
                  wide={fact.wide}
                  testId={`inventory.desk.part.${fact.key}`}
                />
              ))}
            </FactGrid>
          </Section>
        )}

        <Section title={ti('inventory.detail.history')} testId="inventory.desk.part.history">
          {row.movements.length === 0 ? (
            <p className="text-body text-text-muted">{ti('inventory.detail.noHistory')}</p>
          ) : (
            <Timeline
              entries={row.movements.map((movement) => ({
                key: movement.id,
                title: `${movementTitle(movement)} · ${signedQty(movement.qty)}`,
                meta: [formatDateTime(movement.at), movement.userName]
                  .filter((part) => part !== null)
                  .join(' · '),
                ...(movement.note === null ? {} : { detail: movement.note }),
              }))}
              testId="inventory.desk.part.timeline"
            />
          )}
        </Section>

        {canManage ? (
          <div>
            {row.archived ? (
              <Button
                label={ti('inventory.action.restore')}
                onClick={() => setArchived(row, false)}
                disabled={runner.busy}
                data-testid="inventory.desk.part.restore"
              />
            ) : (
              <Button
                label={ti('inventory.action.archive')}
                variant="dangerText"
                className="-ml-3"
                onClick={() => setTask('archive')}
                disabled={runner.busy}
                data-testid="inventory.desk.part.archive"
              />
            )}
          </div>
        ) : null}
      </>
    );
  }

  function renderTask(row: ItemDetailRow): React.JSX.Element | null {
    switch (task) {
      case 'none':
        return null;
      case 'edit':
        return (
          <PartDialog
            part={row}
            onClose={() => setTask('none')}
            onDone={() => {
              setTask('none');
              setDone(ti('inventory.done.saved'));
            }}
          />
        );
      case 'count':
        return (
          <CountDialog
            part={row}
            onClose={() => setTask('none')}
            onDone={() => {
              setTask('none');
              setDone(ti('inventory.done.counted'));
            }}
          />
        );
      case 'archive':
        return (
          <ConfirmDialog
            open
            title={ti('inventory.archive.title')}
            message={ti('inventory.archive.message')}
            confirmLabel={ti('inventory.action.archive')}
            cancelLabel={t('core.action.cancel')}
            closeLabel={t('core.action.close')}
            destructive
            onConfirm={() => setArchived(row, true)}
            onCancel={() => setTask('none')}
            testId="inventory.desk.part.archiveConfirm"
          />
        );
    }
  }
}
