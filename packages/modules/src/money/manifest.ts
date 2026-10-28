// The `money` module manifest: the store's money ledger (product-scope.md, "Repair payments").
//
// Built by `createMoneyModule` from the document sources of the modules that charge customers, so
// the money rules can check a charge against its document without importing those modules. The
// one list (`ALL_MODULES`, src/index.ts) is where the sources are handed in.
import { defineModule, type ModuleDefinition, type ModuleManifest } from '@bolusi/core';

import { moneyAccountsTable, moneyEntriesTable, moneyLinesTable } from './applier.js';
import {
  adjustCashHandler,
  adjustCashInput,
  countCashHandler,
  countCashInput,
  moveCashHandler,
  moveCashInput,
  receivePaymentsHandler,
  receivePaymentsInput,
  reduceChargeHandler,
  reduceChargeInput,
  refundHandler,
  refundInput,
  saveAccountHandler,
  saveAccountInput,
  saveCentralAccountHandler,
  saveCentralAccountInput,
  voidPaymentHandler,
  voidPaymentInput,
} from './commands.js';
import { MONEY_MODULE_ID, MONEY_PERMISSION, MONEY_TABLE } from './constants.js';
import type { MoneyDocumentSources } from './documents.js';
import { createMoneyOperations } from './operations.js';
import {
  cashDrawerQuery,
  documentMoneyQuery,
  moneyEntriesQuery,
  openBalancesQuery,
  paymentAccountsQuery,
} from './queries.js';
import { MONEY_REFUSALS } from './rules.js';
import type { MoneyDatabase } from './schema.js';

function moneyManifest(sources: MoneyDocumentSources) {
  return {
    id: MONEY_MODULE_ID,

    operations: createMoneyOperations(sources),
    refusals: MONEY_REFUSALS.reasons,

    // DDL lives in the client and server migrations, as for repair.
    projections: {
      tables: {
        [MONEY_TABLE.accounts]: moneyAccountsTable,
        [MONEY_TABLE.entries]: moneyEntriesTable,
        [MONEY_TABLE.lines]: moneyLinesTable,
      },
    },

    permissions: {
      [MONEY_PERMISSION.read]: {
        scope: 'store',
        isDangerous: false,
        description:
          "Can see the store's money: payments, refunds, the cash drawer and unpaid bills.",
      },
      [MONEY_PERMISSION.receive]: {
        scope: 'store',
        isDangerous: false,
        description:
          'Can take payments from customers and give back what a customer paid beyond their bill.',
      },
      [MONEY_PERMISSION.refund]: {
        scope: 'store',
        // Money back beyond an overpayment, or a lower bill, is how cash goes missing.
        isDangerous: true,
        description: 'Can give customers money back and lower what a customer owes.',
      },
      [MONEY_PERMISSION.voidPayment]: {
        scope: 'store',
        isDangerous: true,
        description: 'Can cancel a payment that was recorded by mistake.',
      },
      [MONEY_PERMISSION.moveCash]: {
        scope: 'store',
        isDangerous: true,
        description:
          'Can take cash out of the drawer (for the owner, an expense, a bank deposit) or put cash in.',
      },
      [MONEY_PERMISSION.countCash]: {
        scope: 'store',
        isDangerous: false,
        description: 'Can count the cash drawer at closing.',
      },
      [MONEY_PERMISSION.adjustCash]: {
        scope: 'store',
        isDangerous: true,
        description: "Can settle a difference between the counted cash and the store's records.",
      },
      [MONEY_PERMISSION.manageAccounts]: {
        scope: 'store',
        isDangerous: true,
        description: "Can add and change the store's QRIS, card machine and bank accounts.",
      },
      [MONEY_PERMISSION.manageCentralAccounts]: {
        scope: 'tenant',
        isDangerous: true,
        description:
          'Can add and change the QRIS, card machine and bank accounts shared by stores.',
      },
    },

    commands: {
      saveAccount: {
        permission: MONEY_PERMISSION.manageAccounts,
        input: saveAccountInput,
        handler: saveAccountHandler,
      },
      saveCentralAccount: {
        permission: MONEY_PERMISSION.manageCentralAccounts,
        input: saveCentralAccountInput,
        handler: saveCentralAccountHandler,
      },
      receivePayments: {
        permission: MONEY_PERMISSION.receive,
        input: receivePaymentsInput,
        handler: receivePaymentsHandler,
      },
      voidPayment: {
        permission: MONEY_PERMISSION.voidPayment,
        input: voidPaymentInput,
        handler: voidPaymentHandler,
      },
      refund: {
        permission: MONEY_PERMISSION.receive,
        input: refundInput,
        handler: refundHandler,
      },
      reduceCharge: {
        permission: MONEY_PERMISSION.refund,
        input: reduceChargeInput,
        handler: reduceChargeHandler,
      },
      moveCash: {
        permission: MONEY_PERMISSION.moveCash,
        input: moveCashInput,
        handler: moveCashHandler,
      },
      countCash: {
        permission: MONEY_PERMISSION.countCash,
        input: countCashInput,
        handler: countCashHandler,
      },
      adjustCash: {
        permission: MONEY_PERMISSION.adjustCash,
        input: adjustCashInput,
        handler: adjustCashHandler,
      },
    },

    queries: {
      paymentAccounts: paymentAccountsQuery,
      documentMoney: documentMoneyQuery,
      cashDrawer: cashDrawerQuery,
      moneyEntries: moneyEntriesQuery,
      openBalances: openBalancesQuery,
    },
  } as const satisfies ModuleManifest<MoneyDatabase>;
}

export type MoneyModuleManifest = ReturnType<typeof moneyManifest>;
export type MoneyModule = ModuleDefinition<MoneyDatabase, MoneyModuleManifest>;

/** The `money` module, checking charges against these document sources. */
export function createMoneyModule(sources: MoneyDocumentSources): MoneyModule {
  return defineModule<MoneyDatabase, MoneyModuleManifest>(moneyManifest(sources));
}
