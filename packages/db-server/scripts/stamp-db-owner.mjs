// PROVISIONING ONLY — stamps a database you created yourself as yours (`pnpm db:stamp`).
//
// Local dev never needs this: scripts/pg-init/02-stamp-db-owner.sh stamps every compose
// cluster at init. It exists for a database provisioned OUTSIDE compose — in practice CI's
// postgres service container, which the workflow creates fresh, per job, reachable by nothing
// else, and which cannot run an init script.
//
// This is a separate command from the test lane ON PURPOSE (T-14d). Stamping must be an
// explicit act by whoever provisioned the database. If the test lane could stamp an unstamped
// database it found, it would adopt a peer's container instead of rejecting it — the guard
// would certify precisely the situation it exists to catch. Verification reads; provisioning
// writes; nothing does both.
import pg from 'pg';

const url = process.env['DATABASE_URL'];
if (url === undefined || url === '') {
  console.error('db:stamp: DATABASE_URL is not set — nothing to stamp');
  process.exit(1);
}

const owner = process.env['BOLUSI_DB_OWNER'];
if (owner === undefined || owner === '') {
  console.error('db:stamp: BOLUSI_DB_OWNER is not set — a stamp needs the token to write');
  process.exit(1);
}

// The owner token is interpolated into SQL below (ALTER DATABASE takes no parameters), so it
// is validated rather than trusted — same charset compose allows for a project name.
if (!/^[a-z0-9][a-z0-9_-]*$/.test(owner)) {
  console.error(`db:stamp: refusing to stamp — '${owner}' is not a valid owner token`);
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  const { rows } = await pool.query('select current_database() as database');
  const database = rows[0].database;
  if (!/^[A-Za-z0-9_]+$/.test(database)) {
    throw new Error(`unexpected database name: ${database}`);
  }
  await pool.query(`ALTER DATABASE ${database} SET bolusi.db_owner = '${owner}'`);
  console.log(`db:stamp: ${database} is now stamped bolusi.db_owner = ${owner}`);
} finally {
  await pool.end();
}
