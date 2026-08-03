# TASK 153 — the SEC list has no id for client-side pre-display media verification (a normative 06 §6 property), and the legacy v1/v2 render arm is an unclosable evidence-substitution vector until re-homed

**Status:** todo

> **OWNER RULING 2026-08-03: SEC-MEDIA-07 APPROVED** (add the new SEC control). **DONE 2026-08-03 — SEC-MEDIA-07 + SEC-MEDIA-08 both landed; Part B closed by the version floor.**
>
> **The "mobile is not swept" blocker premise was WRONG — corrected here (T-11: verify ground truth; the guard's own description lied).** The original ruling read `scripts/sec-sweep.mjs`'s LANES[0] *name* string (`unit, core, schemas, server, db-server, harness, i18n, ui`) and concluded the `mobile` project was unswept. But LANES[0] runs bare `vitest run`, and the root `vitest.config.ts` `projects` glob is `['apps/*/vitest.config.ts', ...]` — so `vitest run` **includes** `apps/mobile` (vitest project name `mobile`) and `apps/server`. Verified (§2.1): `npx vitest run apps/mobile/src/media/remote-cache.test.ts --reporter=json` credits **7 passing SEC-MEDIA-07 assertions**; the sec-inventory reads them from the repo-suite lane report. **No infra change was needed** — the LANES[0] name string was merely stale (it omitted `mobile`); this task fixed the string to match reality (`…, ui, mobile`) rather than adding a lane.
> - SEC-MEDIA-07 (client pre-display hash, mobile lane) + SEC-MEDIA-08 (server mediaRef→signer binding, `scope.ts`, server lane) both added to `security-guide.md` (§7 test-index rows + §12 roll-up `MEDIA 01–06`→`01–08`). Guide parses 60 ids, roll-up consistent.
> - §2.11 falsified (both are behavior guards, not title-only): breaking the local-arm verify in `remote-cache.ts` reds SEC-MEDIA-07's two local-tamper legs (network/cache/positive-control stay green); neutering the binding in `scope.ts` reds SEC-MEDIA-08's REPRO/MISMATCH-USER/SIBLING (positive-control + no-media stay green); a phantom `MEDIA 01–09` reds the inventory `[ROLLUP_EXTRA_ID]`. Restored → green.
> - Part B (legacy v1/v2 arm) closed by the version floor → `roadmap.md` R28 + tripwire T10 (reopens if a pre-v3 ref producer ever appears).
> - **§2.11 miss caught in review (recorded, not hidden):** the first falsification pass ran the sec-*inventory* but NOT `packages/test-support/src/sec-meta.test.ts` — so the "restored → green" claim was made on a gate never exercised. The review's spec + security lenses (3 independent) found it: the SEC-MEDIA-08 describe ended `(task 140 Leg B)`, and `PARTIAL_LEG_QUALIFIER = /\b(?:legs?|arms?|precursor|partial)\b/i` matched **"Leg"** → SEC-META-01's §2.1.6 rule read the id's ONLY title as a *partial leg* with no allowlist row and no owner marker → `sec-meta.test.ts` RED (the swept repo-suite lane, hence `pnpm sec:sweep` red). The exact title-audit class this task exists to close, introduced by the task. Fixed by (a) rewording the describe to `(task 140 server binding)` — no trigger word, still carries `SEC-MEDIA-08`; (b) making the owner marker above well-formed (escape #3). Re-ran `sec-meta.test.ts` → 18/18 green; sec-inventory still credits both ids. **Lesson: a SEC title change must falsify against `sec-meta.test.ts`, not only the inventory.**

**Priority:** MEDIUM — neither is live-exploitable today (task 140 Leg A closed the v3 client arm; no v1/v2 ref producer exists while `NOTE_CREATED_SCHEMA_VERSION = 3`), but both are named holes on the media-evidence security surface, and one is a SEC-inventory gap the release gate cannot see.
**Depends on:** 140 (Leg A, merged 2026-07-22)
**Blocks:** —
**SEC ids owned by THIS task:** SEC-MEDIA-07, SEC-MEDIA-08
Both shipped 2026-08-03 (client pre-display hash + server mediaRef→signer binding) and added to `security-guide.md` §12's roll-up (the inventory gate counts declared ids). The marker line above is a bare id list on purpose — `parseOwnedIds` (sec-meta.ts) splits it on commas and rejects any trailing prose, so the description lives here, not on that line.
**Filed by:** the task-140 implementer and its independent reviewer, 2026-07-22 (both concurred).

## Part A — SEC-MEDIA-07: client pre-display verification is normative but unenumerated

`06 §6` states media is "verified against `mediaRef.sha256` **before display**" — normative. But the SEC inventory has no id for it: **SEC-MEDIA-01..06 are all server/wire-side** (immutability, the out-of-scope download probe → 404, path fuzzing, content validation at `complete`, cross-device chunk injection), and `security-guide.md` §7.1's single client bullet covers only the capture-side cache→document-dir move and the drain driver — **not render-side pre-display verification.**

So task 140 Leg A shipped the correct behaviour with **no SEC id owning it**, which means the `sec:sweep` inventory gate cannot tell whether it regresses. Add **SEC-MEDIA-07 (client pre-display hash verification)** to `security-guide.md` (definition + §12 roll-up), and point it at the `remote-cache.test.ts` adversarial + positive-control tests 140 already shipped. Falsify per §2.11: the sweep must go red if the id is declared but no passing test carries it (the SEC-META-01 title-audit class).

## Part B — the legacy (v1/v2) render arm renders another device's photo, unclosably, until re-homed

`loadLocalMediaOnly` (`apps/mobile/src/media/remote-cache.ts`) returns `{kind:'local'}` **unverified** for a v1/v2 attachment, because no signed hash exists for one — `ThumbnailRef.legacy` has no `sha256` field (type-enforced), and `applier.ts` keeps `mediaSha256` null and refuses the `media_items` back-fill. **The residual is real and identical in shape to the v3 defect 140 fixed:** a pulled v1/v2 note naming a `mediaId` this device holds renders THIS device's photo as the note's evidence.

**Correctly bounded, not live:** `NOTE_CREATED_SCHEMA_VERSION = 3`, so no producer of a legacy ref exists until a pre-v3 release has shipped. It is future exposure. But a code comment is the wrong place to park a future evidence-substitution vector (both the implementer and reviewer said so).

Closing it needs the note's **author device** to reach the render path so the local file can be bound to authorship — a migration + projection + port change: `ThumbnailRef.legacy` carries a bare `mediaId`; the `notes` projection has only `created_by` (a *user* id two devices share), not a device id. That is why it could not be folded into 140. Read `06-media-pipeline.md` and `05-operation-log.md` §9 before designing; a new projection column is a `10-db-schema` change.

## Deliverable
Part A: add SEC-MEDIA-07 and wire the sweep. Part B: either implement the authorship binding, or — if v0 will never ship a pre-v3 release, making a legacy ref unreachable forever — record that in `roadmap.md` with the version reasoning and downgrade Part B to "closed by the version floor", rather than leaving an undocumented vector.

## FALSIFY (§2.11 — REPORT it)
Part A: declare SEC-MEDIA-07 with no test → sweep red; add the 140 tests → green; break 140's local-arm check → the id's test reds (proving the id actually guards the behaviour, not just its own title).


---

## ADDENDUM 2026-07-22 — task 140 LEG B landed; it opened a matching SERVER-side spec/SEC gap (from the 140B review, MEDIUM)

Leg B (merged `b09290d` → main) added a real security control: the push scope step now rejects any op whose `mediaRef.deviceId`/`userId` are not the envelope signer's (`SCOPE_VIOLATION`). The 140B reviewer verified it is genuinely load-bearing AND that the residual is defended downstream (the media download route IS tenant+store-scoped with RLS + a non-vacuous 404 matrix — verified at `apps/server/src/routes/media.ts:495-507`, `test/integration/media/download.test.ts`).

But — same class as Part A — **the binding rule is not enumerated in `05 §9` and has no SEC id**, so `sec:inventory` cannot see it and a reader of the spec (not the code) won't know it exists. This §Part A already proposes SEC-MEDIA-07 for the CLIENT pre-display check; **extend this task to also home the SERVER binding rule**:
- Add the `mediaRef`→envelope-signer binding as a general `05 §9` scope sub-rule (it is currently only in `scope.ts`'s comment — excellent and citation-dense, but a rule no gate reads is the §2.11 drift risk).
- Give it a SEC-MEDIA id (SEC-MEDIA-08, or fold both client+server media-provenance checks under one id — decide when homing) and wire the sweep so it reds if a passing test stops carrying it.
- **v1 forward-compat marker (140B review LOW):** `06 §3.2` says v1 may attach previously-captured media from a *different session*; the `deviceId` binding is v0-correct ("capture+attach in one command") but would be too strict for a v1 attach-prior-media flow. When homing the rule in the spec, carry a `v0-scope, revisit-at-v1` marker so a future v1 task knows to relax it deliberately, not by accident.
