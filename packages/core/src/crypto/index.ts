// Crypto + canonicalization surface of @bolusi/core (05-operation-log §2–§4).
export {
  bytesToBase64,
  base64ToBytes,
  bytesToHex,
  bytesToUtf8,
  concatBytes,
  hexToBytes,
  utf8ToBytes,
} from './bytes.js';
export {
  canonicalizeJcs,
  JcsInputError,
  type JcsInputErrorCode,
  type JsonPrimitive,
  type JsonValue,
} from './jcs.js';
export { encryptColumnValue, registerColumnCipher, type ColumnCipher } from './column-cipher.js';
export {
  deriveMediaFileKey,
  MediaFileCipher,
  onDiskFrameLength,
  onDiskFrameOffset,
  plaintextSizeFromOnDisk,
  MEDIA_FILE_FRAME_BYTES,
  MEDIA_FILE_FRAME_OVERHEAD,
  MEDIA_FILE_KEY_BYTES,
  MEDIA_FILE_NONCE_BYTES,
  MEDIA_FILE_ON_DISK_FRAME_BYTES,
  MEDIA_FILE_TAG_BYTES,
  type MediaFileAead,
} from './media-file-cipher.js';
export { compareCanonicalOrder, sortCanonical, type CanonicalOrderKey } from './order.js';
export {
  DEFAULT_KDF_PARAMS,
  type CryptoPort,
  type Ed25519KeyPair,
  type KdfParams,
} from './port.js';
export { hashSignedCore, signOp, verifyOp, type SignedCoreDigest } from './signed-core.js';
