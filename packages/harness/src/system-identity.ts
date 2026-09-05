// A tenant's system actor + device (01 §3.6) — the identity the server's conflict-detection pipeline
// emits `platform.conflict_detected` through. This is HOST-ONLY test setup: the device never mints or
// sees the system key (it is deployment-owned host setup, exactly as 03/06's member keys are), so this
// lives in @bolusi/harness, NOT in the bundle-safe rig alongside `mintIdentities` (which the device DOES
// re-derive). The extraction (task 198): both `chaos-07-conflicts.test.ts`'s `mintSystem` and
// `device-runner-chaos-07.test.ts`'s `mintSystemDevice` minted it inline byte-for-byte, and the chaos-net
// child server (scripts/harness-chaos-server.mjs) needs a THIRD caller — the rule-of-three trigger (§2.8).
import { bytesToBase64 } from '@bolusi/core';
import { deriveDeviceKeypair, FakeClock, makeIdSource, mulberry32 } from '@bolusi/test-support';

/** The system device's id-minting clock base — matches the harness genesis clock base (T-6), so a system
 *  device minted here lines up with the members minted from the same seed. */
const SYSTEM_CLOCK_BASE = 1_726_000_000_000;

/** The minted system identity. `publicKeyBase64` is what the caller seeds into `devices.signing_key_public`
 *  (05 §2.2); `secret` is the seed the caller feeds a `systemKeyStore` signer, so the two match and both
 *  `appendSystemOp`'s self-verify and a pulling device's verify-and-quarantine pass. Read-only — every
 *  caller only reads these fields. */
export interface SystemDeviceIdentity {
  readonly tenantId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly publicKeyBase64: string;
  readonly secret: Uint8Array;
}

/**
 * Mint a tenant's system actor + device deterministically (T-6). A distinct prng (`^ 0x5157`) and keypair
 * index 99 keep its user/device ids and key clear of the members' (indices 0/1/2). Pure function of the
 * seed, so the Node scenario, the host binding, and the chaos-net child all mint the SAME system device
 * from the same seed.
 */
export function mintSystemDevice(tenantSeed: number, tenantId: string): SystemDeviceIdentity {
  const ids = makeIdSource(
    new FakeClock(SYSTEM_CLOCK_BASE),
    mulberry32((tenantSeed ^ 0x5157) >>> 0),
  );
  const userId = ids();
  const deviceId = ids();
  const keypair = deriveDeviceKeypair(tenantSeed, 99);
  return {
    tenantId,
    userId,
    deviceId,
    publicKeyBase64: bytesToBase64(keypair.publicKey),
    secret: keypair.seed,
  };
}
