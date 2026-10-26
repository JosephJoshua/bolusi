# Development

## Install

Use Node 22 (`.nvmrc`) and the pnpm version pinned in `package.json`. Real PostgreSQL
integration tests require Docker. Mobile requires an Expo development build because
its SQLite and crypto adapters are native modules; Expo Go cannot run this app.

```sh
nvm use
corepack enable
pnpm install --frozen-lockfile
```

On the existing Linux host, select Node 22 if the default is 24. If pnpm points at
an inaccessible store, pass `--store-dir /home/joseph/.local/share/pnpm/store` on
this host only. Keep machine-specific paths out of shared config.

On restricted networks, installation with `--ignore-scripts` can help, but native
dependencies still need valid build artifacts before SQLite tests can run.
The pre-commit hook formats staged files and scans the staged diff with gitleaks;
install gitleaks before committing. CI also scans committed history.

## Run

Build the shared packages before starting either app; package exports resolve to
`dist/` in a fresh clone. Run `pnpm dev:tsc` in a separate terminal while editing
shared packages to keep those outputs current.

```sh
pnpm exec tsc -b
pnpm db:up
pnpm db:migrate
pnpm db:url
pnpm dev:mobile
```

The DB uses a per-worktree Docker port. Use `pnpm db:url`, not an assumed port 5432.
In another terminal, start the server with the reported URL and your configuration:

```sh
DATABASE_URL="$(pnpm -s db:url)" pnpm dev:server
```

Set `EXPO_ACCESS_TOKEN` in your local environment first. See
`apps/server/.env.example`, `src/config.ts` and `src/main.ts` for boot requirements.
Use `pnpm --filter @bolusi/server provision-tenant --help` for enrollment setup.
Do not paste provisioning secrets into chats or commit them.

To click through the screens in a browser without a server or device, run
`pnpm dev:web`; hosted previews of main and each PR are in [Previews](previews.md).

Mobile's `EXPO_PUBLIC_API_URL` must reach the server (typically
`http://10.0.2.2:3000` on Android emulator; a phone needs a reachable LAN address).

## Verify

```sh
pnpm typecheck
pnpm lint
pnpm i18n:check
pnpm test
```

Translations live in `packages/i18n/catalogs/`. After editing those JSON files,
run `pnpm --filter @bolusi/i18n i18n:gen` to rebuild the bundled resources.
TypeScript derives valid label keys from that data. `pnpm i18n:check` checks
catalog consistency, message syntax, and whether the bundle is up to date.

`pnpm test` builds shared packages and runs the ordinary Vitest projects, including
behavioral security and default-volume chaos tests. PostgreSQL uses Docker and
testcontainers. Tests named `SEC-*` are ordinary regression tests, not entries in
an administrative security inventory.

While developing, select affected projects/files after building:

```sh
pnpm exec tsc -b
pnpm exec vitest run --project core test/sync/staleness.test.ts
```

For schema changes, migrate a disposable DB and run `pnpm db:codegen:check`.
Client type generation is `pnpm --filter @bolusi/db-client db:codegen`; inspect its diff.
Automatic CI runs checks once plus a secret scan. Native Android/iOS builds are
manually dispatched in GitHub Actions; use them for native changes and mobile
verification. They do not establish physical-device performance.
The native harness includes the canonicalization vectors on the app's Hermes
runtime; the separate obsolete host-VM runner has been removed. Security
regressions run with the ordinary harness project, without a separate suite config.

Extended chaos is opt-in: `pnpm chaos:extended`. Reproduce a recorded failure with:

```sh
CHAOS_SEEDS=2693262066 CHAOS_SCALE=4 pnpm chaos
```

Test behavior and meaningful negative cases, particularly permissions, integrity,
and data loss. Copy edits and documentation changes do not need new tests. Do not
add tests that parse guides, require task records, or count checklist coverage.
When a runtime is unavailable, report what could not be verified; a mock or skipped
test does not substitute for Docker, native builds, or physical hardware.
