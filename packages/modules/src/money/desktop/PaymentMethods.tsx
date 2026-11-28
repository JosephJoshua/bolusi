/**
 * Metode pembayaran in the PC's Settings: the phone's list and form (money/screens/PaymentMethods)
 * as a settings page and a dialog, over the same form state and save (`usePaymentMethodForm`).
 * Cash is always there; a method is switched off rather than deleted, and its kind never changes.
 * The store's cash drawers come first, each with the roles that use it (`useDrawerForm`).
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

import { MAX_ACCOUNT_NAME, PAYMENT_ACCOUNT_KINDS } from '../constants.js';
import {
  drawersInOrder,
  drawerUsers,
  useDrawerForm,
  useMayManageDrawers,
  useMoneyRoles,
} from '../drawer-settings.js';
import { drawerLabel } from '../drawers.js';
import { tm } from '../i18n.js';
import {
  KIND_KEY,
  methodStores,
  methodsInOrder,
  useMethodAccess,
  useMoneyStores,
  usePaymentMethodForm,
} from '../methods.js';
import { useQrisConnection } from '../qris-hooks.js';
import type { DrawerRow, PaymentAccountRow } from '../queries.js';
import { useMoneyQuery, useMoneyRuntime } from '../runtime.js';

import { MoneyDialog } from './parts.js';
import { QrisConnectSection } from './QrisConnect.js';

type Editing =
  | { readonly kind: 'add' }
  | { readonly kind: 'edit'; readonly account: PaymentAccountRow }
  | { readonly kind: 'drawer'; readonly drawer?: DrawerRow | undefined };

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
  const drawers = useMoneyQuery<readonly DrawerRow[]>(
    async (rt) => (await rt.query('drawers', { includeInactive: true })).rows,
    `drawers:${String(nonce)}`,
  );
  const roles = useMoneyRoles();
  const managesDrawers = useMayManageDrawers();
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
      <section className="flex flex-col gap-3" data-testid={`${testId}.drawers`}>
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-heading font-semibold text-text">{tm('money.drawers.title')}</h2>
          {managesDrawers ? (
            <Button
              label={tm('money.drawers.add')}
              icon={Plus}
              variant="secondary"
              onClick={() => {
                setNotice(null);
                setEditing({ kind: 'drawer' });
              }}
              data-testid={`${testId}.addDrawer`}
            />
          ) : null}
        </div>
        <QueryPanel query={drawers} onRetry={() => setNonce((n) => n + 1)}>
          {(rows) => (
            <div className="rounded-md border border-border bg-surface">
              <div
                aria-hidden
                className="grid grid-cols-[minmax(180px,2fr)_minmax(120px,1fr)_minmax(160px,2fr)_minmax(104px,auto)] gap-x-4 border-b border-border px-4 py-2 text-small font-semibold text-text-muted"
              >
                <span>{tm('money.methods.name')}</span>
                <span />
                <span>{tm('money.drawers.usedBy')}</span>
                <span />
              </div>
              <ul aria-label={tm('money.drawers.title')}>
                {drawersInOrder(rows).map((drawer) => (
                  <MethodRow
                    key={drawer.ref}
                    name={drawerLabel(drawer)}
                    kind={tm('money.method.cash')}
                    active={drawer.active}
                    usedAt={drawerUsers(drawer, roles)}
                    onOpen={
                      managesDrawers
                        ? () => {
                            setNotice(null);
                            setEditing({ kind: 'drawer', drawer });
                          }
                        : undefined
                    }
                    testId={`${testId}.drawer.${drawer.ref}`}
                  />
                ))}
              </ul>
            </div>
          )}
        </QueryPanel>
      </section>
      <h2 className="text-heading font-semibold text-text">{tm('money.methods.title')}</h2>
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
              {methodsInOrder(rows).map((account) => (
                <MethodRow
                  key={account.id}
                  name={account.name}
                  kind={tm(KIND_KEY[account.kind])}
                  active={account.active}
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
      {editing?.kind === 'drawer' ? (
        <DrawerDialog
          key={editing.drawer?.ref ?? 'new'}
          drawer={editing.drawer}
          onDone={(saved) => {
            setNotice(saved);
            setEditing(null);
          }}
          onClose={() => setEditing(null)}
        />
      ) : editing === null ? null : (
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
  name,
  kind,
  active,
  usedAt,
  onOpen,
  testId,
}: {
  readonly name: string;
  readonly kind: string;
  readonly active: boolean;
  readonly usedAt: string;
  readonly onOpen?: (() => void) | undefined;
  readonly testId: string;
}): React.JSX.Element {
  const cells = (
    <>
      <span
        className={[
          'min-w-0 break-words text-body font-semibold',
          active ? 'text-text' : 'text-text-muted',
        ].join(' ')}
      >
        {name}
      </span>
      <span className="text-body text-text-muted">{kind}</span>
      <span className="min-w-0 break-words text-body text-text-muted">{usedAt}</span>
      <span className="flex justify-end">
        {active ? null : <Chip label={tm('money.methods.inactive')} icon={CircleOff} />}
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
  // Xendit, for a QRIS method that exists (the server must know it before it can be connected).
  const runtime = useMoneyRuntime();
  const qrisPort = account?.kind === 'qris' ? runtime.qris : undefined;
  const xendit = useQrisConnection(qrisPort, account?.id ?? '');
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
      {qrisPort === undefined ? null : (
        <QrisConnectSection control={xendit} testId={`${testId}.qris`} />
      )}
    </MoneyDialog>
  );
}

function DrawerDialog({
  drawer,
  onDone,
  onClose,
}: {
  readonly drawer: DrawerRow | undefined;
  readonly onDone: (notice: string) => void;
  readonly onClose: () => void;
}): React.JSX.Element {
  const form = useDrawerForm(drawer);
  const testId = 'money.desk.drawerForm';
  return (
    <MoneyDialog
      title={tm(drawer === undefined ? 'money.drawers.addTitle' : 'money.drawers.editTitle')}
      runner={form.runner}
      dirty={form.dirty}
      onClose={onClose}
      submitLabel={tm('money.methods.save')}
      onSubmit={() => form.save(onDone, onClose)}
      size="md"
      testId={testId}
    >
      <TextField
        label={tm('money.methods.name')}
        placeholder={tm('money.drawers.namePlaceholder')}
        value={form.name}
        onChange={(event) => form.setName(event.target.value)}
        maxLength={MAX_ACCOUNT_NAME}
        error={form.tried && form.nameMissing ? tm('money.methods.nameRequired') : undefined}
        autoComplete="off"
        data-testid={`${testId}.name`}
      />
      <div className="flex flex-col gap-2" data-testid={`${testId}.users`}>
        <span className="text-small font-semibold text-text">{tm('money.drawers.usedBy')}</span>
        <Segmented
          options={[
            { value: 'all', label: tm('money.drawers.everyone') },
            { value: 'some', label: tm('money.drawers.someRoles') },
          ]}
          value={form.everyone ? 'all' : 'some'}
          onChange={(value) => form.setEveryone(value === 'all')}
          label={tm('money.drawers.usedBy')}
          testId={`${testId}.scope`}
        />
        {form.everyone ? null : (
          <>
            <div
              className="flex flex-wrap gap-2"
              role="group"
              aria-label={tm('money.drawers.someRoles')}
            >
              {form.roles.map((role) => (
                <ToggleChip
                  key={role.id}
                  label={role.name}
                  selected={form.picked.includes(role.id)}
                  onToggle={() => form.togglePicked(role.id)}
                  testId={`${testId}.role.${role.id}`}
                />
              ))}
            </div>
            {form.tried && form.noRole ? (
              // As a field's own error reads (TextField).
              <p
                role="alert"
                className="text-small text-danger"
                data-testid={`${testId}.roleError`}
              >
                {tm('money.drawers.roleRequired')}
              </p>
            ) : null}
          </>
        )}
        <p className="text-small text-text-muted">{tm('money.drawers.ownersHint')}</p>
      </div>
      {drawer === undefined || !form.switchable ? null : (
        <Switch
          label={tm('money.methods.active')}
          caption={tm('money.drawers.activeCaption')}
          checked={form.active}
          onChange={form.setActive}
          testId={`${testId}.active`}
        />
      )}
    </MoneyDialog>
  );
}
