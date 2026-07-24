# TASK 132 — coverage gaps: a shape-asserted chaos seam with no consumer, an untested Android back handler, and a catalog guard that proves membership but not content

**Status:** in-progress
**Priority:** MEDIUM — each is a guard or a seam that looks covered and is not. Filed from the coverage half of the sweep so the gaps are owned rather than rediscovered.
**Depends on:** 26, 123, 24
**Blocks:** —
**SEC ids owned by THIS task:** none.
**Filed by:** QA spec-verify + coverage sweep, 2026-07-22.

## Gaps

1. **The chaos `schemaVersion` seam is dead data.** `script.test.ts:97` and `seed-200k.test.ts:72` assert the generator's `schemaVersion` output — but **nothing consumes it**: `generateScript` is imported by no chaos scenario, and `HarnessDevice.createNote` goes through the real command runtime, which stamps the CURRENT version. So the harness has never folded a v1 or v2 `note_created`. The generator is also capped at `1 | 2`, so it can never emit the version production actually sends. testing-guide §3.2.2's obligation is currently satisfied by a shape assertion with no behaviour behind it; the v1/v2 fold paths are covered only by `packages/modules/test/migration.test.ts` hand-building ops.
2. **`useHardwareBack` has no test at all** (used at `App.tsx:144`). Its own header claims "the subscription is re-created whenever `handler` changes … a stale closure left registered would answer for a screen that is no longer on top" — unproven. `zone.ts`'s `backTarget` decision IS tested; the Android `BackHandler` subscription is not. "Typed and compiling ≠ running on the target": Android back could answer for the wrong screen.
3. **The module-catalog guard proves membership, not content** (`module-catalog-coverage.test.ts`, task 123). Set-equality both directions plus a non-vacuity test is genuinely good — but a row with `catalogs: {id:{}, en:{}}` or a no-op `register` passes. The content proof (`notes-catalog-boot.test.tsx`) is hard-coded to `notes` and does not generalize with the registry. Also the denominator regex at `:44` (`^\./([a-z][a-z0-9]*)/screens$`) excludes any module id containing `-` or `_` — such a module drops out of BOTH sides and the equality still passes.
4. **No app-layer media↔sync independence guard.** `packages/core/test/media/sync-independence.test.ts` covers both directions with denominators and a positive control (verified), but the app layer has none: `apps/mobile/src/media/triggers.ts:18-23` and `media/client.ts:78` import from `../bootstrap/triggers.js` (the sync trigger module). Legitimate today — two interval constants and two port types — but nothing asserts it stays that way. FR-1138 erosion at the one layer the core guard doesn't reach. LOW.

## Deliverable
Close each: make the chaos seam actually fold old versions (or delete the dead generator field and say so); test `useHardwareBack`'s subscription lifecycle; extend the catalog guard to assert non-empty content per registered module and widen the id regex; add the app-layer independence assertion. Each fix must be **falsified** — break the thing, watch the specific guard red, restore.


---

## PARTIAL — items 2 and 3 landed 2026-07-22 (merged, reviewed, APPROVED). Items 1 and 4 remain open.

- **Item 2 (`useHardwareBack`)** — 6 tests; the reviewer reproduced all three falsifications and verified the RN double against BOTH the 0.86 docs (Context7) and the installed `Libraries/Utilities/BackHandler.android.js`. The subtle part held up: test 3 alone is *structurally blind* to a leaked subscription, because RN iterates in reverse and the newest handler's `true` consumes the press first — which is why test 4's handler must **decline**. Verified at the source, not the docs.
- **Item 3 (catalog guard)** — 4 → 12 tests, content folded over `CLIENT_SCREEN_MODULES` with no module id as a literal. The task's own premise about hyphenated ids was **refuted** by the implementer (T-16): `defineModule` validates ids against `/^[a-z][a-z0-9]*$/` (`packages/core/src/module/define-module.ts:193`) and throws at module-evaluation time, so such a module cannot reach `ALL_MODULES` at all. The reviewer confirmed independently and judged the widened regex alone *would* be over-engineering — `unparsedScreensExportKeys` is the load-bearing half, and it reds against the real `packages/modules/package.json`.
- Residual findings from the review are **task 150** — most importantly that blank catalog values still pass every generalized assertion.

**Still open here: item 1** (the chaos `schemaVersion` seam is dead data no scenario consumes) **and item 4** (no app-layer media↔sync independence guard).

---

## PARTIAL 2 — items 1 and 4 landed 2026-07-23 (impl-132b). Task now complete pending review/merge.

### Item 1 — RESOLUTION: DELETE the dead `schemaVersion` seam (not wire it). Recommendation + investigation.
Chosen after investigating whether wiring adds real coverage. The either/or was genuine; the evidence points one way:

- **No consumer.** `generateScript` is imported by no chaos scenario — CHAOS-01's `runConvergence` (`packages/harness/src/convergence.ts`) builds its workload directly through the command path and never calls it; a repo-wide grep finds only `script.test.ts` and the index re-export. `generateSeed200k`'s output (`buildSeed()` in `apps/mobile/src/harness/registry.ts`) is only length-tested; no runner reads `op.schemaVersion` off a `ScriptOp`.
- **The field cannot reach a fold even if wired.** Both generators produce descriptors the fixture maps to a REAL `notes.createNote` command (`VirtualDevice.createNote` → `runtime.commands.execute`). The runtime stamps `schemaVersion` from the operation registry (`ctx.ts` — `resolveSchemaVersion(draft.type)`, "never defaulted, never caller-supplied"; `OpDraftInput` has NO `schemaVersion` field by explicit contract). So the descriptor's version is dropped at the command boundary — wiring `generateScript` into a scenario would fold the CURRENT version, never v1/v2. And the cap `1 | 2` can't even name production's current version (v3, `commands.ts`).
- **The fold behaviour is already covered, at both paths the harness would use.** `packages/modules/test/migration.test.ts` hand-builds a v1→v2→v3 history straddling a cutover and folds it via `applyAppendedOp` (incremental head-apply) AND `rebuild` (canonical replay), plus a v4-rejects-loudly leg. The applier (`applier.ts` `mediaForCreated`) resolves media by the op's DECLARED version, per-op and order-independent — so an out-of-order re-fold re-resolves the SAME way `rebuild` replays, and CHAOS-01 already fires both fold paths over current-version ops. Driving old versions through the chaos harness would require bypassing the command path with hand-built signed ops (exactly migration.test.ts's technique) for no new applier branch.
- **Conclusion.** The `schemaVersion` field is a §2.11 "green for the wrong reason" shape assertion. Deleted: the field on `ScriptOp`, the `cutoverIndex` option that exclusively fed it (kept it → dead input / unused-var lint), and the two shape-assertion tests. Header comments in `script.ts` and `seed-200k.ts` (where the reader looks) now state the seam is deliberately absent and point at `migration.test.ts`.
- **Spec drift filed as task 174** — testing-guide §3.2.2/147/313 and a device-benchmarks decision doc still describe the deleted generator seam (partial overlap with 131 item 6). Not fixed here per CLAUDE.md §4 (spec changes are their own task).
- **Falsification (§2.11), DELETE branch — the "elsewhere" is real:** ran `migration.test.ts`, **3/3 passed** — `INCREMENTAL apply: v1 note → media_id null, v2 note → the attached id`; `FULL REBUILD yields the same rows (04 §8 box 4 — rebuild == incremental)`; `a v4 (unknown) note_created REJECTS LOUDLY — no silent skip (§2.11)`. The v1 AND v2 folds are exercised there for real.

### Item 4 — RESOLUTION: added the app-layer media↔sync independence guard.
`apps/mobile/src/media/sync-independence.test.ts` (5 tests), modelled on the core guard's shape (denominators T-14 + positive control T-17). It is an ALLOWLIST, not a fence: `media/triggers.ts` legitimately mirrors the sync triggers by importing two interval constants + two port TYPES from `bootstrap/triggers.ts`, so the guard forbids a media source file importing any OTHER symbol from that module, plus any sync-scheduling symbol (`createSyncTriggers`, `SyncTriggers`/`SyncTriggerDeps`, `SyncLoop`/`SyncClient`, …) or sync module from any source. Comments are stripped before parsing (T-16 — `client.ts`/`native.ts` name `SyncLoop`/`SyncClient` in prose).
- **Falsification (§2.11):** added `createSyncTriggers` to `media/triggers.ts`'s real import from `../bootstrap/triggers.js`; the guard went **red (EXIT=1)** naming it — `"triggers.ts imports sync-scheduling symbol 'createSyncTriggers' from '../bootstrap/triggers.js' (FR-1138)"` — and the real-file parser control also caught the injected name (proving it reads the actual file, not a hardcoded set); the synthetic positive/negative controls stayed green. Reverted; guard green again (5/5, EXIT=0).

### Gates (all EXIT=0): `tsc -b`; `pnpm typecheck`; `pnpm lint`; `pnpm knip` (baseline unchanged, +0/-0); `pnpm chaos` (136/136); test-support project (226/226 at the merged HEAD; the 217 measured at 434c373 predates main's test-support changes); mobile project (670/670).
