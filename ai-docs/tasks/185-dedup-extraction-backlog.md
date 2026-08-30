# TASK 185 — dedup extraction backlog (2026-07-26 duplication audit)
**Depends on:** —

> **LEGS 1–3 DONE (2026-07-28); LEG 4 remains (spec-gated).**
> - **Leg 3** — `concatBytes` extracted to `packages/core/src/crypto/bytes.ts` (the platform-free home) and adopted at 3 of the 4 copies (test-support column-AEAD, mobile PNG signer, core media fixture). **The 4th copy — `packages/db-client/src/crypto/aead.ts` — was DELIBERATELY LEFT in place: aead.ts is an `AT_REST_SURFACE` file provenance-anchored to the SEC-AUTH-09 emulator artifact (`device-gate-provenance.ts`, commit 0e2096b), so ANY edit — even importing the shared fn or adding a comment — reds the security-sweep lane "Artifact STALE" and needs a fresh emulator re-run to re-anchor (verified 2026-07-28: re-applied the extraction → guard red with that exact message → reverted). Not worth coupling an emulator run to a dedup nicety; it re-homes for free the next time the emulator lane re-anchors.** Documented in the shared `concatBytes` docstring.
> - **Leg 1** — `createTriggerLoop` extracted to a NEUTRAL `apps/mobile/src/bootstrap/trigger-loop.ts` (NOT the sync `triggers.ts`): FR-1138 (`media/sync-independence.test.ts`) forbids a media source file importing the sync loop's SCHEDULING, so the shared lifecycle lives in its own module both loops build on. Both `createSyncTriggers` + `createMediaTriggers` delegate; behavior-preserving (both trigger suites + the FR-1138 guard green).
> - **Leg 2** — `finalizeMediaCapture` extracted to `apps/mobile/src/media/finalize.ts` (§2.2 steps 5–8: move → hash+size → 11-field row → onCaptured → signed ref); `capturePhoto` + `captureSignature` delegate. Behavior-preserving (capture + signature suites green).
> - **Leg 4** — `@bolusi/sqlite-test-driver` STILL PENDING: it REQUIRES the 08 §3.3 matrix amendment first (its own spec task per §3.3 rule 5 / CLAUDE.md §4), so it is not part of this refactor.

## Goal
Work through the remaining aware-copy duplications a repo-wide audit (jscpd + manual, 2026-07-26) confirmed. Two extractions already landed on `chore/dedup-audit-fixes` (`describeParseFailure` → `core/src/errors/`, keyset pagination → `core/src/query/paginate.ts`); this task carries the rest, each small and independently shippable:

1. **`createTriggerLoop` (apps/mobile)** — `bootstrap/triggers.ts:150-178` and `media/triggers.ts:112-138` hand-roll the same AppState subscribe → arm/disarm interval, NetInfo fires-immediately contract, debounce-cancel lifecycle. A fix to unsubscribe-null handling in one copy does not reach the other today.
2. **`finalizeMediaCapture` (apps/mobile/src/media)** — `capture.ts:145-181` vs `signature.ts:78-110`: the Step 5–8 finalization pipeline (moveToDocuments → hash+size final bytes → `insertMediaItem` 11-field row → onCaptured → signed mediaRef) duplicated; only type/mime/extension and the source-bytes step differ.
3. **Shared low-level bytes home** — the 8-line `concatBytes` helper exists 4× across packages; `AeadCipher` framing (concat, Buffer→Uint8Array pinning, ciphertext||tag layout) is implemented in `db-client/src/crypto/aead.ts` AND `test-support/src/crypto/node-column-aead.ts`. The test-support copy is policy-forced today (08 §3.3 rule 7 keeps the db-client edge type-only); a shared platform-free bytes primitive reachable from both would collapse the value-level duplication without touching the driver rule.
4. **`@bolusi/sqlite-test-driver` — REQUIRES A SPEC CHANGE FIRST.** Five near-identical better-sqlite3 `DbDriver` test adapters (~600 lines: `core/test/projection/`, `db-client/test/`, `modules/test/support/`, harness, mobile-side copy with encryption-key plumbing) exist solely because 08 §3.3 hard rule 2 ("nothing outside db-client/db-server imports a DB driver"; harness the one ratified exception) has no home for a shared test driver. Proposed amendment, for its own spec task per §3.3 rule 5 + CLAUDE.md §4: add a dev-only `@bolusi/sqlite-test-driver` row to the §3.3 matrix (may import: `db-client` type-only, better-sqlite3; importable from: test files and harness only, same test-only clause as rule 6), preserving rule 2's intent — no driver in shipping deps. The audit was NOT allowed to make this edit as an implementation side effect; that is why this leg is a backlog item and not a commit.

## Docs to read
- `08-stack-and-repo.md` §3.3 (boundary matrix — leg 4's amendment target) + §3.4.
- `06-media-pipeline.md` §2.2–2.3 (legs 1–2 touch the capture pipeline steps).

## Skills
- `superpowers:test-driven-development`; `superpowers:verification-before-completion`.
- Worktree isolation per CLAUDE.md §2.3 — first step: `git branch --show-current`; STOP if on main.

## Acceptance
Each leg lands with: the shared implementation + tests, every former copy importing it (or, for leg 4, the ratified spec row landing BEFORE the package), `pnpm typecheck`, `pnpm lint`, affected package vitest suites, and `pnpm knip` green. Audit trail: this task closes the bolusi findings of the 2026-07-26 cross-repo duplication audit.
