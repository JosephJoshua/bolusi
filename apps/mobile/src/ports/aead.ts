// The device AEAD binding for at-rest column encryption — react-native-quick-crypto 1.1.6 (D22; D8).
//
// D22 re-homed at-rest confidentiality onto AES-256-GCM over quick-crypto's already-linked OpenSSL —
// the SOLE on-device crypto provider (D8), so this adds ZERO native deps and no second `libcrypto`
// (task 148's whole point). @bolusi/db-client declares the `AeadCipher` capability and never imports a
// provider (so no `node:crypto` reaches the device bundle); this file is the mobile binding, exactly as
// `ports/crypto.ts` binds quick-crypto to `CryptoPort`. CI/tests bind `node:crypto` to the SAME
// interface (@bolusi/test-support), and the two are API-identical for GCM.
import { createCipheriv, createDecipheriv, randomBytes } from 'react-native-quick-crypto';

import { createNodeCompatibleAead, type AeadCipher } from '@bolusi/db-client';

/** Copy a quick-crypto Buffer into a plain Uint8Array — the codec's surface never sees a Buffer. */
function toBytes(value: { readonly [index: number]: number; readonly length: number }): Uint8Array {
  return Uint8Array.from(value as ArrayLike<number>);
}

/**
 * The device AES-256-GCM primitive. Adapts quick-crypto's classic cipher surface to the narrow
 * `NodeCompatibleCryptoModule` the codec factory expects; the casts are the platform-seam kind
 * `ports/crypto.ts` uses — quick-crypto's `update`/`final`/`getAuthTag` return Buffers, which ARE
 * Uint8Arrays, but the binding pins them so the codec sees plain bytes.
 */
/**
 * quick-crypto's cipher objects in BYTE terms.
 *
 * Its published types speak `Buffer` (the Node-compat surface it emulates); at runtime every one of
 * these takes and returns binary data crossing JSI, and `Buffer` IS a `Uint8Array`. Narrowing the
 * handle once, here at the platform seam, is the same move `ports/crypto.ts` makes with `toBytes` —
 * and it keeps `Buffer` out of the codec's vocabulary entirely, which matters because db-client is
 * also compiled for Node, where the two `Buffer` types are not structurally identical.
 */
interface QuickCryptoGcmHandle {
  update(data: Uint8Array): Uint8Array;
  final(): Uint8Array;
  getAuthTag(): Uint8Array;
  setAuthTag(tag: Uint8Array): void;
}

export const deviceColumnAead: AeadCipher = createNodeCompatibleAead({
  createCipheriv(algorithm, key, iv) {
    const cipher = createCipheriv(
      algorithm as 'aes-256-gcm',
      key,
      iv,
    ) as unknown as QuickCryptoGcmHandle;
    return {
      update: (data) => toBytes(cipher.update(data)),
      final: () => toBytes(cipher.final()),
      getAuthTag: () => toBytes(cipher.getAuthTag()),
    };
  },
  createDecipheriv(algorithm, key, iv) {
    const decipher = createDecipheriv(
      algorithm as 'aes-256-gcm',
      key,
      iv,
    ) as unknown as QuickCryptoGcmHandle;
    return {
      update: (data) => toBytes(decipher.update(data)),
      final: () => toBytes(decipher.final()),
      setAuthTag: (tag) => decipher.setAuthTag(tag),
    };
  },
  randomBytes: (size) => toBytes(randomBytes(size)),
});
