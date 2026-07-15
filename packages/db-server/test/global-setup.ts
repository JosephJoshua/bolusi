// ATTRIBUTION GATE — proves this suite reached its OWN database before a single test runs.
//
// This is the load-bearing half of task 34. The port fix (ephemeral host port, URL derived
// from `docker compose port`) makes collisions impossible in the normal case; this gate makes
// a violation DETECTABLE in the abnormal one. An isolation fix that cannot detect its own
// violation is just a hope, and this repo has shipped seven guards that were green for the
// wrong reason (CLAUDE.md §2.11) — the seventh was a `test:rls` green served by another
// worktree's container after an unread `db:up` failure (T-14d). "The tests passed" was true;
// "we tested our database" was not.
//
// The mechanism: every dev cluster is stamped AT INIT with the compose project that owns it
// (scripts/pg-init/02-stamp-db-owner.sh writes the `bolusi.db_owner` database GUC). The lane
// runner passes the project it provisioned as BOLUSI_DB_OWNER. If the database on the other
// end of DATABASE_URL does not agree that it belongs to us, the run ABORTS. It fails CLOSED:
// an absent stamp is a failure, not a pass, because "unstamped" is indistinguishable from
// "somebody else's, created before this guard existed" — and there is such a container on the
// dev daemon right now.
//
// This gate NEVER writes a stamp. Provisioning is a separate, explicit act (`pnpm db:stamp`).
// If verification could also provision, a foreign database would simply be adopted by the run
// that was supposed to reject it — the failure mode being designed against.
import pg from 'pg';

import { DB_OWNER_SETTING, ENGINE, expectedDbOwner, postgresUrl } from './helpers/db-target.js';

interface Attribution {
  owner: string | null;
  database: string;
  version: string;
}

/** Hides the password when a URL is echoed into a failure message. */
function redact(url: string): string {
  return url.replace(/:\/\/([^:]+):[^@]*@/, '://$1:***@');
}

export default async function setup(): Promise<void> {
  const expected = expectedDbOwner();

  if (ENGINE !== 'postgres') {
    // PGlite is in-process: it boots a private postgres inside this node process, reachable by
    // nobody else, so there is no attribution question to answer and nothing to check.
    //
    // But a guard must assert it is not silently no-opping on the very lane it protects
    // (testing-guide T-14). BOLUSI_DB_OWNER is set only by scripts/db-lane.mjs, i.e. only when
    // somebody intended the real-Postgres lane. Seeing it here means the lane quietly
    // downgraded to WASM — which would hand back a green "PG16 witness" produced by
    // PostgreSQL 18 in a WASM sandbox. That is the same fake-green shape as T-14d wearing a
    // different hat, so refuse rather than skip.
    if (expected !== undefined) {
      throw new Error(
        `db-server: BOLUSI_DB_OWNER='${expected}' says the postgres lane was requested, but ` +
          `BOLUSI_DB_ENGINE resolved to '${ENGINE}'.\n` +
          'This run would report a PGlite/WASM result as a real-Postgres witness. Run the ' +
          "lane as 'pnpm test:rls' (which sets BOLUSI_DB_ENGINE=postgres), or unset " +
          'BOLUSI_DB_OWNER to run the PGlite fast loop.',
      );
    }
    return;
  }

  if (expected === undefined) {
    throw new Error(
      'db-server: the postgres lane requires BOLUSI_DB_OWNER — the compose project (or CI ' +
        'token) whose database this run is entitled to reach.\n' +
        "Run 'pnpm test:rls'. It brings up THIS worktree's database, derives its ephemeral " +
        'port and passes the owner token. Running vitest directly against a hand-set ' +
        'DATABASE_URL cannot be attributed, and an unattributable green is not a green ' +
        '(testing-guide T-14d).',
    );
  }

  const url = postgresUrl();
  const pool = new pg.Pool({ connectionString: url, max: 1 });

  let attribution: Attribution;
  try {
    // NOT inet_server_port(): that reports the port INSIDE the container (always 5432), which
    // in a provenance line is worse than useless — it prints the very number this lane exists
    // to stop trusting. The host:port we actually dialled is in `url`.
    const { rows } = await pool.query<Attribution>(
      `select current_setting('${DB_OWNER_SETTING}', true) as owner,
              current_database() as database,
              current_setting('server_version') as version`,
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error('db-server: attribution query returned no rows');
    }
    attribution = row;
  } finally {
    await pool.end();
  }

  const { owner, database, version } = attribution;

  if (owner === null || owner === '') {
    throw new Error(
      `db-server: ABORT — the database at ${redact(url)} carries no ${DB_OWNER_SETTING} stamp, ` +
        `so it cannot be shown to belong to '${expected}'.\n` +
        'An unstamped database is treated as foreign, on purpose: it is exactly what a ' +
        'container created before this guard existed looks like, and adopting it is the bug ' +
        '(T-14d).\n' +
        "Fix: 'pnpm db:down && pnpm db:up' to recreate THIS worktree's database with a stamp. " +
        "If you provisioned this database yourself (CI), stamp it with 'pnpm db:stamp'.",
    );
  }

  if (owner !== expected) {
    throw new Error(
      `db-server: ABORT — WRONG DATABASE. ${redact(url)} belongs to compose project ` +
        `'${owner}', but this worktree is '${expected}'.\n` +
        "You are one command away from migrating, resetting and reporting on a PEER's " +
        'database — that is precisely the incident T-14d records (a green "82/11 on real ' +
        'PG16" served by another worktree\'s container).\n' +
        'Do NOT stop or remove that container: it is not yours, and another agent may be ' +
        "using it right now. Unset DATABASE_URL and run 'pnpm test:rls' to use your own.",
    );
  }

  // Provenance, printed on every run: which database produced the numbers that follow.
  // §2.1 asks every reported number to carry the evidence of where it came from; making the
  // lane say it out loud beats asking each reader to go and check.
  console.log(
    `db-server: attribution OK — PostgreSQL ${version} · db '${database}' · ${redact(url)} ` +
      `· owned by '${owner}'`,
  );
}
