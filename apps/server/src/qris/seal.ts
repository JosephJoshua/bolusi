// Sealing a payment provider's secret key at rest. The server needs the key again for every QR, so
// it cannot be hashed like a token; it is encrypted with AES-256-GCM under PAYMENT_SECRETS_KEY,
// which lives in the deployment's secrets, never in Postgres. The row's tenant and account are the
// associated data, so a sealed key copied onto another row does not open.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const TAG_BYTES = 16;

export interface SecretSealer {
  seal(plain: string, context: string): string;
  /** Throws when the sealed text was altered, moved to another row, or sealed under another key. */
  open(sealed: string, context: string): string;
}

/** A sealer over a 32-byte key given as base64. */
export function createSecretSealer(keyBase64: string): SecretSealer {
  const key = Buffer.from(keyBase64, 'base64');
  if (key.length !== 32) throw new Error('PAYMENT_SECRETS_KEY must be 32 bytes, base64');
  return {
    seal(plain, context) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
      cipher.setAAD(Buffer.from(context, 'utf8'));
      const body = Buffer.concat([
        cipher.update(plain, 'utf8'),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
      return `${VERSION}.${iv.toString('base64')}.${body.toString('base64')}`;
    },
    open(sealed, context) {
      const [version, ivText, bodyText] = sealed.split('.');
      if (version !== VERSION || ivText === undefined || bodyText === undefined) {
        throw new Error('unreadable sealed secret');
      }
      const body = Buffer.from(bodyText, 'base64');
      if (body.length < TAG_BYTES) throw new Error('unreadable sealed secret');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivText, 'base64'), {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(Buffer.from(context, 'utf8'));
      decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
      return Buffer.concat([
        decipher.update(body.subarray(0, body.length - TAG_BYTES)),
        decipher.final(),
      ]).toString('utf8');
    },
  };
}
