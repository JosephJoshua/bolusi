// kysely-ctl config (08 §5.1 db:migrate / db:seed / db:codegen wiring).
// Migration + seed CONTENT is task 05's; this file only makes the runner executable
// against bolusi_dev from day one. DATABASE_URL falls back to the compose dev default
// (local-dev-only credentials, docker-compose.yml).
import { defineConfig } from 'kysely-ctl';
import pg from 'pg';

export default defineConfig({
  dialect: 'pg',
  dialectConfig: {
    pool: new pg.Pool({
      connectionString:
        process.env['DATABASE_URL'] ?? 'postgres://bolusi:bolusi@localhost:5432/bolusi_dev',
    }),
  },
  migrations: {
    migrationFolder: 'migrations',
  },
  seeds: {
    seedFolder: 'seeds',
  },
});
