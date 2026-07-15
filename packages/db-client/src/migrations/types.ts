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
}
