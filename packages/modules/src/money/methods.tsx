// Metode pembayaran, shared by the phone and the PC: how a method reads in the list, and the add or
// edit form's state and save, so both clients ask for and send the same thing.
import { useState } from 'react';

import { useActionRunner, type ActionRunner } from '../screen-kit/index.js';

import { MONEY_PERMISSION, type PaymentAccountKind } from './constants.js';
import { tm, type MoneyKey } from './i18n.js';
import type { PaymentAccountRow } from './queries.js';
import { useMoneyQuery, useMoneyRuntime, type MoneyStore } from './runtime.js';

export const KIND_KEY: Readonly<Record<PaymentAccountKind, MoneyKey>> = {
  qris: 'money.kind.qris',
  edc: 'money.kind.edc',
  transfer: 'money.kind.transfer',
};

/** Which stores a head-office method is for: "Semua toko", or the stores it names. */
export function methodStores(account: PaymentAccountRow, stores: readonly MoneyStore[]): string {
  if (account.storeIds.length === 0) return tm('money.methods.central');
  const names = account.storeIds.map((id) => stores.find((store) => store.id === id)?.name);
  // A store this device has not heard of yet: the count, rather than a list missing one.
  return names.every((name) => name !== undefined)
    ? names.join(', ')
    : tm('money.methods.storeCount', { count: account.storeIds.length });
}

/** "QRIS · Sorong, Manokwari · Tidak dipakai". */
export function methodSummary(account: PaymentAccountRow, stores: readonly MoneyStore[]): string {
  return [
    tm(KIND_KEY[account.kind]),
    account.central ? methodStores(account, stores) : '',
    account.active ? '' : tm('money.methods.inactive'),
  ]
    .filter((part) => part !== '')
    .join(' · ');
}

/** Switched-off ones last: they are kept for the payments made through them. */
export function methodsInOrder(rows: readonly PaymentAccountRow[]): PaymentAccountRow[] {
  return [...rows.filter((row) => row.active), ...rows.filter((row) => !row.active)];
}

/** Whether this person may change a method: the store's own, or the head office's. */
export function useMethodAccess(): {
  readonly store: boolean;
  readonly central: boolean;
  readonly mayEdit: (account: PaymentAccountRow) => boolean;
} {
  const runtime = useMoneyRuntime();
  const store = runtime.hasPermission(MONEY_PERMISSION.manageAccounts);
  const central = runtime.hasPermission(MONEY_PERMISSION.manageCentralAccounts);
  return { store, central, mayEdit: (account) => (account.central ? central : store) };
}

/** The business's stores, as this device last heard; empty while they load. */
export function useMoneyStores(): readonly MoneyStore[] {
  const stores = useMoneyQuery((rt) => rt.stores(), 'stores');
  return stores.status === 'ready' ? stores.data : [];
}

export interface PaymentMethodForm {
  readonly runner: ActionRunner;
  readonly kind: PaymentAccountKind;
  readonly setKind: (kind: PaymentAccountKind) => void;
  readonly name: string;
  readonly setName: (name: string) => void;
  readonly active: boolean;
  readonly setActive: (active: boolean) => void;
  /** A head-office method rather than this store's. */
  readonly central: boolean;
  readonly setCentral: (central: boolean) => void;
  /** Whether the person may choose between the two: a new method, with both rights. */
  readonly choosesCentral: boolean;
  /** For every store, or only `picked`. */
  readonly everyStore: boolean;
  readonly setEveryStore: (everyStore: boolean) => void;
  readonly picked: readonly string[];
  readonly togglePicked: (storeId: string) => void;
  readonly stores: readonly MoneyStore[];
  /** Whether the stores are offered: a head-office method, in a business of more than one. */
  readonly picksStores: boolean;
  readonly dirty: boolean;
  /** A save was tried, so what is missing shows. */
  readonly tried: boolean;
  readonly nameMissing: boolean;
  readonly noStore: boolean;
  /** Saves it; `onDone` gets the notice to show. Nothing changed on an edit just closes it. */
  readonly save: (onDone: (notice: string) => void, onUnchanged: () => void) => void;
}

/** The add or edit form for one method; `account` absent to add one. */
export function usePaymentMethodForm(account: PaymentAccountRow | undefined): PaymentMethodForm {
  const runtime = useMoneyRuntime();
  const runner = useActionRunner();
  const access = useMethodAccess();
  const [kind, setKind] = useState<PaymentAccountKind>(account?.kind ?? 'qris');
  const [name, setName] = useState(account?.name ?? '');
  const [active, setActive] = useState(account?.active ?? true);
  // Someone who manages only the franchise's methods adds franchise ones.
  const [central, setCentral] = useState(account?.central ?? !access.store);
  // A central method is every store's unless it names some: none named means all of them.
  const [picked, setPicked] = useState<readonly string[]>(account?.storeIds ?? []);
  const [everyStore, setEveryStore] = useState((account?.storeIds.length ?? 0) === 0);
  const [tried, setTried] = useState(false);
  const stores = useMoneyStores();
  // One store has nothing to pick between.
  const picksStores = central && access.central && stores.length > 1;
  const storeIds = everyStore ? [] : [...picked].sort();

  const dirty =
    account === undefined
      ? name.trim() !== ''
      : name.trim() !== account.name ||
        active !== account.active ||
        storeIds.join() !== [...account.storeIds].sort().join();
  const nameMissing = name.trim() === '';
  const noStore = picksStores && !everyStore && picked.length === 0;

  const save = (onDone: (notice: string) => void, onUnchanged: () => void): void => {
    setTried(true);
    if (nameMissing || noStore) return;
    if (account !== undefined && !dirty) {
      onUnchanged();
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

  return {
    runner,
    kind,
    setKind,
    name,
    setName,
    active,
    setActive,
    central,
    setCentral,
    choosesCentral: account === undefined && access.store && access.central,
    everyStore,
    setEveryStore,
    picked,
    togglePicked: (storeId) =>
      setPicked((current) =>
        current.includes(storeId) ? current.filter((id) => id !== storeId) : [...current, storeId],
      ),
    stores,
    picksStores,
    dirty,
    tried,
    nameMissing,
    noStore,
    save,
  };
}
