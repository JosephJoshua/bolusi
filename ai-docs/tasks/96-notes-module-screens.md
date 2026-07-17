# TASK 96 — notes module screens (NotesList / NoteEditor / NoteDetail) — the frontend half of the reference module, carved from task 25

**Status:** todo
**Depends on:** 25, 24, 18
**Blocks:** —
**SEC ids owned by THIS task:** none

## Why this exists (split from task 25, 2026-07-17)

Task 25 (the notes reference module) bundled the platform-free **data layer** (ops v1/v2, applier, commands, queries, conflict-checks, `SERVER_MODULES` registration, i18n catalogs) with **three React Native screens**. The data layer is the critical-path unblocker for task 26 (chaos-harness workload) and task 27a, so it ships first as task 25. The screens are frontend work the owner has explicitly sequenced **later** (D17 / D18 §3 — "frontend is later though", said while choosing the sync loop as the immediate focus). This task carries the screen deliverables so they are **deferred, not dropped** — every 04 §8 / design-system §8.6 screen box lands here, with the same falsification bar.

This is a carve of scope, not a weakening: task 25 delivers and falsifies the data layer those screens sit on (queries, commands, live-query invalidation, media attach at the op level). This task builds the UI over that verified layer.

## Skills
- `frontend-design:frontend-design` — the three notes screens are the ergonomics testbed for **all** future module screens (design-system §8.6); this is where the design system is proven in practice. Also load the impeccable copy-editing skill for the UI strings.
- `superpowers:test-driven-development`, `superpowers:verification-before-completion`.
- Worktree isolation per CLAUDE.md §2.3 — first step `git branch --show-current`; STOP if on main.

## Docs to read
- `design-system.md` §8.6 (the three notes screens, normative shapes), §5 (the four mandatory screen states — **unauthorized ≠ empty**), §3.5/§3.6/§3.10 (sync chip, danger banner, ConfirmSheet for archive).
- `04-module-contract.md` §7 (screens: `useQuery`/`useCommand` only, live-query invalidation rule).
- `01-domain-model.md` §9 (notes semantics — archived is terminal, edit lifecycle).
- `ui-labels.md` (`notes.*` strings — already in the catalogs task 25 shipped; screens consume them, zero hardcoded strings).
- `06-media-pipeline.md` §6 + `api/03-media.md` §3.2 (task-18 capture/attach + download-verify for the thumbnail).

## Files / modules touched
- `packages/modules/notes/screens/` — `NotesList.tsx`, `NoteEditor.tsx`, `NoteDetail.tsx` (RN, `useQuery`/`useCommand` only; task-18 capture flow for attach).
- `packages/modules/package.json` — the `./notes/screens` subpath export (if task 25 did not already land it for the manifest split; confirm, do not duplicate).
- `apps/mobile` — wire the three screens into task-24 navigation (no shell rework).
- **Not touched:** the notes data layer (task 25 owns `manifest/operations/applier/commands/queries/conflict-checks`); `@bolusi/core`, `@bolusi/schemas` (contended).

## Acceptance (the screen boxes carved from 04 §8 / design-system §8.6)

- **Screens (design-system §8.6, review-wave gate):** all three screens ship **all four §5 states** (loading / empty / **unauthorized** / error — unauthorized is distinct from empty and hides the create-CTA without `notes.create`); archive goes through **ConfirmSheet**; editor save is **optimistic** (returns to the list instantly, no spinner); the **rejected-op danger banner** renders on NoteDetail. A mounted-screen test per state (task 69's "no screen is mounted in a test" finding is the standing warning — these must actually render, not just assert a selector).
- **Queries + live update — the UI half of 04 §8 box 5:** with a subscribed `listNotes`, applying a remote op via the pull path makes the **screen** re-render with the new row (04 §7 invalidation), asserted by mounting the screen — not only the query (task 25 owns the headless live-query test; this owns the mounted-screen re-render).
- **Media attach — the UI half of 04 §8 box 8:** NoteEditor's task-18 capture flow attaches a MediaItem; **NoteDetail renders the thumbnail** (download-verify against the signed `sha256`); **NotesList shows the attachment glyph**. (Task 25 owns the op-level assertion that the v2 payload carries the `mediaId`.)
- **i18n live-switch (the demo half of 04 §8 box 7):** ID/EN toggle live-switches all three screens; zero hardcoded strings (`bolusi/no-hardcoded-strings` clean over `packages/modules/notes/screens`). Task 25 owns the catalog-completeness gate; this owns the rendered live-switch.
- **Lint/CI gates:** `bolusi/no-hardcoded-strings` clean over the screens; `bolusi/boundaries` — screens import only from `apps/mobile` and the notes manifest, and `apps/server` never imports `*/screens` (08-stack §3.2); `tsc -b` composite build clean. `pnpm typecheck`/`pnpm lint`/`pnpm test` green — read the output, not the exit code (§2.1).

## Note
Filed by the orchestrator when splitting task 25 (2026-07-17) so the reference module's data spine could unblock task 26 immediately without launching a large frontend effort the owner deprioritized. When the frontend phase begins, this is the first module UI built — do it with the full frontend-design discipline; it sets the pattern every later module screen copies.
