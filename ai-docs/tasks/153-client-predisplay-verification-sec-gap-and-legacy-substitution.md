# TASK 153 — the SEC list has no id for client-side pre-display media verification (a normative 06 §6 property), and the legacy v1/v2 render arm is an unclosable evidence-substitution vector until re-homed

**Status:** todo
**Priority:** MEDIUM — neither is live-exploitable today (task 140 Leg A closed the v3 client arm; no v1/v2 ref producer exists while `NOTE_CREATED_SCHEMA_VERSION = 3`), but both are named holes on the media-evidence security surface, and one is a SEC-inventory gap the release gate cannot see.
**Depends on:** 140 (Leg A, merged 2026-07-22)
**Blocks:** —
**SEC ids owned by THIS task:** proposes **SEC-MEDIA-07** — do not retire it against a test until the id is added to `security-guide.md` §12's roll-up (the inventory gate counts declared ids).
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
