// Integrated QRIS from the boot config: both PAYMENT_SECRETS_KEY and PUBLIC_URL, or neither. A
// confirmed payment is a record the server signs, so SYSTEM_KEY_DIR must be set as well.
import type { ServerConfig } from '../config.js';

import { createSecretSealer } from './seal.js';
import type { QrisConfig } from './service.js';
import { createXenditClient } from './xendit.js';

export function qrisFromConfig(config: ServerConfig): QrisConfig | undefined {
  const { paymentSecretsKey, publicUrl } = config;
  if (paymentSecretsKey === undefined && publicUrl === undefined) return undefined;
  if (paymentSecretsKey === undefined || publicUrl === undefined) {
    throw new Error(
      'Set both PAYMENT_SECRETS_KEY and PUBLIC_URL for QRIS through Xendit, or neither',
    );
  }
  if (config.systemKeyDir === undefined) {
    throw new Error('QRIS through Xendit needs SYSTEM_KEY_DIR: its payments are signed records');
  }
  return { sealer: createSecretSealer(paymentSecretsKey), xendit: createXenditClient(), publicUrl };
}
