// The `repair` module's platform-free public surface (manifest, data types, search helpers).
export { repairModule, repairModuleManifest } from './manifest.js';
export * from './constants.js';
export type * from './schema.js';
export * from './search.js';
export { deviceCode, formatTicketNumber, ticketCounter } from './ticket-number.js';
export type {
  CustomerRow,
  QuoteLineRow,
  TicketDetailRow,
  TicketEventRow,
  TicketPhotoRow,
  TicketSummaryRow,
  ListTicketsInput,
  SearchTicketsInput,
  SearchCustomersInput,
  GetTicketInput,
  GetCustomerInput,
} from './queries.js';
export type {
  RegisterCustomerInput,
  CorrectCustomerDetailsInput,
  OpenTicketInput,
  OpenTicketResult,
  TicketIdInput,
  TicketNoteInput,
  AssignTechnicianInput,
  CancelTicketInput,
  StartWorkInput,
  MarkRepairedInput,
  ProposeQuoteChangeInput,
  ChangeQuoteInput,
  ApplyProposalInput,
  DeclineProposalInput,
  ReturnDeviceInput,
} from './commands.js';
export * from './flows.js';
