/**
 * Metode pembayaran in the PC's Settings: the phone's list and form (money/screens/PaymentMethods)
 * as a settings page and a dialog, over the same form state and save (`usePaymentMethodForm`).
 * Cash is always there; a method is switched off rather than deleted, and its kind never changes.
 */
import { t } from '@bolusi/i18n';
import {
  Banner,
  Button,
  Chip,
  Segmented,
  SettingsPanel,
  StatePanel,
  Switch,
  TextField,
  ToggleChip,
} from '@bolusi/ui-web';
import { CircleOff, CreditCard, Plus } from 'lucide-react';
import { useState } from 'react';

import { QueryPanel } from '../../screen-kit/desktop/index.js';

import { MAX_ACCOUNT_NAME, MONEY_PERMISSION, PAYMENT_ACCOUNT_KINDS } from '../constants.js';
import { tm } from '../i18n.js';
import {
  KIND_KEY,
  methodStores,
  methodsInOrder,
  useMethodAccess,
  useMoneyStores,
  usePaymentMethodForm,
} from '../methods.js';
import type { PaymentAccountRow } from '../queries.js';
import { useMoneyQuery, type MoneyRuntime } from '../runtime.js';

import { MoneyDialog } from './parts.js';

/** Whether this person may open the page: it reads the methods as the payment step does. */
export function managesPaymentMethods(runtime: Pick<MoneyRuntime, 'hasPermission'>): boolean {
  return (
    runtime.hasPermission(MONEY_PERMISSION.receive) &&
    (runtime.hasPermission(MONEY_PERMISSION.manageAccounts) ||
      runtime.hasPermission(MONEY_PERMISSION.manageCentralAccounts))
  );
}

type Editing =
  { readonly kind: 'add' } | { readonly kind: 'edit'; readonly account: PaymentAccountRow };

const GRID =
  'grid w-full grid-cols-[minmax(180px,2fr)_minmax(120px,1fr)_minmax(160px,2fr)_minmax(104px,auto)] items-center gap-x-4 px-4 py-3 text-left';

export function PaymentMethodsSettings(): React.JSX.Element {
  const access = useMethodAccess();
  const stores = useMoneyStores();
  const [nonce, setNonce] = useState(0);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const query = useMoneyQuery<readonly PaymentAccountRow[]>(
    async (rt) =>
      (await rt.query('paymentAccounts', { includeInactive: true, everyStore: access.central }))
        .rows,
    `methods:${String(nonce)}`,
  );
  const testId = 'money.desk.methods';

  return (
    <SettingsPanel
      title={tm('money.methods.title')}
      actions={
        <Button
          label={tm('money.methods.add')}
          icon={Plus}
          variant="primary"
          onClick={() => {
            setNotice(null);
            setEditing({ kind: 'add' });
          }}
          data-testid={`${testId}.add`}
        />
      }
      testId={testId}
    >
      {notice === null ? null : (
        <Banner
          tone="success"
          message={notice}
          onDismiss={() => setNotice(null)}
          dismissLabel={t('core.action.close')}
        />
      )}
      <QueryPanel query={query} onRetry={() => setNonce((n) => n + 1)}>
        {(rows) => (
          <div
            className="rounded-md border border-border bg-surface"
            data-testid={`${testId}.list`}
          >
            <div
              aria-hidden
              className="grid grid-cols-[minmax(180px,2fr)_minmax(120px,1fr)_minmax(160px,2fr)_minmax(104px,auto)] gap-x-4 border-b border-border px-4 py-2 text-small font-semibold text-text-muted"
            >
              <span>{tm('money.methods.name')}</span>
              <span>{tm('money.methods.kind')}</span>
              <span>{tm('money.methods.usedAt')}</span>
              <span />
            </div>
            <ul aria-label={tm('money.methods.title')}>
              <li className="border-b border-border last:border-b-0" data-testid={`${testId}.cash`}>
                <div className={GRID}>
                  <span className="text-body font-semibold text-text">
                    {tm('money.method.cash')}
                  </span>
                  <span />
                  <span className="text-body text-text-muted">
                    {tm('money.methods.cashAlways')}
                  </span>
                  <span />
                </div>
              </li>
              {methodsInOrder(rows).map((account) => (
                <MethodRow
                  key={account.id}
                  account={account}
                  usedAt={
                    account.central ? methodStores(account, stores) : tm('money.methods.thisStore')
                  }
                  onOpen={
                    access.mayEdit(account)
                      ? () => {
                          setNotice(null);
                          setEditing({ kind: 'edit', account });
                        }
                      : undefined
                  }
                  testId={`${testId}.row.${account.id}`}
                />
              ))}
            </ul>
            {rows.length === 0 ? (
              <StatePanel
                icon={CreditCard}
                title={tm('money.methods.none')}
                hint={tm('money.methods.noneHint')}
                testId={`${testId}.empty`}
              />
            ) : null}
          </div>
        )}
      </QueryPanel>
      {editing === null ? null : (
        <MethodDialog
          key={editing.kind === 'edit' ? editing.account.id : 'new'}
          account={editing.kind === 'edit' ? editing.account : undefined}
          onDone={(saved) => {
            setNotice(saved);
            setEditing(null);
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </SettingsPanel>
  );
}

function MethodRow({
  account,
  usedAt,
  onOpen,
  testId,
}: {
  readonly account: PaymentAccountRow;
  readonly usedAt: string;
  readonly onOpen?: (() => void) | undefined;
  readonly testId: string;
}): React.JSX.Element {
  const cells = (
    <>
      <span
        className={[
          'min-w-0 break-words text-body font-semibold',
          account.active ? 'text-text' : 'text-text-muted',
        ].join(' ')}
      >
        {account.name}
      </span>
      <span className="text-body text-text-muted">{tm(KIND_KEY[account.kind])}</span>
      <span className="min-w-0 break-words text-body text-text-muted">{usedAt}</span>
      <span className="flex justify-end">
        {account.active ? null : <Chip label={tm('money.methods.inactive')} icon={CircleOff} />}
      </span>
    </>
  );
  return (
    <li className="border-b border-border last:border-b-0" data-testid={testId}>
      {onOpen === undefined ? (
        <div className={GRID}>{cells}</div>
      ) : (
        <button
          type="button"
          onClick={onOpen}
          className={`${GRID} cursor-pointer hover:bg-surface-alt focus-visible:bg-surface-alt focus-visible:outline-none`}
          data-testid={`${testId}.open`}
        >
          {cells}
        </button>
      )}
    </li>
  );
}

function MethodDialog({
  account,
  onDone,
  onClose,
}: {
  readonly account: PaymentAccountRow | undefined;
  readonly onDone: (notice: string) => void;
  readonly onClose: () => void;
}): React.JSX.Element {
  const form = usePaymentMethodForm(account);
  const testId = 'money.desk.methodForm';
  return (
    <MoneyDialog
      title={tm(account === undefined ? 'money.methods.addTitle' : 'money.methods.editTitle')}
      runner={form.runner}
      dirty={form.dirty}
      onClose={onClose}
      submitLabel={tm('money.methods.save')}
      onSubmit={() => form.save(onDone, onClose)}
      size="md"
      testId={testId}
    >
      <div className="flex flex-col gap-2">
        <span className="text-small font-semibold text-text">{tm('money.methods.kind')}</span>
        {account === undefined ? (
          <Segmented
            options={PAYMENT_ACCOUNT_KINDS.map((value) => ({ value, label: tm(KIND_KEY[value]) }))}
            value={form.kind}
            onChange={form.setKind}
            label={tm('money.methods.kind')}
            testId={`${testId}.kind`}
          />
        ) : (
          <span className="text-body font-semibold text-text" data-testid={`${testId}.kind`}>
            {tm(KIND_KEY[form.kind])}
          </span>
        )}
      </div>
      <TextField
        label={tm('money.methods.name')}
        placeholder={tm('money.methods.namePlaceholder')}
        value={form.name}
        onChange={(event) => form.setName(event.target.value)}
        maxLength={MAX_ACCOUNT_NAME}
        error={form.tried && form.nameMissing ? tm('money.methods.nameRequired') : undefined}
        autoComplete="off"
        data-testid={`${testId}.name`}
      />
      {form.choosesCentral ? (
        <Switch
          label={tm('money.methods.allStores')}
          caption={tm('money.methods.allStoresCaption')}
          checked={form.central}
          onChange={form.setCentral}
          testId={`${testId}.central`}
        />
      ) : null}
      {form.picksStores ? (
        <div className="flex flex-col gap-2" data-testid={`${testId}.stores`}>
          <span className="text-small font-semibold text-text">{tm('money.methods.usedAt')}</span>
          <Segmented
            options={[
              { value: 'all', label: tm('money.methods.central') },
              { value: 'some', label: tm('money.methods.someStores') },
            ]}
            value={form.everyStore ? 'all' : 'some'}
            onChange={(value) => form.setEveryStore(value === 'all')}
            label={tm('money.methods.usedAt')}
            testId={`${testId}.scope`}
          />
          {form.everyStore ? null : (
            <>
              <div
                className="flex flex-wrap gap-2"
                role="group"
                aria-label={tm('money.methods.someStores')}
              >
                {form.stores.map((store) => (
                  <ToggleChip
                    key={store.id}
                    label={store.name}
                    selected={form.picked.includes(store.id)}
                    onToggle={() => form.togglePicked(store.id)}
                    testId={`${testId}.store.${store.id}`}
                  />
                ))}
              </div>
              {form.tried && form.noStore ? (
                // As a field's own error reads (TextField).
                <p
                  role="alert"
                  className="text-small text-danger"
                  data-testid={`${testId}.storeError`}
                >
                  {tm('money.methods.storeRequired')}
                </p>
              ) : null}
            </>
          )}
        </div>
      ) : null}
      {account === undefined ? null : (
        <Switch
          label={tm('money.methods.active')}
          caption={tm('money.methods.activeCaption')}
          checked={form.active}
          onChange={form.setActive}
          testId={`${testId}.active`}
        />
      )}
    </MoneyDialog>
  );
}
