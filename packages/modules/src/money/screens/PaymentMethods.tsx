/**
 * Metode pembayaran: the QRIS, EDC and bank accounts a store takes payments through (owner decision,
 * 2026-10-28). Cash is always there. A store owner adds the store's own; the business owner may add
 * one every store uses. A method is switched off rather than deleted, so its past payments keep
 * their name, and its kind never changes once payments may have gone through it.
 */
import {
  EmptyState,
  ListRow,
  SegmentedControl,
  SwitchRow,
  TextInput,
  color,
  space,
  type,
} from '@bolusi/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useActionRunner, type DiscardGuard, type StepBack } from '../../screen-kit/index.js';
import { useDiscardConfirm } from '../../screen-kit/screens/discard.js';
import { FlowScreen, QueryView, type ScreenChrome } from '../../screen-kit/screens/views.js';

import {
  MAX_ACCOUNT_NAME,
  MONEY_PERMISSION,
  PAYMENT_ACCOUNT_KINDS,
  type PaymentAccountKind,
} from '../constants.js';
import { tm, type MoneyKey } from '../i18n.js';
import type { PaymentAccountRow } from '../queries.js';
import { useMoneyQuery, useMoneyRuntime } from '../runtime.js';

const KIND_KEY: Readonly<Record<PaymentAccountKind, MoneyKey>> = {
  qris: 'money.kind.qris',
  edc: 'money.kind.edc',
  transfer: 'money.kind.transfer',
};

/** "QRIS · Semua toko · Tidak dipakai". */
function methodSummary(account: PaymentAccountRow): string {
  return [
    tm(KIND_KEY[account.kind]),
    // A franchise method given to some stores only is the head office's, not every store's.
    account.central
      ? account.storeIds.length === 0
        ? tm('money.methods.central')
        : tm('money.methods.storeCount', { count: account.storeIds.length })
      : '',
    account.active ? '' : tm('money.methods.inactive'),
  ]
    .filter((part) => part !== '')
    .join(' · ');
}

type MethodsView =
  { readonly kind: 'list' } | { readonly kind: 'form'; readonly account?: PaymentAccountRow };

export interface PaymentMethodsSurfaceProps {
  readonly chrome: ScreenChrome;
  readonly onClose: () => void;
  /** Back inside the surface: closes the form first. */
  readonly onRegisterStepBack?: ((back: StepBack | null) => void) | undefined;
  readonly onRegisterDiscardGuard?: ((guard: DiscardGuard | null) => void) | undefined;
}

export function PaymentMethodsSurface({
  chrome,
  onClose,
  onRegisterStepBack,
  onRegisterDiscardGuard,
}: PaymentMethodsSurfaceProps): React.JSX.Element {
  const [view, setView] = useState<MethodsView>({ kind: 'list' });
  const [notice, setNotice] = useState<string | null>(null);
  const guardRef = useRef<DiscardGuard | null>(null);
  const registerGuard = useCallback(
    (guard: DiscardGuard | null): void => {
      guardRef.current = guard;
      onRegisterDiscardGuard?.(guard);
    },
    [onRegisterDiscardGuard],
  );

  const back = useCallback((): boolean => {
    if (view.kind === 'list') return false;
    const guard = guardRef.current;
    if (guard === null) setView({ kind: 'list' });
    else guard(() => setView({ kind: 'list' }));
    return true;
  }, [view]);

  useEffect(() => {
    onRegisterStepBack?.(back);
    return () => onRegisterStepBack?.(null);
  }, [back, onRegisterStepBack]);

  if (view.kind === 'form') {
    return (
      <PaymentMethodForm
        chrome={chrome}
        account={view.account}
        onDone={(saved) => {
          setNotice(saved);
          setView({ kind: 'list' });
        }}
        onCancel={() => setView({ kind: 'list' })}
        onRegisterDiscardGuard={registerGuard}
      />
    );
  }
  return (
    <PaymentMethodList
      chrome={chrome}
      onBack={onClose}
      onOpen={(account) => {
        setNotice(null);
        setView({ kind: 'form', account });
      }}
      onAdd={() => {
        setNotice(null);
        setView({ kind: 'form' });
      }}
      notice={notice}
      onClearNotice={() => setNotice(null)}
    />
  );
}

// ── the list ───────────────────────────────────────────────────────────────────────────────────

export interface PaymentMethodListProps {
  readonly chrome: ScreenChrome;
  readonly onBack: () => void;
  readonly onOpen: (account: PaymentAccountRow) => void;
  readonly onAdd: () => void;
  readonly notice?: string | null | undefined;
  readonly onClearNotice?: (() => void) | undefined;
  readonly testID?: string | undefined;
}

export function PaymentMethodList({
  chrome,
  onBack,
  onOpen,
  onAdd,
  notice,
  onClearNotice,
  testID = 'money.methods',
}: PaymentMethodListProps): React.JSX.Element {
  const runtime = useMoneyRuntime();
  const mayEditStore = runtime.hasPermission(MONEY_PERMISSION.manageAccounts);
  const mayEditCentral = runtime.hasPermission(MONEY_PERMISSION.manageCentralAccounts);
  const [nonce, setNonce] = useState(0);
  const query = useMoneyQuery<readonly PaymentAccountRow[]>(
    async (rt) =>
      (await rt.query('paymentAccounts', { includeInactive: true, everyStore: mayEditCentral }))
        .rows,
    `methods:${String(nonce)}`,
  );
  return (
    <FlowScreen
      chrome={chrome}
      title={tm('money.methods.title')}
      onBack={onBack}
      primaryLabel={tm('money.methods.add')}
      onPrimary={onAdd}
      notice={notice}
      onClearNotice={onClearNotice}
      busy={false}
      errorCode={null}
      onClearError={() => undefined}
      testID={testID}
    >
      <QueryView
        query={query}
        onBack={onBack}
        onRetry={() => setNonce((n) => n + 1)}
        testID={testID}
      >
        {(rows) => (
          <View style={styles.list}>
            <ListRow
              primaryText={tm('money.method.cash')}
              secondaryText={tm('money.methods.cashAlways')}
              testID={`${testID}.cash`}
            />
            {/* Switched-off ones last: they are kept for the payments made through them. */}
            {[...rows.filter((a) => a.active), ...rows.filter((a) => !a.active)].map((account) => {
              const editable = account.central ? mayEditCentral : mayEditStore;
              return (
                <ListRow
                  key={account.id}
                  primaryText={account.name}
                  secondaryText={methodSummary(account)}
                  showChevron={editable}
                  onPress={editable ? () => onOpen(account) : undefined}
                  testID={`${testID}.row.${account.id}`}
                />
              );
            })}
            {rows.length === 0 ? (
              <EmptyState
                title={tm('money.methods.none')}
                hint={tm('money.methods.noneHint')}
                testID={`${testID}.empty`}
              />
            ) : null}
          </View>
        )}
      </QueryView>
    </FlowScreen>
  );
}

// ── add or edit one ────────────────────────────────────────────────────────────────────────────

export interface PaymentMethodFormProps {
  readonly chrome: ScreenChrome;
  /** The method being edited; absent to add one. */
  readonly account?: PaymentAccountRow | undefined;
  /** Saved, with the notice the list shows. */
  readonly onDone: (notice: string) => void;
  readonly onCancel: () => void;
  readonly onRegisterDiscardGuard?: ((guard: DiscardGuard | null) => void) | undefined;
  readonly testID?: string | undefined;
}

export function PaymentMethodForm({
  chrome,
  account,
  onDone,
  onCancel,
  onRegisterDiscardGuard,
  testID = 'money.methodForm',
}: PaymentMethodFormProps): React.JSX.Element {
  const runtime = useMoneyRuntime();
  const runner = useActionRunner();
  const mayStore = runtime.hasPermission(MONEY_PERMISSION.manageAccounts);
  const mayCentral = runtime.hasPermission(MONEY_PERMISSION.manageCentralAccounts);
  const [kind, setKind] = useState<PaymentAccountKind>(account?.kind ?? 'qris');
  const [name, setName] = useState(account?.name ?? '');
  const [active, setActive] = useState(account?.active ?? true);
  // Someone who manages only the franchise's methods adds franchise ones.
  const [central, setCentral] = useState(account?.central ?? !mayStore);
  // A central method is every store's unless it names some: none named means all of them.
  const [picked, setPicked] = useState<readonly string[]>(account?.storeIds ?? []);
  const [everyStore, setEveryStore] = useState((account?.storeIds.length ?? 0) === 0);
  const [tried, setTried] = useState(false);
  const stores = useMoneyQuery((rt) => rt.stores(), 'stores');
  const storeList = stores.status === 'ready' ? stores.data : [];
  // One store has nothing to pick between.
  const picksStores = central && mayCentral && storeList.length > 1;
  const storeIds = everyStore ? [] : [...picked].sort();

  const dirty =
    account === undefined
      ? name.trim() !== ''
      : name.trim() !== account.name ||
        active !== account.active ||
        storeIds.join() !== [...account.storeIds].sort().join();
  const discard = useDiscardConfirm({
    dirty,
    copy: {
      title: tm('money.discard.title'),
      message: tm('money.discard.message'),
      confirm: tm('money.discard.confirm'),
      keep: tm('money.discard.keep'),
    },
    onRegisterDiscardGuard,
    testID,
  });
  const nameMissing = name.trim() === '';
  const noStore = picksStores && !everyStore && picked.length === 0;

  const save = (): void => {
    setTried(true);
    if (nameMissing || noStore) return;
    if (account !== undefined && !dirty) {
      onCancel();
      return;
    }
    const fields = {
      ...(account === undefined ? {} : { accountId: account.id }),
      kind,
      name: name.trim(),
      active,
    };
    void runner
      .run(() =>
        central
          ? runtime.run('saveCentralAccount', { ...fields, storeIds })
          : runtime.run('saveAccount', fields),
      )
      .then((result) => {
        if (result !== undefined) onDone(tm('money.methods.saved', { name: name.trim() }));
      });
  };

  return (
    <FlowScreen
      chrome={chrome}
      title={tm(account === undefined ? 'money.methods.addTitle' : 'money.methods.editTitle')}
      onBack={() => discard.requestLeave(onCancel)}
      overlay={discard.overlay}
      primaryLabel={tm('money.methods.save')}
      onPrimary={save}
      busy={runner.busy}
      errorCode={runner.errorCode}
      onClearError={runner.clearError}
      testID={testID}
    >
      <View style={styles.groups}>
        {account === undefined ? (
          <View>
            <Text style={styles.label}>{tm('money.methods.kind')}</Text>
            <SegmentedControl
              options={PAYMENT_ACCOUNT_KINDS.map((value) => ({
                value,
                label: tm(KIND_KEY[value]),
              }))}
              value={kind}
              onChange={setKind}
              testID={`${testID}.kind`}
            />
          </View>
        ) : (
          <View>
            <Text style={styles.label}>{tm('money.methods.kind')}</Text>
            <Text style={styles.value} testID={`${testID}.kind`}>
              {tm(KIND_KEY[kind])}
            </Text>
          </View>
        )}
        <TextInput
          label={tm('money.methods.name')}
          placeholder={tm('money.methods.namePlaceholder')}
          value={name}
          onChangeText={setName}
          maxLength={MAX_ACCOUNT_NAME}
          errorMessage={tried && nameMissing ? tm('money.methods.nameRequired') : undefined}
          testID={`${testID}.name`}
        />
        {account === undefined && mayStore && mayCentral ? (
          <SwitchRow
            label={tm('money.methods.allStores')}
            caption={tm('money.methods.allStoresCaption')}
            value={central}
            onValueChange={setCentral}
            testID={`${testID}.central`}
          />
        ) : null}
        {picksStores ? (
          <View testID={`${testID}.stores`}>
            <Text style={styles.label}>{tm('money.methods.usedAt')}</Text>
            <SegmentedControl
              options={[
                { value: 'all', label: tm('money.methods.central') },
                { value: 'some', label: tm('money.methods.someStores') },
              ]}
              value={everyStore ? 'all' : 'some'}
              onChange={(value) => setEveryStore(value === 'all')}
              testID={`${testID}.scope`}
            />
            {everyStore ? null : (
              <View style={styles.storeRows}>
                {storeList.map((store) => (
                  <ListRow
                    key={store.id}
                    primaryText={store.name}
                    checked={picked.includes(store.id)}
                    onPress={() =>
                      setPicked((current) =>
                        current.includes(store.id)
                          ? current.filter((id) => id !== store.id)
                          : [...current, store.id],
                      )
                    }
                    testID={`${testID}.store.${store.id}`}
                  />
                ))}
                {tried && noStore ? (
                  <Text style={styles.error}>{tm('money.methods.storeRequired')}</Text>
                ) : null}
              </View>
            )}
          </View>
        ) : null}
        {account === undefined ? null : (
          <SwitchRow
            label={tm('money.methods.active')}
            caption={tm('money.methods.activeCaption')}
            value={active}
            onValueChange={setActive}
            testID={`${testID}.active`}
          />
        )}
      </View>
    </FlowScreen>
  );
}

const styles = StyleSheet.create({
  list: { marginHorizontal: -space.lg },
  groups: { gap: space.lg },
  label: { ...type.caption, color: color.textMuted, marginBottom: space.xs },
  value: { ...type.body, color: color.text },
  storeRows: { marginTop: space.sm, marginHorizontal: -space.lg },
  error: { ...type.caption, color: color.danger, marginTop: space.xs, marginHorizontal: space.lg },
});
