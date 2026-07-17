// @bolusi/db-client — the thin DB-access wrapper (08 §3.2).
//
// The op-sqlite adapter is deliberately NOT re-exported here: it lives behind the
// `@bolusi/db-client/op-sqlite` subpath so importing this package stays safe in Node,
// where the JSI native module cannot load (testing-guide §2.3). Callers inject the
// adapter they need into `openClientDb`.
export {
  CLIENT_PRAGMAS,
  DEFAULT_DATABASE_NAME,
  DbOpenError,
  closeClientDb,
  getClientDb,
  isClientDbOpen,
  openClientDb,
} from './connection.js';
export type { ClientDb, DbKeyStore, DbOpenErrorCode, OpenClientDbOptions } from './connection.js';

export { DbError, classifyDbError, toDbError } from './driver.js';
export type {
  DbBatchCommand,
  DbBatchResult,
  DbDriver,
  DbDriverFactory,
  DbDriverOpenParams,
  DbErrorCode,
  DbPreparedStatement,
  DbQueryResult,
  DbRow,
  DbValue,
} from './driver.js';

export { createClientDialect } from './dialect/index.js';

export { createClientOpStore } from './op-store.js';
export type { OpStoreConnection } from './op-store.js';

export { CLIENT_MIGRATIONS, runClientMigrations } from './migrations/runner.js';
export type { MigrationRunResult, RunMigrationsOptions } from './migrations/runner.js';
export type { ClientMigration } from './migrations/types.js';

export type { ClientDatabase } from './generated/index.js';
