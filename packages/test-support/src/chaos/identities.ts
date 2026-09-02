// Deterministic identity minting for a run (§3.1). Tenant + store are SHARED across the run's
// devices (they collaborate on one store's notes — same-entity contention is the point); each
// device gets its own user id, device id (UUIDv7), and the seed-derived Ed25519 keypair
// (SHA-256(harnessSeed ‖ deviceIndex), from the determinism kit). Two runs of the same seed mint
// byte-identical identities (T-6). Pure — imports only the determinism kit leaves + `bytesToBase64`,
// so it bundles device-side with no `node:` edge.
import { bytesToBase64 } from '@bolusi/core';

import { FakeClock } from '../determinism/clock.js';
import { makeIdSource } from '../determinism/id-source.js';
import { deriveDeviceKeypair } from '../determinism/keypair.js';
import { mulberry32 } from '../determinism/prng.js';

import type { DeviceIdentity } from './device.js';

/** The id-minting clock base — fixed, so ids are a function of the seed alone (not wall time). */
const ID_CLOCK_BASE = 1_726_000_000_000;

export interface RunIdentities {
  readonly tenantId: string;
  readonly storeId: string;
  readonly devices: readonly DeviceIdentity[];
}

/** Mint a run's identities deterministically from `harnessSeed`. */
export function mintIdentities(harnessSeed: number, deviceCount: number): RunIdentities {
  const idSource = makeIdSource(new FakeClock(ID_CLOCK_BASE), mulberry32(harnessSeed));
  const tenantId = idSource();
  const storeId = idSource();
  const devices: DeviceIdentity[] = [];
  for (let index = 0; index < deviceCount; index += 1) {
    const userId = idSource();
    const deviceId = idSource();
    const keypair = deriveDeviceKeypair(harnessSeed, index);
    devices.push({
      tenantId,
      storeId,
      userId,
      deviceId,
      seed: keypair.seed,
      publicKey: keypair.publicKey,
      publicKeyBase64: bytesToBase64(keypair.publicKey),
    });
  }
  return { tenantId, storeId, devices };
}
