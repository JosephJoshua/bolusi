// Crypto + canonicalization surface of @bolusi/core (05-operation-log §2–§4).
export { bytesToBase64, base64ToBytes, bytesToHex, hexToBytes, utf8ToBytes } from './bytes.js';
export {
  canonicalizeJcs,
  JcsInputError,
  type JcsInputErrorCode,
  type JsonPrimitive,
  type JsonValue,
} from './jcs.js';
export { compareCanonicalOrder, sortCanonical, type CanonicalOrderKey } from './order.js';
export {
  DEFAULT_KDF_PARAMS,
  type CryptoPort,
  type Ed25519KeyPair,
  type KdfParams,
} from './port.js';
export { hashSignedCore, signOp, verifyOp, type SignedCoreDigest } from './signed-core.js';
