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
install gitleaks before committing. Claude Code cloud sessions install a pinned,
checksum-verified gitleaks through `.claude/hooks/session-start.sh`. CI also
scans committed history.

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

The phone catalog (model names and photos for intake) is crawled from GSMArena by
a slow, resumable CLI that writes as the table owner, so give it the owner role's
URL, not the app role's. It honours robots.txt (including Crawl-delay), waits 1 s
(with jitter) between requests, and on 429/503 waits, doubles the gap for the rest
of the run and stops if refused repeatedly. A first full crawl is about 28k
requests (listings, photos, spec pages), so most of a day; try a short run first:

```sh
DATABASE_URL=<owner url> pnpm --filter @bolusi/server crawl-phone-catalog --max-requests 20
```

`--brands "Samsung,Apple"`, `--phases list,photos,details` and `--delay-seconds`
narrow a run. Devices download the catalog after sync and photos when shown.
GSMArena refuses cloud and datacenter addresses (429s, a Cloudflare check), so
run it from a home or office connection; the crawler never tries to get past a check.

To click through the screens in a browser without a server or device, run
`pnpm dev:web`; hosted previews of main and each PR are in [Previews](previews.md).

Mobile's `EXPO_PUBLIC_API_URL` must reach the server (typically
`http://10.0.2.2:3000` on Android emulator; a phone needs a reachable LAN address).

### Counter PC app

The Windows counter app (`apps/desktop`) is Electron with its own React DOM screens
(`packages/ui-web` and `packages/modules/src/repair/desktop`). The phone's offline core
(`packages/device`: SQLite store, op log, sync, media, PIN sessions) runs in an Electron
utility process (`src/core`, bundled to `dist/main/core.js`); the window reaches it over a
MessagePort (`src/renderer/core-client.ts`) and never sees a secret. Secrets are sealed
with Windows DPAPI (`safeStorage`) by the main process. The PC enrols like a phone.

```sh
pnpm exec tsc -b
pnpm harness:serve-lane                # a local server with an owner (prints the login and PIN)
BOLUSI_API_URL=http://127.0.0.1:3000 pnpm --filter @bolusi/desktop start
BOLUSI_DESKTOP_DEMO=1 pnpm --filter @bolusi/desktop start   # seeded demo, no core
pnpm --filter @bolusi/desktop dev     # renderer only (demo), in a browser at localhost:5183
pnpm --filter @bolusi/desktop e2e     # Electron end-to-end tests; use xvfb-run on Linux
```

`BOLUSI_API_URL` is read when the app is built (written to `dist/main/build-config.json`)
and, in a development run, also at start. `BOLUSI_DESKTOP_DATA_DIR` keeps a development
run's data away from a real install. On Linux without a keyring, development runs seal
secrets with Electron's fixed key; an installed app never does. The e2e suite starts its
own server (`e2e/live.spec.ts`) and runs the screen tests over the demo.

`apps/desktop/test/repair-journey.test.ts` (part of `pnpm test`) takes one servisan from intake to
handover across a counter PC, a technician's device and a newly registered one, each running the
real offline core against a real server, with the network cut and requests lost before and after
the server saved them, and a power cut with unsent work. It checks that every device and the
server end with the same servisan, each change once, and balanced books. Run it after changing
sync, repair or money.

Printing: the printer and paper are picked once in the app's Settings and kept in
`device-settings.json` in the app's data folder. Dot-matrix paper (continuous) goes to
the printer as a RAW ESC/P job through the Windows spooler (`src/main/raw-print.ts`,
PowerShell calling winspool); A4/A5 pages print without a dialog. The printer's
Windows driver should be "Generic / Text Only" or an Epson ESC/P (v3) driver; a v4
(XPS-only) driver does not pass RAW jobs. CI's `desktop-windows` job spools a real job
to a file-port printer, builds the installer, installs it and runs the e2e suite on it.

Photos and signatures: the webcam and the on-screen pad when the PC has them, otherwise
a store phone, through the server (`apps/server/src/handoff`). The PC asks the server for
a pairing and shows the phone page's address (`<BOLUSI_API_URL>/h/<key>`) as a QR; the
phone opens it once in its own browser and stays paired, so every later photo and the
signature appear on it by themselves (signatures on a landscape pad). Both need the
internet at that moment. The pairing lives in the server’s memory and ends on "Ganti HP",
a server restart, or 30 minutes without a step.

Releasing: set the `BOLUSI_API_URL` repository variable to the production server once
(the workflow refuses to build without it), bump `version` in `apps/desktop/package.json`,
merge, then push a tag `desktop-v<version>`. The `desktop-release` workflow builds the unsigned per-user
installer on Windows and publishes it with `latest.yml` to that GitHub Release.
Installed apps check the latest release a minute after start and every 4 hours,
download in the background and install on the next close (or "Pasang sekarang" in
the sidebar). Updates only look at the repository's latest release, so keep other
release kinds out of this repository or mark them pre-release. `pnpm --filter
@bolusi/desktop dist` builds the installer locally (on Windows; Linux needs wine).

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

## Benchmarks

Two scripts measure sync with realistic repair tickets. Build first (`pnpm exec tsc -b`).

```sh
pnpm --filter @bolusi/modules bench:first-sync
DATABASE_URL="$(pnpm -s db:url)" pnpm --filter @bolusi/modules bench:sync-load
SCALE=x100 SCENARIOS=burst,outage DATABASE_URL=... pnpm --filter @bolusi/modules bench:sync-load
```

`bench:sync-load` starts the real server on a disposable `bolusi_load` database
and drives simulated stores through a busy hour, a burst, a reconnect storm after
an outage, and new phones doing their first sync. Its header lists the settings.
To see which statements cost the most, run Postgres with pg_stat_statements:

```sh
docker run -d --name bolusi-load-pg --cpuset-cpus 1,2 -p 127.0.0.1:55432:5432 \
  -e POSTGRES_USER=bolusi -e POSTGRES_PASSWORD=bolusi postgres:16 \
  -c shared_preload_libraries=pg_stat_statements -c max_connections=200
DATABASE_URL=postgres://bolusi:bolusi@127.0.0.1:55432/postgres PG_CONTAINER=bolusi-load-pg \
  SERVER_CPUS=0 pnpm --filter @bolusi/modules bench:sync-load
```
