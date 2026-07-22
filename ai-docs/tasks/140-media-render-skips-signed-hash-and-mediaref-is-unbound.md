# TASK 140 — the render path skips the SIGNED hash check whenever a local file exists (including for REMOTE notes), and the server accepts a `mediaRef` bound to nothing — together, one device's photo renders as another's evidence

**Status:** in-progress
**Priority:** **HIGH — security.** 06 §6 requires verification "against `mediaRef.sha256` **before display**", with no local-file exception. Two independently-sound-looking decisions compose into evidence substitution on a product whose whole point is a signed repair record.
**Depends on:** 120 (the v3 `mediaRef`), 82
**Blocks:** —
**SEC ids owned by THIS task:** none currently named — **check `security-guide.md` for a SEC-MEDIA id covering pre-display verification and claim it if one exists**; if none does, this is a gap in the SEC list itself, so say so.
**Filed by:** QA adversarial sweep, 2026-07-22 (both sites verified by the orchestrator).

## Leg A — client: the local arm never hashes

`apps/mobile/src/media/remote-cache.ts:89-92` (`loadMediaForRender`) returns `{kind:'local'}` on `exists(localPath)` with **no hash check**; `:137` (`loadLocalMediaOnly`) likewise. `useThumbnail`/`toThumbnailState` map `local` → `{kind:'ready'}` and render it.

```
local bytes sha:  1dcbda34e70cf8128842078cba9b079d62175b833bdc929b5b9f71ed8e69bd91
signed  ref  sha: 3c693e168817f67f4ec3761d9301114c5b91db041f69d54e389b53dc74ad8337
outcome: {"kind":"local","uri":"/documents/media/m-1.jpg"}   downloads attempted: 0
CONTROL (cache arm, identical mismatch): {"kind":"unavailable"} + evicted ["m-2"]
```

The function's own comment justifies the skip with *"It is our own capture"* — true for self-authored ops, **false for the pulled ops this function exists to serve**. The file header calls the hash "the whole security property of this path". The correct cache arm sits **eight lines below** the broken one.

## Leg B — server: a `mediaRef` is bound to nothing

HTTP-D (real PG16 16.14, stamped lane): the server accepts a v3 `mediaRef` with an **arbitrary `mediaId`**, an **arbitrary `sha256`**, and `userId`/`deviceId` that are **not the envelope's** → `200 accepted`, folded to `notes.media_id/media_sha256/media_mime`. Nothing binds a ref to real media, to the tenant, or to the signer. FR-816's "embedded metadata" is signed but never validated.

**Composed impact:** device A signs a note whose ref points at a `mediaId` device B holds locally. On B, A's note renders **B's photo** as A's repair evidence, with zero verification and no download.

## Deliverable
- **Leg A:** hash the local file against `ref.sha256` in the local arm exactly as the cache arm does; on mismatch, fall through to the verifying fetch. If the re-hash cost on a 2 GB device is the objection, key the skip on *"this op was authored by this device"* — **never** on *"a local file exists"*. Whatever you choose, the comment must state the real rule.
- **Leg B:** bind `mediaRef.userId/deviceId` to the envelope at push (an 05 §9-style scope rule) and reject a mismatch per-op. Whether the server can also verify `mediaId` ownership/existence at push depends on media-init state — read `api/03-media.md` and `06-media-pipeline.md` and say what is checkable; if a full existence check is not, state the residual risk rather than implying it is closed.

## FALSIFY (§2.11 — REPORT it; Leg B on real PG16, attributed)
- Leg A: a pulled ref whose local bytes mismatch the signed hash must NOT render — reproduce the trace above, fix, re-run. **Positive control:** a matching local file still renders with **zero** downloads (so the fix cannot be "always fetch"). Break the new check → red; restore → green.
- Leg B: an op whose `mediaRef.deviceId` is not the envelope's is rejected per-op; the honest sibling op in the same batch is still accepted (security-guide §4.1). Positive control: a correctly-bound ref is accepted.

## Constraints
Contended: `remote-cache.ts` (media) and the push validation path (127/139) — serialize with those. Do not weaken the cache arm to match the local arm; the cache arm is the correct one. A new *rejection code* is a §6 red flag — if one is needed, propose it and stop.


---

## LEG A DONE 2026-07-22 (merged, reviewed APPROVE). LEG B still open. Residuals → task 153.

**Leg A** — `loadMediaForRender`'s local arm now hashes the file against `ref.sha256` exactly as the cache arm does; a mismatch falls through to the verifying fetch **without** deleting/evicting the local file (§7 never auto-prunes un-uploaded evidence). The design choice was hash, **not** authorship, and the reviewer confirmed authorship is *unavailable* not merely worse: `mediaRef.deviceId` is a payload field the server never binds to the envelope signer (that is Leg B), so keying the skip on it would hand the attacker the field that disables the check. Fail-closed confirmed: a `hashFile` throw rejects the resolver and `useThumbnail` maps a rejection to `unavailable`, never `ready`. Positive control (a matching local file still renders with **zero** downloads) proven load-bearing by two independent breaks.

**Leg B is UNTOUCHED — the composed attack is HALF-closed.** No server file changed. The server still accepts a `mediaRef` with an arbitrary `mediaId`/`sha256` and a `userId`/`deviceId` that are not the envelope's, and folds it. Device B no longer renders its own photo as A's evidence, but nothing yet binds a ref to real media, to the tenant, or to the signer. **Leg B must still be implemented** — sequence it after task 139 (both touch the push validation path) and read `05 §9` for the scope rule.

**Residuals → task 153:** the SEC list has no id for the client pre-display verification 140 just shipped (propose SEC-MEDIA-07), and the legacy v1/v2 arm remains an evidence-substitution vector (bounded by `NOTE_CREATED_SCHEMA_VERSION = 3`, so no producer exists yet).
