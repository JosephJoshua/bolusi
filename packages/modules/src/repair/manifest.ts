// The `repair` module manifest: the digital repair ticket (product-scope.md, slice 1).
import { defineModule, type ModuleDefinition, type ModuleManifest } from '@bolusi/core';

import {
  repairCustomersTable,
  repairIntakeOptionsTable,
  repairStoreCancelFeesTable,
  repairStoreIntakeOptionsTable,
  repairStorePrintSettingsTable,
  repairStoreUncollectedTable,
  repairQuoteLinesTable,
  repairTicketEventsTable,
  repairTicketPhotosTable,
  repairTicketsTable,
} from './applier.js';
import {
  applyProposalHandler,
  applyProposalInput,
  assignTechnicianHandler,
  assignTechnicianInput,
  cancelTicketHandler,
  cancelTicketInput,
  changeIntakeOptionsHandler,
  changeIntakeOptionsInput,
  hideIntakeOptionsHandler,
  hideIntakeOptionsInput,
  changeQuoteHandler,
  changeQuoteInput,
  claimTicketHandler,
  claimTicketInput,
  correctCustomerDetailsHandler,
  correctCustomerDetailsInput,
  correctDownPaymentHandler,
  correctDownPaymentInput,
  declineProposalHandler,
  declineProposalInput,
  markRepairedHandler,
  markRepairedInput,
  markWaitingForPartsHandler,
  markWaitingForPartsInput,
  openTicketHandler,
  openTicketInput,
  proposeQuoteChangeHandler,
  proposeQuoteChangeInput,
  recordDownPaymentHandler,
  recordDownPaymentInput,
  recordSlipPrintedHandler,
  recordSlipPrintedInput,
  registerCustomerHandler,
  registerCustomerInput,
  returnDeviceHandler,
  returnDeviceInput,
  setCancelFeesHandler,
  setCancelFeesInput,
  setPrintSettingsHandler,
  setPrintSettingsInput,
  setUncollectedDaysHandler,
  setUncollectedDaysInput,
  startWorkHandler,
  startWorkInput,
} from './commands.js';
import { REPAIR_MODULE_ID, REPAIR_PERMISSION, REPAIR_TABLE } from './constants.js';
import { findDeviceModelQuery, searchDeviceModelsQuery } from './device-models.js';
import { REPAIR_REFUSALS } from './rules.js';
import { repairOperations } from './operations.js';
import {
  cancelFeesQuery,
  countTicketsQuery,
  getCustomerQuery,
  getTicketQuery,
  intakeOptionSettingsQuery,
  listTicketsQuery,
  technicianLoadsQuery,
  nextTicketCounterQuery,
  printSettingsQuery,
  searchCustomersQuery,
  searchTicketsQuery,
  ticketBrandsQuery,
  uncollectedDaysQuery,
} from './queries.js';
import type { RepairDatabase } from './schema.js';

export const repairModuleManifest = {
  id: REPAIR_MODULE_ID,

  operations: repairOperations,
  refusals: REPAIR_REFUSALS.reasons,

  // DDL lives in the client and server migrations, as for notes.
  projections: {
    tables: {
      [REPAIR_TABLE.customers]: repairCustomersTable,
      [REPAIR_TABLE.tickets]: repairTicketsTable,
      [REPAIR_TABLE.quoteLines]: repairQuoteLinesTable,
      [REPAIR_TABLE.photos]: repairTicketPhotosTable,
      [REPAIR_TABLE.events]: repairTicketEventsTable,
      [REPAIR_TABLE.intakeOptions]: repairIntakeOptionsTable,
      [REPAIR_TABLE.storeIntakeOptions]: repairStoreIntakeOptionsTable,
      [REPAIR_TABLE.storeCancelFees]: repairStoreCancelFeesTable,
      [REPAIR_TABLE.storePrintSettings]: repairStorePrintSettingsTable,
      [REPAIR_TABLE.storeUncollected]: repairStoreUncollectedTable,
    },
  },

  permissions: {
    [REPAIR_PERMISSION.read]: {
      scope: 'store',
      isDangerous: false,
      description: "Can see the store's repair tickets and customers.",
    },
    [REPAIR_PERMISSION.intake]: {
      scope: 'store',
      isDangerous: false,
      description: 'Can take in devices for repair, register customers and correct their details.',
    },
    [REPAIR_PERMISSION.work]: {
      scope: 'store',
      isDangerous: false,
      description:
        'Can take repair tickets from the queue, update repair progress and propose price changes.',
    },
    [REPAIR_PERMISSION.assign]: {
      scope: 'store',
      isDangerous: false,
      description: 'Can assign repair tickets to technicians.',
    },
    [REPAIR_PERMISSION.quoteChange]: {
      scope: 'store',
      isDangerous: true,
      description:
        "Can change a repair's price after intake and accept or decline technicians' proposals.",
    },
    [REPAIR_PERMISSION.cancel]: {
      scope: 'store',
      // Cancelling was how counter staff kept a customer's cash, so only owners hold it.
      isDangerous: true,
      description:
        'Can cancel a repair and set what the customer pays for it. The device stays in the store until it is handed back.',
    },
    [REPAIR_PERMISSION.handover]: {
      scope: 'store',
      isDangerous: false,
      description: 'Can hand a device back to its customer, with a photo and signature.',
    },
    [REPAIR_PERMISSION.manageIntakeOptions]: {
      scope: 'tenant',
      isDangerous: false,
      description:
        'Can change the checks, accessories, photos, brands and ready-by choices every store uses at intake.',
    },
    [REPAIR_PERMISSION.hideIntakeOptions]: {
      scope: 'store',
      isDangerous: false,
      description:
        "Can hide intake checks, accessories, photos, brands and ready-by choices the store doesn't use.",
    },
    [REPAIR_PERMISSION.discount]: {
      scope: 'store',
      isDangerous: true,
      description: "Can lower a repair's price with a discount, at intake or later.",
    },
    [REPAIR_PERMISSION.setCancelFees]: {
      scope: 'store',
      isDangerous: false,
      description: "Can set the store's cancellation fees, before and after work starts.",
    },
    [REPAIR_PERMISSION.correctDownPayment]: {
      scope: 'store',
      // Recording less than the customer paid is how a down payment would go missing.
      isDangerous: true,
      description: 'Can change or remove a down payment already recorded on a repair.',
    },
    [REPAIR_PERMISSION.setPrintSettings]: {
      scope: 'store',
      isDangerous: false,
      description: "Can change the store's name, address, logo and terms printed on repair slips.",
    },
    [REPAIR_PERMISSION.setUncollectedDays]: {
      scope: 'store',
      isDangerous: false,
      description:
        'Can set after how many days a repaired or cancelled phone nobody collected is flagged.',
    },
  },

  commands: {
    registerCustomer: {
      permission: REPAIR_PERMISSION.intake,
      input: registerCustomerInput,
      handler: registerCustomerHandler,
    },
    correctCustomerDetails: {
      permission: REPAIR_PERMISSION.intake,
      input: correctCustomerDetailsInput,
      handler: correctCustomerDetailsHandler,
    },
    openTicket: {
      permission: REPAIR_PERMISSION.intake,
      input: openTicketInput,
      handler: openTicketHandler,
    },
    claimTicket: {
      permission: REPAIR_PERMISSION.work,
      input: claimTicketInput,
      handler: claimTicketHandler,
    },
    assignTechnician: {
      permission: REPAIR_PERMISSION.assign,
      input: assignTechnicianInput,
      handler: assignTechnicianHandler,
    },
    startWork: {
      permission: REPAIR_PERMISSION.work,
      input: startWorkInput,
      handler: startWorkHandler,
    },
    markWaitingForParts: {
      permission: REPAIR_PERMISSION.work,
      input: markWaitingForPartsInput,
      handler: markWaitingForPartsHandler,
    },
    markRepaired: {
      permission: REPAIR_PERMISSION.work,
      input: markRepairedInput,
      handler: markRepairedHandler,
    },
    cancelTicket: {
      permission: REPAIR_PERMISSION.cancel,
      input: cancelTicketInput,
      handler: cancelTicketHandler,
    },
    proposeQuoteChange: {
      permission: REPAIR_PERMISSION.work,
      input: proposeQuoteChangeInput,
      handler: proposeQuoteChangeHandler,
    },
    changeQuote: {
      permission: REPAIR_PERMISSION.quoteChange,
      input: changeQuoteInput,
      handler: changeQuoteHandler,
    },
    applyProposal: {
      permission: REPAIR_PERMISSION.quoteChange,
      input: applyProposalInput,
      handler: applyProposalHandler,
    },
    declineProposal: {
      permission: REPAIR_PERMISSION.quoteChange,
      input: declineProposalInput,
      handler: declineProposalHandler,
    },
    returnDevice: {
      permission: REPAIR_PERMISSION.handover,
      input: returnDeviceInput,
      handler: returnDeviceHandler,
    },
    changeIntakeOptions: {
      permission: REPAIR_PERMISSION.manageIntakeOptions,
      input: changeIntakeOptionsInput,
      handler: changeIntakeOptionsHandler,
    },
    hideIntakeOptions: {
      permission: REPAIR_PERMISSION.hideIntakeOptions,
      input: hideIntakeOptionsInput,
      handler: hideIntakeOptionsHandler,
    },
    setCancelFees: {
      permission: REPAIR_PERMISSION.setCancelFees,
      input: setCancelFeesInput,
      handler: setCancelFeesHandler,
    },
    recordDownPayment: {
      permission: REPAIR_PERMISSION.intake,
      input: recordDownPaymentInput,
      handler: recordDownPaymentHandler,
    },
    correctDownPayment: {
      permission: REPAIR_PERMISSION.correctDownPayment,
      input: correctDownPaymentInput,
      handler: correctDownPaymentHandler,
    },
    recordSlipPrinted: {
      permission: REPAIR_PERMISSION.read,
      input: recordSlipPrintedInput,
      handler: recordSlipPrintedHandler,
    },
    setPrintSettings: {
      permission: REPAIR_PERMISSION.setPrintSettings,
      input: setPrintSettingsInput,
      handler: setPrintSettingsHandler,
    },
    setUncollectedDays: {
      permission: REPAIR_PERMISSION.setUncollectedDays,
      input: setUncollectedDaysInput,
      handler: setUncollectedDaysHandler,
    },
  },

  queries: {
    listTickets: listTicketsQuery,
    countTickets: countTicketsQuery,
    ticketBrands: ticketBrandsQuery,
    searchTickets: searchTicketsQuery,
    getTicket: getTicketQuery,
    searchCustomers: searchCustomersQuery,
    getCustomer: getCustomerQuery,
    nextTicketCounter: nextTicketCounterQuery,
    technicianLoads: technicianLoadsQuery,
    intakeOptionSettings: intakeOptionSettingsQuery,
    searchDeviceModels: searchDeviceModelsQuery,
    findDeviceModel: findDeviceModelQuery,
    cancelFees: cancelFeesQuery,
    printSettings: printSettingsQuery,
    uncollectedDays: uncollectedDaysQuery,
  },
} as const satisfies ModuleManifest<RepairDatabase>;

export const repairModule: ModuleDefinition<RepairDatabase, typeof repairModuleManifest> =
  defineModule<RepairDatabase, typeof repairModuleManifest>(repairModuleManifest);
