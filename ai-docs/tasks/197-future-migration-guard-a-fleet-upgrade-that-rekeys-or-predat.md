# TASK 197 — future-migration guard: a fleet upgrade that rekeys or predates the key-tag can produce a legit 'enrolled-but-unbound' DB the task-160 boot probe wipes — add a decrypt-VERIFIED tag backfill (never the naive adopt, which reopens SEC-DEV-06)

**Depends on:** 160, 27a
**Blocks:** —
**SEC ids owned by THIS task:** none new — but it hardens the recovery leg `security-guide §6.6` / task 160 describe; reconcile that row if the backfill lands.
**Priority:** LOW / deferred — **unreachable on the current deployment surface** (see "Why deferred"). Do NOT do this now; it is filed so the caveat is not a lost review comment (CLAUDE.md §2.7).
**Filed by:** the task-160 re-land review-wave, 2026-09-02 — correctness lens confirmed (HIGH, verify:correctness `real`); security + duplication lenses refuted it as non-blocking for the current surface. This task records the confirmed-but-deferred residual.

## The finding (confirmed against ground truth)

`apps/mobile/src/bootstrap/db-identity.ts:100` — the defence-in-depth branch:

```
storedMarker === null && deviceId !== null  →  throw ForeignDatabaseError
```

routes through `recovery.ts` (`isUnrecoverableLocalDbError(ForeignDatabaseError) === true`) into `wipeLocalData`, which crypto-erases the DB key and deletes `bolusi.db`, dropping to enrollment and permanently losing any un-pushed local ops.

That "enrolled deviceId + no cipher key-tag" state is produced by **any first boot on the task-160 build of a DB that was enrolled by a build predating the probe** (the tag is written by NOTHING but the probe itself — `db-identity.ts:109`; no migration backfills it; enrollment writes only `deviceId`). So a device carrying a pre-160 enrolled DB, upgraded in place to the 160 build, would have its healthy, correctly-keyed same-device DB wiped on first boot. The probe's own test `boot-decrypt-probe.test.ts` "PARTIAL/interrupted first-run (no tag but deviceId set) -> FOREIGN" encodes exactly this as intended behaviour.

## Why this is DEFERRED, not fixed now (verified at the source, 2026-09-02)

The precondition — a pre-160 enrolled DB on **real hardware** — cannot exist on the current surface:

1. **No client DB has ever existed on any device.** `ai-docs/tasks/160-…md` lines 37, 97: *"no client DB has ever existed on any device … there is nothing to restore from."* The on-device enrollment leg (a real POST + at-rest ciphertext persisted on device) is **owed to task 27a** — `bootstrap.ts:30` says so explicitly — and 27a is `in-progress`, 27b `blocked`. Enrollment is wired in code (task 92) and proven in CI/tests, never persisted on hardware.
2. **Task 160 lands before 27a by explicit sequencing.** 160 *"Blocks: 27a, the first hardware DB"*; the re-land is sequenced *"before 27a enrolls on hardware."* So the first-ever hardware enrolled DB is created **under 160 code**, whose boot binds the tag (`db-identity.ts:109`) on the fresh-DB path **before** enrollment persists a `deviceId` (`bootstrap.ts` orders `readDeviceId` at :189 → `assertDatabaseKeyBinding` at :200; a never-enrolled device reads `deviceId=null` → binds). So "enrolled + no tag" genuinely cannot arise on any same-device task-160-native path.
3. The only way to manufacture it today is a **developer's local branch-switch over the same `bolusi.db`** — a dev artifact, not a shipped device — which self-heals (re-enroll + re-pull; only unsynced dev ops lost, of which there are none in the field).

**The naive "fix" is a SECURITY REGRESSION — do not ship it.** A genuine restored foreign DB is *also* "enrolled + no tag." Binding the current key's tag over an untagged enrolled DB (the obvious backfill) would adopt a foreign DB and boot as its device — re-creating the exact silent half-enrolled brick (SEC-DEV-06) that task 160 exists to close (`db-identity.ts:96-104`; tested at `boot-decrypt-probe.test.ts` "adopting a foreign DB … FOREIGN"). The line-100 branch is **load-bearing**, not an oversight.

## When this becomes reachable (the trigger to actually do this task)

Both must hold:
- a real fleet exists (post-27a on-device enrollment has shipped), AND
- a future upgrade legitimately produces "enrolled + no tag" — e.g. a **key-derivation / rekey migration**, or introducing the key-tag onto devices that enrolled before the tag existed.

Until then this is a forward-looking caveat, correct-by-design.

## Deliverable (when triggered)

A one-time, migration-gated tag **backfill that binds the tag ONLY when the DB is provably ours** — i.e. the key this boot holds **correctly decrypts a known sealed cell** (one of the 11 §9.7 AEAD columns, verified via the production `readVerifier` path, never a home-rolled decrypt). Distinguish:
- key **decrypts** a known cell → same-device, tag legitimately absent → **bind the tag**, boot on.
- key does **not** decrypt → genuinely foreign → stay `ForeignDatabaseError` → wipe-and-re-enrol (unchanged).

This must be a deliberate migration step keyed to the specific upgrade that creates the untagged-enrolled state, NOT a blanket relaxation of the line-100 branch (which stays fail-closed for every other path).

## Acceptance / FALSIFY (§2.11)

- **Positive (must NOT wipe):** a same-device DB whose key decrypts a known sealed cell but has no tag → the backfill binds the tag and boots; assert the DB survives and the row count is intact.
- **Negative controls (must STILL wipe):** a genuine foreign DB (sealed under a different key, `deviceId` set, no tag) → key fails to decrypt the probe cell → `ForeignDatabaseError` → wipe. Prove SEC-DEV-06 is not reopened: the foreign DB is never adopted.
- **Transient (must NOT wipe):** an I/O error while reading the probe cell propagates raw (not `ForeignDatabaseError`), so `isUnrecoverableLocalDbError` is false and it surfaces un-wiped.
- Break the "decrypts?" gate to always-true and watch the foreign-DB negative control go from wipe → adopt (red) — the SEC-DEV-06 regression the gate prevents; restore → green.
