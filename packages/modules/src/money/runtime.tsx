// The Kas screens' runtime port, the same pattern as repair: screens (phone, later the PC) read and
// write the ledger through the module's typed port and stay live as money syncs in.
import type { ReactNode } from 'react';

import type { ModulePort } from '@bolusi/core';

import {
  createRuntimeContext,
  useLiveQuery,
  type LiveSource,
  type QueryState,
} from '../screen-kit/index.js';

import type { MoneyModule } from './manifest.js';
import type { QrisPort } from './qris.js';

/** A store of the business, by name. */
export interface MoneyStore {
  readonly id: string;
  readonly name: string;
}

/** The ledger's port, and the business's stores a central payment method may be given to. */
export interface MoneyPort extends ModulePort<MoneyModule> {
  /** Every store of the business, as this device last heard; this store alone before then. */
  stores(): Promise<readonly MoneyStore[]>;
  /** QRIS through Xendit; absent on a device that cannot reach the server (a demo). */
  readonly qris?: QrisPort;
}

export interface MoneyRuntime extends MoneyPort, LiveSource {
  /** A colleague's name for "counted by"; null for someone this device does not know. */
  nameOf(userId: string): string | null;
  /**
   * The customer each document is for, by document id, from the module that owns it (a servisan's
   * customer). Documents it cannot name are left out, and the lists show only their label.
   */
  customersOf(
    documents: readonly { readonly kind: string; readonly id: string }[],
  ): Promise<ReadonlyMap<string, string>>;
}

const MoneyRuntimeContext = createRuntimeContext<MoneyRuntime>('money');

export function MoneyRuntimeProvider({
  runtime,
  children,
}: {
  readonly runtime: MoneyRuntime;
  readonly children: ReactNode;
}): React.JSX.Element {
  return <MoneyRuntimeContext.Provider runtime={runtime}>{children}</MoneyRuntimeContext.Provider>;
}

export const useMoneyRuntime = MoneyRuntimeContext.useRuntime;

/** A money read kept live across local and pulled changes (04 §7). */
export function useMoneyQuery<TData>(
  run: (runtime: MoneyRuntime) => Promise<TData>,
  key: string,
): QueryState<TData> {
  return useLiveQuery(useMoneyRuntime(), run, key);
}
