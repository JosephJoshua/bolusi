import { defineRefusals } from '@bolusi/core';

/** Every reason a stock change is refused, each with copy at `inventory.refusal.<reason>`. */
export const INVENTORY_REFUSALS = defineRefusals('inventory', [
  'alreadyRecorded',
  'categoryInvalid',
  'categoryNotFound',
  'itemNotFound',
  'itemArchived',
  'moreThanTaken',
  'wrongUse',
  'wrongSource',
  // Buy prices (rules.ts stockCostedRule).
  'notReceived',
  'costNotYours',
  // Transfers between stores (transfers/rules.ts).
  'transferNotFound',
  'transferMismatch',
  'transferCancelled',
  'sameStore',
  'notOnTransfer',
  'moreThanSent',
  'nothingToCancel',
  'nothingToSettle',
  'reasonRequired',
  'numberNotThisDevice',
  'numberUsed',
] as const);
