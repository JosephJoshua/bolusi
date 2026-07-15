// Adversarial op builders for the server push-validation surface (task 07). Public entry.
export {
  ChainBuilder,
  makeWorld,
  resign,
  toSignedCore,
  uuidV4,
  uuidV7,
  validHashOf,
  type ChainWorld,
  type OpSpec,
} from './builder.js';
export {
  breakPreviousHash,
  forgeSignature,
  mutateHashField,
  mutatePayloadPostHash,
  mutateUserIdPostHash,
  relabelDeviceId,
} from './tamper.js';
