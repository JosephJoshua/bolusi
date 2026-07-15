// Identity test harness (testing-guide §2.5): a migrated PGlite DB with the PRODUCTION query
// shape — forTenant runs `SET LOCAL ROLE bolusi_app` + transaction-local set_config, so RLS is
// actually exercised (a suite that skipped SET ROLE would pass vacuously as the PGlite superuser).
// The owner handle seeds fixtures (legitimately bypassing RLS). The AuthDirectory calls the D14
// SECURITY DEFINER functions, exactly as production does through @bolusi/db-server.
import { CamelCasePlugin, Kysely, PGliteDialect, sql } from 'kysely';

import { migrateToLatest, type DB, type ForTenant } from '@bolusi/db-server';

import type { AuthDirectory } from '../../src/auth/directory.js';
import type { PasswordKdf } from '../../src/crypto/index.js';

export interface IdentityDb {
  /** Owner/superuser handle — seeds fixtures (bypasses RLS, which is what a fixture needs). */
  readonly db: Kysely<DB>;
  /** Production-shape forTenant: SET LOCAL ROLE bolusi_app + transaction-local set_config. */
  readonly forTenant: ForTenant;
  /** Cross-tenant lookups over the D14 definer functions (as production wires them). */
  readonly authDirectory: AuthDirectory;
  close(): Promise<void>;
}

export async function makeIdentityDb(): Promise<IdentityDb> {
  const { PGlite } = await import('@electric-sql/pglite');
  const pglite = new PGlite();
  await pglite.waitReady;
  const db = new Kysely<DB>({
    dialect: new PGliteDialect({ pglite }),
    plugins: [new CamelCasePlugin({ underscoreBetweenUppercaseLetters: true })],
  });
  await migrateToLatest(db);

  const forTenant: ForTenant = (tenantId, fn) =>
    db.transaction().execute(async (trx) => {
      await sql`SET LOCAL ROLE bolusi_app`.execute(trx);
      await sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
      return fn(trx as never);
    });

  const authDirectory: AuthDirectory = {
    async findDeviceByTokenHash(hashHex) {
      const { rows } = await sql<{
        tenantId: string;
        storeId: string | null;
        deviceId: string;
        status: string;
      }>`SELECT * FROM auth_find_device_by_token_hash(${hashHex})`.execute(db);
      return rows[0];
    },
    async findControlSessionByTokenHash(hashHex) {
      const { rows } = await sql<{
        tenantId: string;
        userId: string;
        sessionId: string;
        expiresAt: string | number;
        revokedAt: string | number | null;
      }>`SELECT * FROM auth_find_control_session_by_token_hash(${hashHex})`.execute(db);
      const row = rows[0];
      if (row === undefined) return undefined;
      return {
        tenantId: row.tenantId,
        userId: row.userId,
        sessionId: row.sessionId,
        expiresAt: Number(row.expiresAt),
        revokedAt: row.revokedAt === null ? null : Number(row.revokedAt),
      };
    },
    async findLoginCredential(loginIdentifier) {
      const { rows } = await sql<{
        tenantId: string;
        userId: string;
        passwordVerifier: string | null;
        status: string;
      }>`SELECT * FROM auth_find_login_credential(${loginIdentifier})`.execute(db);
      return rows[0];
    },
  };

  return { db, forTenant, authDirectory, close: () => db.destroy() };
}

// ---- A fast, consistent test KDF (real argon2id is deliberately slow) --------------------------
// createVerifier/verify agree with each other; runDummy is a no-op the KDF-spy counts. NOT argon2 —
// it is sha256(pw+salt), which is wrong for production but correct as a fast, self-consistent stub.
import { createHash } from 'node:crypto';

const STUB_SALT = 'dGVzdHNhbHR0ZXN0c2FsdA=='; // 16 bytes base64

function stubHash(password: string): string {
  return createHash('sha256').update(`${STUB_SALT}:${password}`).digest('base64');
}

export function makeStubKdf(): { kdf: PasswordKdf; dummyCalls: () => number } {
  let dummy = 0;
  const kdf: PasswordKdf = {
    createVerifier: (password) =>
      Promise.resolve(
        JSON.stringify({
          algorithm: 'argon2id',
          saltB64: STUB_SALT,
          mKiB: 32768,
          t: 3,
          p: 1,
          hashB64: stubHash(password),
        }),
      ),
    verify: (password, verifierJson) => {
      try {
        const v = JSON.parse(verifierJson) as { hashB64: string };
        return Promise.resolve(v.hashB64 === stubHash(password));
      } catch {
        return Promise.resolve(false);
      }
    },
    runDummy: (password) => {
      dummy += 1;
      stubHash(password);
      return Promise.resolve();
    },
  };
  return { kdf, dummyCalls: () => dummy };
}
