/**
 * An embedded client migration (10-db §11.4). Migrations are compiled into the bundle
 * rather than read from disk: on device there is no migrations folder to read, and
 * kysely-ctl's FileMigrationProvider is a server-side tool (08 §2.4).
 */
export interface ClientMigration {
  /** Monotonic; the `migrations` table records it (10-db §9.1). */
  readonly version: number;
  readonly name: string;
  /** Executed in order, inside one transaction. One statement per entry. */
  readonly statements: readonly string[];
  /**
   * Statements run AFTER the migration's transaction commits, OUTSIDE any transaction — for
   * `VACUUM`, which SQLite refuses to run inside a transaction. Used by the at-rest column-encryption
   * migration to purge freed pages so a plaintext→ciphertext conversion leaves no stale plaintext
   * (D22; security-guide §6.4). Best-effort ordering: the bookkeeping row is already committed when
   * these run, so a device that dies mid-`VACUUM` is still "migrated" and simply re-`VACUUM`s never
   * (a `VACUUM` is idempotent and only ever removes free space).
   */
  readonly postCommitStatements?: readonly string[];
}
