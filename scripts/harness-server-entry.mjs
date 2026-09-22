// Shared process scaffold for the root-level, long-lived harness SERVER entries (task 209):
// `harness-serve-lane.mjs` (the production-auth emulator lane) and `harness-chaos-server.mjs` (the
// CHAOS-03/06/07 host binding). Both are spawned as separate Node processes whose sockets must outlive
// the driver's blocking `adb`/`maestro` calls, so both needed the same three things — and carried their
// own copy of each. A fix to the SIGTERM/exit handling had to be made twice, which is exactly the drift
// CLAUDE.md §2.8 exists to prevent.
//
// What is NOT here: each entry's own boot/provision body, and its own import list. Only the
// process-lifecycle plumbing is shared.
//
// RESOLUTION (why the entries import relative `dist/`, not `@bolusi/harness`): the repo-root
// `node_modules` carries NO `@bolusi/*` workspace link, so a bare package specifier would not resolve
// for a script that lives at the repo root. The built barrel `packages/harness/dist/index.js` resolves
// its OWN transitive `@bolusi/*` from the harness's own `node_modules` (Node resolves a module's
// imports from the module's location, not the entry script's). So both entries require the harness +
// deps BUILT (`tsc -b`), which the lanes do before invoking them.
import { register } from 'tsx/esm/api';

/**
 * Install a TS-capable ESM loader. MANDATORY for any entry that calls `startHarnessServer()`.
 *
 * That call runs the DB migrator (packages/db-server/src/migrator.ts), which uses Kysely's
 * `FileMigrationProvider` to dynamically `import()` the RAW `.ts` migration files under
 * `packages/db-server/migrations/` — and those import `.js` sibling specifiers (NodeNext). A bare
 * `node` child cannot load `.ts`, so that dynamic import dies
 * `ERR_MODULE_NOT_FOUND: Cannot find module '.../schema/security.js' imported from
 * .../migrations/0001_roles.ts`, `main()` reds, and the driver reads no marker.
 *
 * Uses tsx's OWN `esm/api` register() — NOT `node:module`'s `register('tsx/esm', …)`, which tsx
 * rejects with "tsx must be loaded with --import instead of --loader" (the deprecated loader path).
 * The bare specifier resolves from THIS file's location up to the root `node_modules/tsx` (a root
 * devDep), cwd-independent, so it works wherever a driver spawns the entry.
 *
 * Call it at module scope, before `main()`. The entries' static imports are compiled `dist/*.js` and
 * need no loader; only the runtime migration `import()` inside `startHarnessServer` does, and that
 * runs later. Falsify by deleting the call: the child dies with the ERR_MODULE_NOT_FOUND above and the
 * child-boot scenario reds.
 */
export function registerTsLoader() {
  register();
}

/**
 * Tear down on the driver's SIGTERM or a Ctrl-C.
 *
 * Register BEFORE the first boot so a signal arriving mid-boot still releases whatever came up.
 * `closeAll` is called with no arguments and should close whatever the entry has opened SO FAR — pass
 * a closure over a mutable holder (one `running`, or an array the entry appends to as each server
 * boots), never a snapshot taken at registration time, or a failure while booting the second server
 * leaks the first.
 *
 * Idempotent (repeat signals are ignored), and exits 0: a clean shutdown on request is success, not a
 * fault. Exit happens in a `finally`, so a throw while closing still terminates the process rather
 * than wedging a child the driver is waiting on.
 *
 * @param {() => Promise<unknown>} closeAll
 */
export function installShutdownHandlers(closeAll) {
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try {
      await closeAll();
    } finally {
      process.exit(0);
    }
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

/**
 * Run an entry's `main`, reporting a boot/provision failure LOUDLY and NON-ZERO.
 *
 * The driver then reads no ready-marker/handshake and reds its lane — it cannot skip (§2.11). stderr,
 * so the driver's failure capture shows it; `error.stack` when there is one, because the stack is what
 * makes a lane failure diagnosable from CI logs alone.
 *
 * @param {string} prefix log prefix identifying the entry, e.g. `harness-serve-lane`
 * @param {() => Promise<unknown>} main
 */
export function runEntry(prefix, main) {
  main().catch((error) => {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.error(`${prefix}: ${detail}`);
    process.exit(1);
  });
}
