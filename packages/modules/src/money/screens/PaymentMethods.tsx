/**
 * Metode pembayaran: the QRIS, EDC and bank accounts a store takes payments through (owner decision,
 * 2026-10-28). Cash is always there. A store owner adds the store's own; the business owner may add
 * one every store uses. A method is switched off rather than deleted, so its past payments keep
 * their name, and its kind never changes once payments may have gone through it.
 */
import {
  ConfirmSheet,
  EmptyState,
  Icon,
  ListRow,
  SegmentedControl,
  SwitchRow,
  TextInput,
  color,
  size,
  space,
  type,
  Text,
} from '@bolusi/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import type { DiscardGuard, StepBack } from '../../screen-kit/index.js';
import { useDiscardConfirm } from '../../screen-kit/screens/discard.js';
import { FlowScreen, QueryView, type ScreenChrome } from '../../screen-kit/screens/views.js';

import { MAX_ACCOUNT_NAME, PAYMENT_ACCOUNT_KINDS } from '../constants.js';
import { tm } from '../i18n.js';
import {
  KIND_KEY,
  methodSummary,
  methodsInOrder,
  useMethodAccess,
  useMoneyStores,
  usePaymentMethodForm,
} from '../methods.js';
import { useQrisConnection } from '../qris-hooks.js';
import type { PaymentAccountRow } from '../queries.js';
import { useMoneyQuery, useMoneyRuntime } from '../runtime.js';

import { QrisConnectSection } from './QrisConnect.js';

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
  const access = useMethodAccess();
  const stores = useMoneyStores();
  const [nonce, setNonce] = useState(0);
  const query = useMoneyQuery<readonly PaymentAccountRow[]>(
    async (rt) =>
      (await rt.query('paymentAccounts', { includeInactive: true, everyStore: access.central }))
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
            {methodsInOrder(rows).map((account) => {
              const editable = access.mayEdit(account);
              return (
                <ListRow
                  key={account.id}
                  primaryText={account.name}
                  secondaryText={methodSummary(account, stores)}
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
  const form = usePaymentMethodForm(account);
  const { runner, kind, name, active, central, everyStore, picked, stores: storeList } = form;
  // Xendit, for a QRIS method that exists (the server must know it before it can be connected).
  const runtime = useMoneyRuntime();
  const qrisPort = account?.kind === 'qris' ? runtime.qris : undefined;
  const xendit = useQrisConnection(qrisPort, account?.id ?? '');
  const [askDisconnect, setAskDisconnect] = useState(false);
  const discard = useDiscardConfirm({
    dirty: form.dirty,
    copy: {
      title: tm('money.discard.title'),
      message: tm('money.discard.message'),
      confirm: tm('money.discard.confirm'),
      keep: tm('money.discard.keep'),
    },
    onRegisterDiscardGuard,
    testID,
  });
  return (
    <FlowScreen
      chrome={chrome}
      title={tm(account === undefined ? 'money.methods.addTitle' : 'money.methods.editTitle')}
      onBack={() => discard.requestLeave(onCancel)}
      overlay={
        askDisconnect ? (
          <ConfirmSheet
            title={tm('money.qris.disconnectTitle')}
            message={tm('money.qris.disconnectMessage')}
            confirmLabel={tm('money.qris.disconnect')}
            cancelLabel={tm('money.qris.cancel')}
            onConfirm={() => {
              setAskDisconnect(false);
              void xendit.disconnect();
            }}
            onCancel={() => setAskDisconnect(false)}
            testID={`${testID}.qris.confirm`}
          />
        ) : (
          discard.overlay
        )
      }
      primaryLabel={tm('money.methods.save')}
      onPrimary={() => form.save(onDone, onCancel)}
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
              onChange={form.setKind}
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
          onChangeText={form.setName}
          maxLength={MAX_ACCOUNT_NAME}
          errorMessage={
            form.tried && form.nameMissing ? tm('money.methods.nameRequired') : undefined
          }
          testID={`${testID}.name`}
        />
        {form.choosesCentral ? (
          <SwitchRow
            label={tm('money.methods.allStores')}
            caption={tm('money.methods.allStoresCaption')}
            value={central}
            onValueChange={form.setCentral}
            testID={`${testID}.central`}
          />
        ) : null}
        {form.picksStores ? (
          <View testID={`${testID}.stores`}>
            <Text style={styles.label}>{tm('money.methods.usedAt')}</Text>
            <SegmentedControl
              options={[
                { value: 'all', label: tm('money.methods.central') },
                { value: 'some', label: tm('money.methods.someStores') },
              ]}
              value={everyStore ? 'all' : 'some'}
              onChange={(value) => form.setEveryStore(value === 'all')}
              testID={`${testID}.scope`}
            />
            {everyStore ? null : (
              <View style={styles.storeRows}>
                {storeList.map((store) => (
                  <ListRow
                    key={store.id}
                    primaryText={store.name}
                    checked={picked.includes(store.id)}
                    onPress={() => form.togglePicked(store.id)}
                    testID={`${testID}.store.${store.id}`}
                  />
                ))}
                {form.tried && form.noStore ? (
                  <View style={styles.errorRow} testID={`${testID}.storeError`}>
                    <Icon name="warning" size={size.iconChip} color={color.danger} />
                    <Text style={styles.error}>{tm('money.methods.storeRequired')}</Text>
                  </View>
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
            onValueChange={form.setActive}
            testID={`${testID}.active`}
          />
        )}
        {qrisPort === undefined ? null : (
          <QrisConnectSection
            control={xendit}
            onDisconnect={() => setAskDisconnect(true)}
            testID={`${testID}.qris`}
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
  // As a field's own error reads (TextInput).
  errorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: space.xs,
    marginHorizontal: space.lg,
  },
  error: { ...type.bodySm, color: color.danger, marginLeft: space.xs, flex: 1 },
});
