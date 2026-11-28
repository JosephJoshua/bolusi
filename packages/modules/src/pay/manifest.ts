// The `pay` module manifest: what the business pays its staff (product-scope.md, "Staff pay").
import { defineModule, type ModuleDefinition, type ModuleManifest } from '@bolusi/core';

import {
  payAdjustmentsTable,
  payAdvancesTable,
  payPayoutsTable,
  payRepaymentsTable,
  payStoreRatesTable,
  payTermsTable,
} from './applier.js';
import {
  adjustCommissionHandler,
  adjustCommissionInput,
  giveAdvanceHandler,
  giveAdvanceInput,
  payMonthHandler,
  payMonthInput,
  repayAdvanceHandler,
  repayAdvanceInput,
  setStoreCommissionHandler,
  setStoreCommissionInput,
  setTermsHandler,
  setTermsInput,
  voidAdvanceHandler,
  voidInput,
  voidPayoutHandler,
  voidPayoutInput,
  voidRepaymentHandler,
  writeOffAdvanceHandler,
  writeOffAdvanceInput,
} from './commands.js';
import { PAY_MODULE_ID, PAY_PERMISSION, PAY_TABLE } from './constants.js';
import { PAY_OPERATIONS } from './operations.js';
import { kasbonBalancesQuery, kasbonQuery, payPeopleQuery, payPersonQuery } from './queries.js';
import { PAY_REFUSALS } from './rules.js';
import type { PayDatabase } from './schema.js';

export const PAY_PERMISSIONS = {
  [PAY_PERMISSION.own]: {
    scope: 'store',
    isDangerous: false,
    description: 'Can see their own pay: salary, commission, kasbon and payouts.',
  },
  [PAY_PERMISSION.read]: {
    scope: 'store',
    isDangerous: false,
    description: "Can see everyone's salary, commission and payouts at the store.",
  },
  [PAY_PERMISSION.advances]: {
    scope: 'store',
    // Kasbon is money leaving the store on someone's word.
    isDangerous: true,
    decision: true,
    description: 'Can give staff a kasbon (an advance) and take repayments.',
  },
  [PAY_PERMISSION.pay]: {
    scope: 'store',
    isDangerous: true,
    decision: true,
    description: "Can pay staff their month's salary and commission.",
  },
  [PAY_PERMISSION.manage]: {
    scope: 'store',
    isDangerous: true,
    decision: true,
    description:
      'Can set staff salaries and commission rates, change commission by hand, cancel pay records and write off kasbon.',
  },
} as const;

const P = PAY_PERMISSION;

export const payModuleManifest = {
  id: PAY_MODULE_ID,

  operations: PAY_OPERATIONS,
  refusals: PAY_REFUSALS.reasons,

  // DDL lives in the client and server migrations, as for purchasing.
  projections: {
    tables: {
      [PAY_TABLE.terms]: payTermsTable,
      [PAY_TABLE.storeRates]: payStoreRatesTable,
      [PAY_TABLE.advances]: payAdvancesTable,
      [PAY_TABLE.repayments]: payRepaymentsTable,
      [PAY_TABLE.payouts]: payPayoutsTable,
      [PAY_TABLE.adjustments]: payAdjustmentsTable,
    },
  },

  permissions: PAY_PERMISSIONS,

  commands: {
    setTerms: { permission: P.manage, input: setTermsInput, handler: setTermsHandler },
    setStoreCommission: {
      permission: P.manage,
      input: setStoreCommissionInput,
      handler: setStoreCommissionHandler,
    },
    adjustCommission: {
      permission: P.manage,
      input: adjustCommissionInput,
      handler: adjustCommissionHandler,
    },
    giveAdvance: { permission: P.advances, input: giveAdvanceInput, handler: giveAdvanceHandler },
    repayAdvance: {
      permission: P.advances,
      input: repayAdvanceInput,
      handler: repayAdvanceHandler,
    },
    writeOffAdvance: {
      permission: P.manage,
      input: writeOffAdvanceInput,
      handler: writeOffAdvanceHandler,
    },
    voidAdvance: { permission: P.manage, input: voidInput, handler: voidAdvanceHandler },
    voidRepayment: { permission: P.advances, input: voidInput, handler: voidRepaymentHandler },
    payMonth: { permission: P.pay, input: payMonthInput, handler: payMonthHandler },
    voidPayout: { permission: P.manage, input: voidPayoutInput, handler: voidPayoutHandler },
  },

  queries: {
    payPeople: payPeopleQuery,
    payPerson: payPersonQuery,
    kasbon: kasbonQuery,
    kasbonBalances: kasbonBalancesQuery,
  },
} as const satisfies ModuleManifest<PayDatabase>;

export type PayModuleManifest = typeof payModuleManifest;
export type PayModule = ModuleDefinition<PayDatabase, PayModuleManifest>;

export const payModule: PayModule = defineModule<PayDatabase, PayModuleManifest>(payModuleManifest);
