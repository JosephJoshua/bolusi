// WHICH database this suite talks to, and who is allowed to own it (T-14d).
//
// The engine choice and the connection URL live HERE, in one module, because the attribution
// guard (test/global-setup.ts) and the harness that opens the real connections (test-db.ts)
// must be talking about the same database. A guard that resolves its target independently of
// the code it guards is theatre: the two drift, and the guard ends up certifying a database
// nobody connected to.

export type Engine = 'pglite' | 'postgres';

/** Chosen by env, never by a forked copy of the suite (see test-db.ts). */
export const ENGINE: Engine =
  process.env['BOLUSI_DB_ENGINE'] === 'postgres' ? 'postgres' : 'pglite';

/**
 * The database-level GUC that names the compose project owning a dev cluster.
 * Written at cluster init by scripts/pg-init/02-stamp-db-owner.sh (and by `pnpm db:stamp` for
 * an externally-provisioned CI database). Read, never written, by the test lane.
 */
export const DB_OWNER_SETTING = 'bolusi.db_owner';

/**
 * The postgres connection string, or a hard failure.
 *
 * There is deliberately NO `?? 'postgres://bolusi:bolusi@localhost:5432/bolusi_rls_test'`
 * fallback here. That default is the single line that caused T-14d: with the port fixed at
 * 5432, a worktree whose `db:up` had failed still resolved to a *live* peer container and went
 * green on somebody else's data. A missing DATABASE_URL must be a stop, not a guess — the
 * lane runner (scripts/db-lane.mjs) derives the real, ephemeral port and passes it in.
 */
export function postgresUrl(): string {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') {
    throw new Error(
      'DATABASE_URL is not set and the postgres engine was requested.\n' +
        "Run this lane as 'pnpm test:rls', which brings up THIS worktree's own database and\n" +
        'derives its port. There is no default port on purpose: guessing one is how a test\n' +
        "ends up reporting on a peer worktree's database (testing-guide T-14d).",
    );
  }
  return url;
}

/**
 * The compose project / owner token this run is entitled to reach, as supplied by the lane
 * runner. Absent means the suite was started outside the lane and cannot verify anything.
 */
export function expectedDbOwner(): string | undefined {
  const owner = process.env['BOLUSI_DB_OWNER'];
  return owner === undefined || owner === '' ? undefined : owner;
}
