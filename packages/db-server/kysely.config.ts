// kysely-ctl config (08 §5.1 db:migrate / db:seed / db:codegen wiring).
// Migration + seed CONTENT is task 05's; this file only makes the runner executable
// against bolusi_dev.
//
// DATABASE_URL is REQUIRED — it used to fall back to postgres://…@localhost:5432/bolusi_dev,
// and that default was not a convenience but a hazard: the dev compose port is ephemeral and
// per-worktree, so a hardcoded 5432 resolves to whichever PEER worktree happens to own the
// port, and `pnpm db:migrate` would then migrate somebody else's database (testing-guide
// T-14d). Run it from the repo root as `pnpm db:migrate`, which derives this worktree's URL.
import { defineConfig } from 'kysely-ctl';
import pg from 'pg';

function connectionString(): string {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') {
    throw new Error(
      "DATABASE_URL is not set. Run 'pnpm db:migrate' from the repo root — it brings up this " +
        "worktree's own postgres and derives its ephemeral port (there is no default port on " +
        'purpose: guessing one migrates a peer worktree, testing-guide T-14d).',
    );
  }
  return url;
}

export default defineConfig({
  dialect: 'pg',
  dialectConfig: {
    pool: new pg.Pool({ connectionString: connectionString() }),
  },
  migrations: {
    migrationFolder: 'migrations',
  },
  seeds: {
    seedFolder: 'seeds',
  },
});
