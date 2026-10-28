// Integrated QRIS from the boot config: both PAYMENT_SECRETS_KEY and PUBLIC_URL, or neither.
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
  return { sealer: createSecretSealer(paymentSecretsKey), xendit: createXenditClient(), publicUrl };
}
