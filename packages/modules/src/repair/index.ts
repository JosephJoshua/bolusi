// The `repair` module's platform-free public surface (manifest, data types, search helpers).
export { repairModule, repairModuleManifest } from './manifest.js';
export * from './constants.js';
export * from './intake-options.js';
export * from './options-editor.js';
export * from './screen-lock.js';
export type * from './schema.js';
export * from './search.js';
export { REPAIR_REFUSALS } from './rules.js';
export {
  PHONE_MODELS_TABLE,
  catalogKeys,
  sameDeviceModel,
  deviceModelSearchSource,
  type DeviceModelKind,
  type DeviceModelPhoto,
  type DeviceModelRow,
  type FindDeviceModelInput,
  type SearchDeviceModelsInput,
} from './device-models.js';
export { deviceCode, formatTicketNumber, ticketCounter } from './ticket-number.js';
export type {
  CustomerRow,
  QuoteLineRow,
  TicketDetailRow,
  TicketEventRow,
  TicketPhotoRow,
  TicketSummaryRow,
  RecordedOption,
  IntakePhotoAngle,
  ListTicketsInput,
  SearchTicketsInput,
  SearchCustomersInput,
  GetTicketInput,
  GetCustomerInput,
  PrintSettings,
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
  ChangeIntakeOptionsInput,
  HideIntakeOptionsInput,
} from './commands.js';
export * from './flows.js';
