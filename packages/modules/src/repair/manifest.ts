// The `repair` module manifest: the digital repair ticket (product-scope.md, slice 1).
import { defineModule, type ModuleDefinition, type ModuleManifest } from '@bolusi/core';

import {
  repairCustomersTable,
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
  changeQuoteHandler,
  changeQuoteInput,
  claimTicketHandler,
  claimTicketInput,
  correctCustomerDetailsHandler,
  correctCustomerDetailsInput,
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
  registerCustomerHandler,
  registerCustomerInput,
  returnDeviceHandler,
  returnDeviceInput,
  startWorkHandler,
  startWorkInput,
} from './commands.js';
import { REPAIR_MODULE_ID, REPAIR_PERMISSION, REPAIR_TABLE } from './constants.js';
import { findDeviceModelQuery, searchDeviceModelsQuery } from './device-models.js';
import { repairOperations } from './operations.js';
import {
  getCustomerQuery,
  getTicketQuery,
  listTicketsQuery,
  technicianLoadsQuery,
  nextTicketCounterQuery,
  searchCustomersQuery,
  searchTicketsQuery,
} from './queries.js';
import type { RepairDatabase } from './schema.js';

export const repairModuleManifest = {
  id: REPAIR_MODULE_ID,

  operations: repairOperations,

  // DDL lives in the client and server migrations, as for notes.
  projections: {
    tables: {
      [REPAIR_TABLE.customers]: repairCustomersTable,
      [REPAIR_TABLE.tickets]: repairTicketsTable,
      [REPAIR_TABLE.quoteLines]: repairQuoteLinesTable,
      [REPAIR_TABLE.photos]: repairTicketPhotosTable,
      [REPAIR_TABLE.events]: repairTicketEventsTable,
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
      isDangerous: false,
      description: 'Can cancel a repair. The device stays in the store until it is handed back.',
    },
    [REPAIR_PERMISSION.handover]: {
      scope: 'store',
      isDangerous: false,
      description: 'Can hand a device back to its customer, with a photo and signature.',
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
  },

  queries: {
    listTickets: listTicketsQuery,
    searchTickets: searchTicketsQuery,
    getTicket: getTicketQuery,
    searchCustomers: searchCustomersQuery,
    getCustomer: getCustomerQuery,
    nextTicketCounter: nextTicketCounterQuery,
    technicianLoads: technicianLoadsQuery,
    searchDeviceModels: searchDeviceModelsQuery,
    findDeviceModel: findDeviceModelQuery,
  },
} as const satisfies ModuleManifest<RepairDatabase>;

export const repairModule: ModuleDefinition<RepairDatabase, typeof repairModuleManifest> =
  defineModule<RepairDatabase, typeof repairModuleManifest>(repairModuleManifest);
