# TASK 155 — nothing writes into the idle-lock work-retention path: a half-typed note is STILL lost on a real device, because no screen feeds `updateWorkspace`

**Status:** todo
**Priority:** **HIGH (raised 2026-07-23 by D23 §1)** — no longer a leftover. The owner ruled that a push-notification tap must **preserve the draft and then navigate** (task 159), and this retention path is the mechanism that ruling depends on. Until this ships, 159 cannot be implemented at all, and implementing 159 partially ("navigate and hope") would ship the silent draft-loss the ruling exists to remove.

Original framing, still true: UX/ergonomics, NOT a security hole (task 133's lock fires and clears identity correctly regardless). It is the unmet half of 133's deliverable #3 ("a lock must NOT discard the half-written note"), and it was disclosed-but-untracked — the exact pattern that let the original SEC-AUTH-08 inertness sit.
**Depends on:** 133 (the retention path + lock, merged 2026-07-22), 96 (NoteEditor)
**Blocks:** **159** (D23 §1 — preserve-then-navigate needs this path to write into)
**SEC ids owned by THIS task:** none.
**Filed by:** the task-133 reviewer, 2026-07-22 (F1), verified by the orchestrator.

## The finding
Task 133 shipped the work-retention PATH live and tested (through task 14's per-user `user-workspaces` map): a lock preserves whatever draft is in the workspace, unlock restores it. **But `updateWorkspace` is exercised only by tests — no screen and not even `Root` wires it.** `App` has no draft prop; `NoteEditor` keeps its in-flight `title`/`body`/`mediaRef` in local `useState`; nothing reads `workspace.route`. So on a real device, an idle lock mid-edit still discards the note — the retention machinery runs over an empty workspace.

**This is 133's own honest disclosure** (`bootstrap/session.ts:34-44` + both idle-lock test headers). 133 correctly removed a `textsIn(...)` "draft on screen" assertion because no screen renders a draft, so it could never red (§2.11 — a guard that can't fail is worse than none). The residual is real, bounded (UX not security), and now tracked here.

## Also fold in (task-133 review F2)
`withRoute` (`user-workspaces.ts`) is a genuinely dead export today — zero callers, no test — accepted into the knip baseline as **built-ahead of THIS task**. Its sibling `withDraft` is test-exercised. When you wire the draft seam, consume both `withDraft` and `withRoute` (a lock should restore the route the user was on, not just the text), or drop `withRoute` if the route-restoration is out of scope.

## Also correct (task-133 review F1)
`apps/mobile/src/bootstrap/session.ts:42-43` currently says the draft seam is "owned by other queued tasks" — which was FALSE when written (no such task existed). Correct it to reference THIS task id.

## Deliverable
Wire `NoteEditor`'s in-flight draft into the workspace retention seam so an idle lock preserves it and unlock restores it (text + route). Read `design-system.md` §8.1 (the lock/unlock UX) and task 14's `user-workspaces` contract first. `@bolusi/modules`' `NoteEditor` is contended — serialize against other module work.

## FALSIFY (§2.11 — REPORT it)
- A COMPOSED test (real Root, real session): type a note body, advance the clock past `idleLockSeconds`, unlock with PIN → the body is STILL THERE (and the route restored). This is the assertion 133 could not write because no producer existed. Break the wiring → it reds. Restore → green.
- **Positive control:** a lock with an EMPTY editor restores nothing and does not error — so "always restores" can't pass vacuously.
- This closes the loop 133 opened: the retention path finally has a producer a test can drive through the UI.
