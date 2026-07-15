// The dev-database lane runner (T-14d). Every local command that needs Postgres goes through
// here: db:up, db:down, db:url, test:rls, db:migrate, db:codegen.
//
// WHAT THIS EXISTS TO PREVENT
// ---------------------------
// The dev docker daemon is shared by every worktree. `docker-compose.yml` used to publish a
// FIXED host port (127.0.0.1:5432) and `test:rls` used to target a HARDCODED localhost:5432,
// so only the first worktree to `db:up` ever bound the port. Every later worktree's `db:up`
// failed with EXIT=1 — and its DB tests then passed anyway, silently against a peer's
// database. That is not hypothetical: task 13's merge-gate number ("82/11 on real PG16") was
// produced by task 05's leaked container because `db:up` was run as `>/dev/null 2>&1` and its
// EXIT=1 was never read. A real number with fictional provenance.
//
// HOW IT IS CLOSED, BY CONSTRUCTION RATHER THAN BY DISCIPLINE
// -----------------------------------------------------------
// CLAUDE.md §2.1 ("never trust an exit code, read the output") was ALREADY WRITTEN when that
// happened, and it did not save anyone. So this runner does not ask to be used carefully:
//   1. DATABASE_URL is DERIVED from `docker compose port` for THIS worktree's project — there
//      is no hardcoded port left to fall back to, so a dead container cannot silently resolve
//      to a live peer.
//   2. `up` is run with inherited stdio and its status is checked HERE. A non-zero db:up
//      aborts the lane before the test command is spawned; there is no ordering in which a
//      failed db:up is followed by a green DB test.
//   3. The database's own attribution stamp is verified before any test runs — see
//      packages/db-server/test/global-setup.ts. This runner passes BOLUSI_DB_OWNER; it never
//      writes a stamp (provisioning and verification must stay separate, or a foreign
//      database gets adopted by the very run meant to detect it).
//
// Nothing here reaches outside this worktree's own compose project. Never `docker compose
// down` a container you did not start: peers are live, and a leaked container is somebody
// else's to reap.
import { spawnSync } from 'node:child_process';

/** The dev databases created by scripts/pg-init/01-create-databases.sh. */
const KNOWN_DATABASES = new Set(['bolusi_dev', 'bolusi_rls_test']);

/** Local-dev-only credentials, matching docker-compose.yml (security-guide §10). */
const DEV_USER = 'bolusi';
const DEV_PASSWORD = 'bolusi';

/**
 * Runs a command with inherited stdio and returns its status.
 *
 * stdio is 'inherit' deliberately: the caller sees the tool's OWN output (§2.1). Do not
 * "improve" this into a piped capture — `cmd | head` reports head's status, and swallowing
 * docker's stderr is the exact move that produced the incident this file exists to prevent.
 * @param {string} command
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { stdio: 'inherit', env });
  if (result.error !== undefined) {
    fail(`${command} could not be executed: ${result.error.message}`);
  }
  // A signal-killed child has status null; treat anything that is not a clean 0 as failure.
  return result.status ?? 1;
}

/**
 * Runs a command and captures stdout. Used only for compose queries whose VALUE we need.
 * @param {string} command
 * @param {string[]} args
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function capture(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error !== undefined) {
    fail(`${command} could not be executed: ${result.error.message}`);
  }
  return {
    status: result.status ?? 1,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
  };
}

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  console.error(`db-lane: ${message}`);
  process.exit(1);
}

/**
 * This worktree's compose project name, straight from compose itself.
 *
 * Asked rather than re-derived: compose owns the directory-name -> project-name normalisation,
 * and a guard that reimplements its subject's rules eventually disagrees with it. The value it
 * reports is the same one it interpolates into BOLUSI_DB_OWNER, so the stamp in the database
 * and the token the test lane expects cannot drift apart.
 * @returns {string}
 */
function composeProject() {
  const { status, stdout, stderr } = capture('docker', ['compose', 'config', '--format', 'json']);
  if (status !== 0) {
    fail(`docker compose config failed (is docker running?)\n${stderr}`);
  }
  /** @type {{ name?: string }} */
  const config = JSON.parse(stdout);
  const name = config.name;
  if (name === undefined || name === '') {
    fail('docker compose reported no project name');
  }
  return name;
}

/**
 * Brings this worktree's postgres up, FATALLY.
 *
 * The whole point: `up` failing must end the process here, not turn into a green test run
 * against somebody else's database three lines later.
 */
function composeUp() {
  const status = run('docker', ['compose', 'up', '-d', '--wait']);
  if (status !== 0) {
    fail(
      `db:up FAILED (exit ${status}) — read the docker output above; the lane stops here.\n` +
        'Nothing downstream may run: a DB test after a failed db:up is exactly how a peer\n' +
        'worktree\'s database ends up serving your "green" (T-14d).',
    );
  }
}

/** Removes THIS worktree's project only — container, network and volume. */
function composeDown() {
  const project = composeProject();
  console.error(`db-lane: removing compose project '${project}' (this worktree's own)`);
  const status = run('docker', ['compose', 'down', '--volumes', '--remove-orphans']);
  if (status !== 0) {
    fail(`db:down failed (exit ${status}) — read the docker output above`);
  }
}

/**
 * The real, docker-assigned host port for this worktree's postgres.
 * @returns {string}
 */
function composePort() {
  const { status, stdout, stderr } = capture('docker', ['compose', 'port', 'postgres', '5432']);
  if (status !== 0 || stdout === '') {
    fail(
      "could not resolve this worktree's postgres port — is it up?\n" +
        `Run 'pnpm db:up' first.${stderr === '' ? '' : `\n${stderr}`}`,
    );
  }
  // "127.0.0.1:49158" — take the last colon-separated field so an IPv6 host cannot confuse it.
  const port = stdout.slice(stdout.lastIndexOf(':') + 1);
  if (!/^\d+$/.test(port)) {
    fail(`docker compose port returned an unparseable mapping: ${stdout}`);
  }
  return port;
}

/**
 * Resolves the connection target for this invocation.
 *
 * Two lanes, and the difference is who provisioned the database:
 *   - EXTERNAL: DATABASE_URL is injected from outside (CI's service container, which the
 *     workflow created for this job alone). Compose is not involved and the URL is used as-is.
 *     The owner token is passed through untouched — this runner does not invent one, and does
 *     not demand one either: BOLUSI_DB_OWNER is required by whatever CHECKS it (the db-server
 *     attribution gate, test/global-setup.ts), so the postgres test lane cannot run without a
 *     verified token while `db:migrate` is not made to carry one nobody reads.
 *   - COMPOSE (local): no DATABASE_URL, so bring up THIS worktree's own project and derive the
 *     URL from its real, docker-assigned port. Attribution here is true by construction —
 *     docker itself told us which port belongs to our project — and the gate then confirms it
 *     against the stamp the container was born with.
 * @param {string} database
 * @returns {{ url: string, owner: string | undefined, lane: 'external' | 'compose' }}
 */
function resolveTarget(database) {
  const externalUrl = process.env['DATABASE_URL'];
  if (externalUrl !== undefined && externalUrl !== '') {
    return { url: externalUrl, owner: process.env['BOLUSI_DB_OWNER'], lane: 'external' };
  }

  const project = composeProject();
  composeUp();
  const port = composePort();
  return {
    url: `postgres://${DEV_USER}:${DEV_PASSWORD}@127.0.0.1:${port}/${database}`,
    owner: project,
    lane: 'compose',
  };
}

function main() {
  const argv = process.argv.slice(2);
  const separator = argv.indexOf('--');
  const flags = separator === -1 ? argv : argv.slice(0, separator);
  const command = separator === -1 ? [] : argv.slice(separator + 1);

  let database = 'bolusi_rls_test';
  /** @type {'up' | 'down' | 'url' | 'exec'} */
  let mode = 'exec';

  for (const flag of flags) {
    if (flag === '--up') mode = 'up';
    else if (flag === '--down') mode = 'down';
    else if (flag === '--url') mode = 'url';
    else if (flag.startsWith('--db=')) {
      database = flag.slice('--db='.length);
      if (!KNOWN_DATABASES.has(database)) {
        fail(`unknown --db '${database}' (expected one of: ${[...KNOWN_DATABASES].join(', ')})`);
      }
    } else fail(`unrecognised flag '${flag}'`);
  }

  if (mode === 'down') {
    composeDown();
    return;
  }

  if (mode === 'up') {
    // Bring up this worktree's own project, then TELL the operator what it got. The port is
    // ephemeral by design, so printing it is not decoration: it is how a human ever finds
    // their own database again.
    const project = composeProject();
    composeUp();
    console.error(
      `db-lane: project '${project}' is up — ${resolveUrlForDisplay(project, 'bolusi_dev')}`,
    );
    return;
  }

  const { url, owner, lane } = resolveTarget(database);

  if (mode === 'url') {
    // stdout carries the URL and nothing else, so `DATABASE_URL=$(pnpm -s db:url)` works.
    // Every diagnostic in this file goes to stderr for exactly this reason.
    console.log(url);
    return;
  }

  if (command.length === 0) {
    fail('no command given — usage: node scripts/db-lane.mjs [--db=NAME] -- <command...>');
  }

  console.error(`db-lane: ${lane} lane · owner '${owner ?? '(none)'}' · ${redact(url)}`);

  const [executable, ...args] = command;
  const env = { ...process.env, DATABASE_URL: url };
  if (owner !== undefined) env.BOLUSI_DB_OWNER = owner;
  const status = run(executable, args, env);
  process.exit(status);
}

/**
 * @param {string} project
 * @param {string} database
 * @returns {string}
 */
function resolveUrlForDisplay(project, database) {
  return `postgres://${DEV_USER}:***@127.0.0.1:${composePort()}/${database} (owner '${project}')`;
}

/**
 * @param {string} url
 * @returns {string}
 */
function redact(url) {
  return url.replace(/:\/\/([^:]+):[^@]*@/, '://$1:***@');
}

main();
