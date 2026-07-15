// v0 bootstrap CLI (api/02-auth §2; 01-domain-model §3.1). In ONE transaction it creates the
// tenant, its stores, the main-owner user (argon2id password verifier, no PIN), the system actor
// + system device (§3.6) + its chain-state row, the tenant op counter, and the three default roles
// (02-permissions §10) with the owner granted main_owner tenant-wide. Prints the one-time owner
// password exactly once. Refuses (non-zero exit, zero writes) if --owner-login already exists.
//
// DEVIATION (flagged): the task calls this "the bolusi_provision path". db-server exposes only
// forTenant (bolusi_app) and pg is boundary-locked to db-server, so this runs through
// forTenant(newTenantId) as bolusi_app — which CAN create a single tenant's rows (RLS WITH CHECK
// passes for the tenant it is creating) and relies on the GLOBAL login_identifier UNIQUE index for
// idempotency. Global reference data (`permissions`) is seeded by migration 0008, not here.
import { ed25519 } from '@noble/curves/ed25519.js';
import { forTenant as dbForTenant, type ForTenant, type TenantDb } from '@bolusi/db-server';

import { createPasswordVerifier, randomBase58 } from '../crypto/index.js';
import { appendAudit } from '../identity/audit.js';
import { DEFAULT_ROLES } from '../identity/permission-registry.js';
import { uuidv7 } from '../uuidv7.js';

export interface ProvisionOpts {
  readonly tenantName: string;
  readonly storeNames: readonly string[];
  readonly ownerName: string;
  readonly ownerLogin: string;
}

export interface ProvisionDeps {
  readonly forTenant: ForTenant;
  readonly now: () => number;
  readonly createPasswordVerifier: (password: string) => Promise<string>;
  readonly generatePassword: () => string;
  readonly generateSystemKeypair: () => { publicKeyB64: string; secretKeyB64: string };
}

export interface ProvisionResult {
  readonly tenantId: string;
  readonly storeIds: string[];
  readonly ownerUserId: string;
  readonly systemUserId: string;
  readonly systemDeviceId: string;
  /** Printed once; only its verifier is stored. */
  readonly oneTimePassword: string;
  /** The system device's Ed25519 seed (base64) — a deployment secret for task 17's signer. */
  readonly systemDevicePrivateKeyB64: string;
}

export class OwnerLoginExistsError extends Error {
  constructor(login: string) {
    super(`--owner-login "${login}" already exists (globally unique); refusing to provision`);
    this.name = 'OwnerLoginExistsError';
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

/** The default production deps (real crypto + db-server forTenant). */
export const defaultProvisionDeps: ProvisionDeps = {
  forTenant: dbForTenant,
  now: () => Date.now(),
  createPasswordVerifier,
  generatePassword: () => randomBase58(24),
  generateSystemKeypair: () => {
    const { secretKey, publicKey } = ed25519.keygen();
    return {
      publicKeyB64: Buffer.from(publicKey).toString('base64'),
      secretKeyB64: Buffer.from(secretKey).toString('base64'),
    };
  },
};

export async function provisionTenant(
  deps: ProvisionDeps,
  opts: ProvisionOpts,
): Promise<ProvisionResult> {
  if (opts.storeNames.length < 1) throw new Error('at least one --store-name is required');
  if (opts.ownerLogin === 'system') throw new Error('"system" is a reserved login identifier');

  const t = deps.now();
  const tenantId = uuidv7(t);
  const storeIds = opts.storeNames.map(() => uuidv7(t));
  const ownerUserId = uuidv7(t);
  const systemUserId = uuidv7(t);
  const systemDeviceId = uuidv7(t);
  const oneTimePassword = deps.generatePassword();
  const passwordVerifier = await deps.createPasswordVerifier(oneTimePassword);
  const keypair = deps.generateSystemKeypair();

  try {
    await deps.forTenant(tenantId, async (db: TenantDb) => {
      await db
        .insertInto('tenants')
        .values({ id: tenantId, name: opts.tenantName, createdAt: BigInt(t) })
        .execute();
      await db.insertInto('tenantOpCounters').values({ tenantId }).execute();

      for (const [i, storeId] of storeIds.entries()) {
        await db
          .insertInto('stores')
          .values({
            id: storeId,
            tenantId,
            name: opts.storeNames[i] as string,
            createdAt: BigInt(t),
          })
          .execute();
      }

      // Main owner (§2: argon2id password verifier, pinVerifier absent).
      await db
        .insertInto('users')
        .values({
          id: ownerUserId,
          tenantId,
          name: opts.ownerName,
          loginIdentifier: opts.ownerLogin,
          passwordVerifier,
          status: 'active',
          isSystem: false,
          createdAt: BigInt(t),
          createdBy: null,
        })
        .execute();

      // System actor + system device (§3.6): actor never in a bundle; device signs conflict ops.
      await db
        .insertInto('users')
        .values({
          id: systemUserId,
          tenantId,
          name: 'system',
          loginIdentifier: null,
          passwordVerifier: null,
          status: 'active',
          isSystem: true,
          createdAt: BigInt(t),
          createdBy: null,
        })
        .execute();
      await db
        .insertInto('devices')
        .values({
          id: systemDeviceId,
          tenantId,
          storeId: null,
          kind: 'system',
          name: 'system',
          signingKeyPublic: keypair.publicKeyB64,
          tokenHash: null,
          enrolledAt: BigInt(t),
          enrolledBy: null,
          status: 'active',
        })
        .execute();
      await db
        .insertInto('systemDeviceChainState')
        .values({ tenantId, deviceId: systemDeviceId, lastSeq: 0n, lastHash: null })
        .execute();

      // Default roles + grants (02-permissions §10/§12). Owner gets main_owner tenant-wide.
      const roleIdByKey = new Map<string, string>();
      for (const role of DEFAULT_ROLES) {
        const roleId = uuidv7(t);
        roleIdByKey.set(role.key, roleId);
        await db
          .insertInto('roles')
          .values({
            id: roleId,
            tenantId,
            name: role.key,
            scopeType: role.scopeType,
            isSystemDefault: true,
            createdAt: BigInt(t),
          })
          .execute();
        for (const permissionId of role.permissionIds) {
          await db
            .insertInto('rolePermissions')
            .values({ roleId, permissionId, tenantId })
            .execute();
        }
      }
      const mainOwnerRoleId = roleIdByKey.get('main_owner') as string;
      await db
        .insertInto('userRoles')
        .values({ tenantId, userId: ownerUserId, roleId: mainOwnerRoleId, storeId: null })
        .execute();
      for (const storeId of storeIds) {
        await db
          .insertInto('userStores')
          .values({ userId: ownerUserId, storeId, tenantId })
          .execute();
      }

      // Provisioning audit rows: actor NULL, action 'cli:provision-tenant' (§2).
      for (const [entityType, entityId] of [
        ['tenant', tenantId],
        ['user', ownerUserId],
        ['user', systemUserId],
        ['device', systemDeviceId],
      ] as const) {
        await appendAudit(db, tenantId, {
          actorUserId: null,
          action: 'cli:provision-tenant',
          entityType,
          entityId,
          at: t,
        });
      }
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new OwnerLoginExistsError(opts.ownerLogin);
    throw err;
  }

  return {
    tenantId,
    storeIds,
    ownerUserId,
    systemUserId,
    systemDeviceId,
    oneTimePassword,
    systemDevicePrivateKeyB64: keypair.secretKeyB64,
  };
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { parseArgs } = await import('node:util');
  const { values } = parseArgs({
    options: {
      'tenant-name': { type: 'string' },
      'store-name': { type: 'string', multiple: true },
      'owner-name': { type: 'string' },
      'owner-login': { type: 'string' },
    },
  });

  const tenantName = values['tenant-name'];
  const storeNames = values['store-name'] ?? [];
  const ownerName = values['owner-name'];
  const ownerLogin = values['owner-login'];
  if (!tenantName || storeNames.length === 0 || !ownerName || !ownerLogin) {
    process.stderr.write(
      'usage: provision-tenant --tenant-name N --store-name S [--store-name S...] --owner-name N --owner-login L\n',
    );
    process.exit(2);
  }

  try {
    const result = await provisionTenant(defaultProvisionDeps, {
      tenantName,
      storeNames,
      ownerName,
      ownerLogin,
    });
    // The one-time password (and system-device key) is printed EXACTLY ONCE. Never logged again.
    process.stdout.write(`tenant provisioned: ${result.tenantId}\n`);
    process.stdout.write(`owner user:         ${result.ownerUserId}\n`);
    process.stdout.write(
      `ONE-TIME PASSWORD (store securely, shown once): ${result.oneTimePassword}\n`,
    );
    process.stdout.write(
      `SYSTEM DEVICE PRIVATE KEY (deployment secret for the conflict signer): ${result.systemDevicePrivateKeyB64}\n`,
    );
    process.exit(0);
  } catch (err) {
    if (err instanceof OwnerLoginExistsError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    process.stderr.write(`provisioning failed: ${String(err)}\n`);
    process.exit(1);
  }
}

// Run only when invoked directly (not when imported by the test suite).
if (
  process.argv[1]?.endsWith('provision-tenant.ts') ||
  process.argv[1]?.endsWith('provision-tenant.js')
) {
  void main();
}
