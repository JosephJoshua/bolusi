# TASK 119 — the notes screens are built + mounted-tested but not reachable in the running app: Root passes session:null, so no session-scoped NotesRuntime is constructed (the 40->102 / 20->105 inert-until-wired pattern)

**Status:** todo
**Priority:** MEDIUM — the reference module UI (task 96) exists and is proven by mounted tests over the REAL query/command/projection runtime, but the live app shell never constructs a NotesRuntime, so a real user cannot reach the notes screens yet. Same "typed, tested, and unwired on the target" class as tasks 102 (denial timer) and 105 (realtime adapters).
**Depends on:** 96, 24, 88, 89 (the session/auth wiring)
**Blocks:** the visual harness (116) rendering the notes screens via the LIVE nav (it can still render them via a demo route meanwhile)
**SEC ids owned by THIS task:** none.
**Filed by:** the orchestrator, 2026-07-21, from task 96's flagged gap #4.

## The finding (task 96)
`packages/modules/src/notes/screens/*` + the `NotesRuntime` port/provider ship and are green, but `apps/mobile` Root passes `session: null` and the new optional `App.notes` seam is never given a live session-scoped `NotesRuntime`. So `home` renders the empty shell; the notes screens are unreachable in production.

## Deliverable
- Wire the session/auth flow so that after enrollment + PIN unlock, a session-scoped `NotesRuntime` is constructed (over the real query/command/projection runtime the mounted tests already use) and passed through `App.notes` into the navigator, making the notes screens reachable in the running app.
- **Falsify (§2.11):** a composed-app test (task 69's render lane / the app harness) that mounts the live shell post-session and asserts the notes screens are reachable + render a seeded note; break the wiring (session stays null) -> the notes route is unreachable -> RED -> restore -> green. Prove it against the REAL runtime, not a fixture.
- `pnpm typecheck`/`lint`/`test` green.

## Note
Filed so the built-ahead screens do not sit inert. Standing check for this repo: "who constructs this in production?" -- here, nobody yet.
