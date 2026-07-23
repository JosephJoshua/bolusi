# TASK 130 — five shipping controls are wired to `noop`, and two built capabilities have no production consumer

**Status:** in-progress
**Priority:** MEDIUM — controls that render, respond to touch, and do nothing. The "sound tests, zero callers" class (CLAUDE.md §2.11); component tests inject `vi.fn()` and assert the callback fires, so they can never see what the composition root actually passes.
**Depends on:** 82, 96, 119, 24
**Blocks:** —
**SEC ids owned by THIS task:** none.
**Filed by:** QA spec-verify sweep, 2026-07-22 (items D6/D7/D11).

## The finding

**Wired to `noop` in the shipping app** (`apps/mobile/App.tsx:220-221, 258-259`, noop at `:328`):
- `onRetryMedia` — 06 §5.2(e) requires "manual retry from the sync-status screen". `MediaClient.requestManual()` has **zero** production callers (contrast `SyncClient.requestManual()`, wired at `Root.tsx:431`).
- `onOpenRejected` — 06 §8 / 05 §2.3: rejections "must be surfaced, never silent"; every `failed` item visible with its `lastErrorCode`.
- `onEnroll`, `onRetry` on SwitcherScreen — and `SwitcherScreen.tsx:87,97` wires `onRetry` to BOTH the §5 Error retry and the Unauthorized back, so both dead-end (design-system §5 MUST-NOT).

**Built but unconsumed:**
- `MediaClient.storageBand()` (`media/client.ts:314`) — 06 §7's `< 500 MB` Warning / `< 200 MB` Loud banners. Computed, exposed, read by nobody in the native app; the only `StorageBand` consumer outside `media/*` is `CaptureScreen`, itself reachable only from the web gallery. **06 §7's storage banners have never rendered.**
- The in-app camera has no shipping entry point (`bootstrap/notes.ts:71-73,96` — `capturePhoto` stays `UNWIRED_NOTES_MEDIA` and rejects). 06 §2.1 says "the shared `MediaCapture` component is the only capture surface". Honestly documented in code, but **no task in `_index.md` owns the wiring** (18 and 82 are both `done`) — so it is nobody's.

## Deliverable
- Wire the five controls to their real producers, or remove the affordance (a control that cannot work must not render — §5 MUST-NOT). Decide per control and say which.
- Wire the storage bands to the capture surface per 06 §7, and give the in-app camera entry point an owner (this task, or a filed successor — do not leave it unowned again).
- **Falsify (the point):** a COMPOSED test that presses each control on the real `App`/`Root` tree and observes the real producer run (e.g. media retry → `requestManual()` called). Re-point one to `noop` → RED → restore. A component test injecting `vi.fn()` proves nothing here — that is exactly what let these ship.

---

## What the implementation found, and what it changes about this task (2026-07-23)

### 1. The bigger finding: two of the five controls were UNPRESSABLE, not merely unwired

`bootstrap/shell-inputs.ts` built the Sync Status input with `pendingOperationCount: 0`,
`rejected: []` and `media: []` as **literals**, under a comment promising they would "become real
reads alongside the notes module (task 25) that first produces ops to count". Notes landed (96/119)
and the reads did not.

So design-system §8.4's item 4 (the rejected-operations list) and item 5 (the media queue) **could
not render on any device, in any state, ever** — not because a device had nothing to show, but
because the input said so. `onOpenRejected` and `onRetryMedia` live on rows inside those two
sections. They were dead callbacks on rows that could not exist.

That is why a component test could never have caught this and why wiring the callbacks alone would
have been worthless: a composed test cannot press a row no input can produce, so the "proof" would
have been another green that proves nothing (CLAUDE.md §2.11). Same class as the inert-mechanism
cluster (133–140) — a shipped surface with no producer behind it.

Fixed: `bootstrap/sync-status-reads.ts` (new) reads all four from the op log and the media queue;
`shell-inputs.ts` takes them; `Root` re-reads on the projection-invalidation bus and the loop tick.
`quarantined` deliberately stays `[]` and is **not** the same defect — see task 169.

### 2. Per-control decisions

| Control | Decision | Producer / reason |
| --- | --- | --- |
| `onRetryMedia` | **WIRED** | `MediaClient.requestManual()` (06 §5.2 (e)), via a new `AppProps.onRetryMedia` supplied by `Root`. Separate from `onSyncNow` because FR-1138 keeps the two loops independent. |
| `onOpenRejected` | **WIRED** | Discloses the §8.4-item-4 detail in place: `rejectionCode` + the server's `rejectionReason` under `sync.rejected.technicalDetails` — a catalog key that shipped with **zero consumers**. ui-labels §sync specifies exactly this treatment ("shows only as collapsed technical detail"), so a second screen would have had to re-render the same sentence to justify existing. |
| SwitcherScreen `onRetry` (§5 Error) | **WIRED** | `AppSessionController.refresh()` — the directory read that threw is the only thing that can clear the state. |
| SwitcherScreen Unauthorized back | **WIRED, and split off** | It shared the single `onRetry` prop with the Error retry: two different intents, one callback, so no value could be correct for both. Now its own `onUnauthorizedBack`, wired to the shell's one `goBack` (so §8.2's "the lock has no back" still holds via `backTarget`). |
| `onEnroll` (empty-roster CTA) | **AFFORDANCE REMOVED** (owner ruling D23 §3) | Raised rather than decided alone: wiring it needs a new input on `resolveZone` (the security gate) and runs api/02-auth §7.4 re-enrollment — new `deviceId`, new keypair, fresh chain at seq 1, old registration left `active` server-side (03 §5 has no `active → re-enroll` transition). The owner ruled the flow out of v0 on exactly those two costs, and ruled that leaving it inert was NOT available either (§5 forbids rendering a control that cannot work). So: `createLabel`/`onCreate` dropped, the `onEnroll` prop **deleted** rather than stubbed (a surviving prop is how the affordance grows back), and the Empty state carries guidance text naming the real-world action — new catalog key `auth.switcher.emptyUsers`, Indonesian-first, seeded through `ui-labels.md`. Task 168 carries the flow to v1 with both costs written up as known work. |

### 3. The two built-but-unconsumed capabilities

Both are now consumed, by the same new piece: `media/CaptureHost.tsx` (the promise/screen bridge) +
`media/native-capture.tsx` (the `expo-camera` binding), mounted by `Root`, rendered by `App`, and
handed to the notes attach seam through `notesMediaSeamsFor(media, capturePhoto)`.

- `MediaClient.storageBand()` now drives `CaptureScreen`'s 06 §7 banner (`warning` / `loud`) and its
  `capture_refused` whole-screen refusal.
- The in-app camera entry point is OWNED by this task and shipped. `createExpoCameraCapture`
  (task 18, previously zero callers) and `CaptureScreen.tsx` (task 116, previously unreachable
  outside the web gallery) both dropped off the knip unused-production baseline as a result — an
  independent witness that the wiring is real, since knip measures production reachability.

### 4. Falsifications run (each one broken, observed, reverted)

Composed suite: `apps/mobile/test/live-shell-dead-controls.test.tsx` — mounts the real `Root` with
production factories, navigates by tapping, asserts on producers. 8/8 green.

| Broken | Observed failure |
| --- | --- |
| `onRetryMedia` → `noop` | `AssertionError: expected [] to have a length of 1 but got +0` |
| `onOpenRejected` → `noop` | `Error: Expected exactly 1 node with testID sync-rejected-reason-<opId>, found 0` |
| switcher `onRetry` → `noop` | `AssertionError: expected false to be true` (the roster never returns after the cause is healed) |
| notes capture seam → `UNWIRED_NOTES_MEDIA` | `Error: notes capture is not wired (no media seams injected)` ×4; 3 tests red |
| `storageBand()` → hardcoded `'normal'` | 2 band tests red (`expected null not to be null`) |
| `syncInput` → the literals it shipped with | 2 tests red, incl. `the rejected op never reached the sync-status list` |
| `zone.kind === 'shell'` conjunct dropped from the capture render | `AssertionError: the idle lock never reached the shell: expected false to be true` |
| `createLabel`/`onCreate` restored on the empty roster | `AssertionError: expected TestInstance{ instance: { …(9) } } to be null` (the CTA node reappears) |
| `auth.switcher.emptyUsers` made illegal in `ui-labels.md` (2 segments, snake_case) | key-grammar gate RED naming it in BOTH legs: `ai-docs/ui-labels.md: key 'auth.empty_users' has 2 segment(s)` and, after re-seeding, `packages/i18n/catalogs/auth/{id,en}.json: key 'auth.empty_users' has 2 segment(s)` |

### 5. Two defects this task found in its OWN work, recorded because they are the house failure mode

- **FINDING 5a — a negative control that passed vacuously (testing-guide T-14b).** The test asserting "a `normal`
  storage band renders NO banner" stayed **green** while the capture surface did not exist at all —
  discovered only because the seam-revert falsification turned its three neighbours red and left it
  alone. A screen that never opened also has no banner. Fixed by asserting the viewfinder is live
  first, so the negative assertion has to be looking at its subject.
- **FINDING 5c — a comment that asserted the opposite of its own code (CLAUDE.md §2.11).** The capture surface's
  first draft returned early on `capture !== null` alone, under a comment claiming that a mid-capture
  idle lock would still lock. It could not: an unconditional early return never reads the zone it had
  just computed, so a locked device would have gone on rendering a **live viewfinder** over an ended
  session (api/02-auth §6.4). The gate now wins by construction (`zone.kind === 'shell'`), and the
  claim is a test rather than a second comment.

- **FINDING 5b — the i18n key-grammar gate was falsified before the new key was trusted.**
  CLAUDE.md §2.11 records that this gate was once green *because* the parking mechanism kept the
  illegal keys out of the catalogs it read. So `i18n:check` passing was not accepted as evidence:
  `auth.switcher.emptyUsers` was temporarily rewritten to `auth.empty_users` (2 segments AND
  snake_case) and the gate went RED naming it in both legs — the `ui-labels.md` row leg immediately,
  and the catalog leg after re-seeding. Restored; all 9 gates green. Both locales were then read out
  of the generated catalogs (78 and 71 characters) rather than trusted, because task 165 documents
  that a BLANK `id` cell passes seed + gen + check with all 9 gates green.

### 6. Found, not fixed (filed)

- **168** — the v1 device-enrollment flow, filed with both costs (the `resolveZone` input and the
  orphaned `active` registration) written up as known work, per D23 §3.
- **169** — the Sync Status quarantine section can never render: no client table or column persists a
  held-out pull batch (api/01-sync §4). Its model tests are green **because** the data is
  unreachable, not because the behaviour is right.
