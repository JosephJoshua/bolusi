// Postgres error-shape helpers — ONE implementation (CLAUDE.md §2.8) for the whole server, not a
// per-route copy (this consolidates the identical checks task 12/33 grew in users.ts and the
// provision CLI).
//
// The unique-violation (SQLSTATE 23505) case is a SECURITY invariant, not a convenience: every
// id-keyed INSERT whose primary/unique key is GLOBAL rather than tenant-scoped shares a shape —
// RLS filters SELECTs but NOT unique-index conflicts (10-db §6), so a cross-tenant id an
// RLS-hidden row already holds trips 23505 on INSERT. Left uncaught it escapes as `500 INTERNAL`,
// and a 500-vs-clean-404 (or -409/-duplicate) is a cross-tenant existence oracle (security-guide
// §2.2; task 114). Callers catch it and render THEIR surface's indistinguishable denied response —
// never a general "swallow unique violations" habit: legitimate same-surface conflicts
// (INIT_MISMATCH, MEDIA_IMMUTABLE, a chain UNIQUE) keep their own codes and paths.
//
// The node-postgres driver (production + the apps/server L3 lane) puts the SQLSTATE on `err.code`.
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

// A unique violation on a SPECIFICALLY NAMED constraint. node-postgres surfaces the violated
// constraint's name on `err.constraint` (the wire `n` field of the 23505 ErrorResponse — pg-protocol
// `parser.js`). A caller that maps only ONE unique index to a domain outcome — and must re-throw
// every OTHER 23505 loudly — keys on this, not on SQLSTATE alone. Naming the constraint stops the map
// silently WIDENING when a new statement able to raise a DIFFERENT 23505 is added to the same `try`:
// SQLSTATE alone would absorb the new violation as the old outcome (CLAUDE.md §2.11; task 139 — the
// projection applier inside the op-write savepoint did exactly that and was misread as `duplicate`).
export function isUniqueViolationOn(err: unknown, constraint: string): boolean {
  return isUniqueViolation(err) && (err as { constraint?: string }).constraint === constraint;
}
