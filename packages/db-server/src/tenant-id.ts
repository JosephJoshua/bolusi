// Tenant-id validation for the forTenant gate (10-db-schema §2).
//
// Ids are UUIDv7 in LOWERCASE CANONICAL TEXT. The lowercase rule is not cosmetic: Postgres
// `uuid` comparison is bytewise, which equals lexicographic order of lowercase hex text, and
// 05-operation-log §4's canonical order relies on the two agreeing across engines. An
// uppercase id would still *work* against a Postgres `uuid` column (Postgres normalises it)
// and would therefore drift silently — so it is rejected at this boundary, loudly.
//
// This regex duplicates a rule that @bolusi/schemas owns at the wire boundary. It is
// deliberate: @bolusi/schemas is a contended package this task must not touch, and forTenant
// must fail closed on its own rather than trust its caller to have validated first.

/** Lowercase canonical UUID text. Deliberately case-SENSITIVE — see the note above. */
const LOWERCASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Thrown when a tenant id is not lowercase canonical UUID text. */
export class InvalidTenantIdError extends Error {
  override readonly name = 'InvalidTenantIdError';

  constructor(received: unknown) {
    super(
      `forTenant requires a lowercase canonical UUID tenant id (10-db-schema §2); received ${JSON.stringify(received)}`,
    );
  }
}

/**
 * Returns `tenantId` if it is lowercase canonical UUID text, otherwise throws.
 *
 * Called before the transaction opens, so a bad id never reaches `set_config` and never
 * opens a connection.
 */
export function assertTenantId(tenantId: string): string {
  if (typeof tenantId !== 'string' || !LOWERCASE_UUID.test(tenantId)) {
    throw new InvalidTenantIdError(tenantId);
  }
  return tenantId;
}
