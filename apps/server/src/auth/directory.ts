// The AuthDirectory port — the server's seam over the ONLY cross-tenant reads in the system
// (10-db-schema §6.4 / D14). Token verification and login must resolve the tenant FROM an opaque
// credential before it is known, which forTenant cannot express; db-server exposes three narrow,
// definer-gated lookups for exactly this. This port lets the app depend on their SHAPE while the
// production binding wires the real db-server functions and tests inject a fake over a migrated
// real-PG16 DB (the auth bootstrap is inherently cross-tenant, so the fake reads as owner — that is
// correct, not a shortcut: RLS is precisely what these three reads do not rely on).
import {
  findControlSessionByTokenHash,
  findDeviceByTokenHash,
  findLoginCredential,
  type ControlSessionAuthRecord,
  type DeviceAuthRecord,
  type LoginCredentialRecord,
} from '@bolusi/db-server';

export type { DeviceAuthRecord, ControlSessionAuthRecord, LoginCredentialRecord };

export interface AuthDirectory {
  findDeviceByTokenHash(tokenHashHex: string): Promise<DeviceAuthRecord | undefined>;
  findControlSessionByTokenHash(
    tokenHashHex: string,
  ): Promise<ControlSessionAuthRecord | undefined>;
  findLoginCredential(loginIdentifier: string): Promise<LoginCredentialRecord | undefined>;
}

/** Production binding — the db-server D14 exports (getDb → bolusi_app → definer functions). */
export const dbAuthDirectory: AuthDirectory = {
  findDeviceByTokenHash,
  findControlSessionByTokenHash,
  findLoginCredential,
};
