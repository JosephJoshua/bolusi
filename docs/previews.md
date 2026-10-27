# App previews

The browser version of the phone app renders the real screens over in-memory
demo data (`apps/mobile/src/web/`). It needs no server, so it is hosted as a
static site. Changes stay in the browser tab; reload to start over. Camera,
signature and sync are simulated, so device QA still happens on Android and iOS.

## Hosted

- `main`: https://josephjoshua.github.io/bolusi/
- Each open PR: https://josephjoshua.github.io/bolusi/pr-preview/pr-<number>/
  (linked in a PR comment, removed when the PR closes).

`.github/workflows/preview.yml` builds and pushes to the `gh-pages` branch.
One-time setup: **Settings > Pages > Deploy from a branch > `gh-pages` / root**.
Only demo data may ever be in this bundle: the site and repository are public.

The start page signs you in as counter, technician, store owner or business
owner. "Switch user" in the avatar menu accepts any PIN and keeps the same
tickets, so one flow can be followed across roles. "All screens" lists every
screen state of the visual harness.

## On a Mac

```sh
pnpm exec tsc -b
pnpm dev:web
```

This serves the same preview with hot reload at http://localhost:8081.

## Later clients

The web app and the Electron desktop app are planned to share one DOM UI
(`docs/product-direction.md`). Once that exists, its static build
deploys the same way under another path (for example `/bolusi/web/`). A web app
that talks to a real server needs a hosted server and demo database; that is a
separate decision about where to run it and how to protect it.
