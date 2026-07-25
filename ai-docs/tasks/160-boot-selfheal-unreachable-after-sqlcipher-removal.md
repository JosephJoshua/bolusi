# TASK 160 — the boot self-heal can no longer fire for the case it exists for: a restored plaintext DB now opens successfully, so the app boots into a SILENT half-enrolled state

**Status:** todo
**Priority:** **HIGH** — a failure that used to be loud at boot and self-healed is now silent and strictly worse. Surfaced by the task-148 review (F2), confirmed by the implementer, deliberately NOT fixed in 148 because the hard part is semantics, not code.
**Depends on:** 148 (which created the condition by removing SQLCipher)
**Blocks:** **27a** — named blocker, see "Why this blocks 27a" below.
**SEC ids owned by THIS task:** none new — but it degrades the recovery leg `security-guide §6.6` describes, so reconcile that row.
**Filed by:** the task-148 reviewer (F2) + implementer concurrence, 2026-07-22.

## ⚠️ IMPLEMENTED, REVIEWED, MERGED — THEN REVERTED 2026-07-25. Re-land is coupled to an emulator re-run.
The fix was built and reviewed (rev-160 APPROVE — silent-path + heal reproduced through real `bootstrap()`,
all 6 falsifications re-run, the boot-ordering invariant proven) and merged (commits `78edee6` +
`af2210d`), then **reverted from `main`** in the same day's hotfix. The reviewed code is preserved on
branch **`task/160-boot-decrypt-probe`** — do not re-implement; re-land it.

**Why it was reverted (not a defect in the fix):** the boot key-tag probe MUST read the column-cipher
marker, which required exposing it on `packages/db-client/src/connection.ts` — an `AT_REST_SURFACE` file
watched by the **SEC-AUTH-09 provenance guard** (task 28). On merge the guard correctly RED'd the
`security-sweep` lane: *"Artifact STALE: connection.ts changed since the emulator artifact's commit
0e2096b"*. That is the guard **working as designed** — 160's at-rest-surface change means the committed
on-device SEC-AUTH-09 leg-1 evidence no longer covers the shipped code. (Task 172's new oracle is what
surfaced it: "the failure does not match the owed id.") Reverting restores `connection.ts` to pre-160, so
SEC-AUTH-09 stays legitimately discharged and the honest floor (only SEC-AUTH-10 owed) is restored.

**Also confirmed by this episode:** the fix originally shipped through an INCOMPLETE local gate (`tsc -b` +
targeted tests, not `pnpm verify:full`) — `tsc -b` skips test-file tsconfigs (missed a double-`Promise`
type error in `boot-decrypt-probe.test.ts`) and the targeted run missed the full `unit` lane. **Re-land
MUST pass `pnpm verify:full` before the ff.**

**Re-land checklist (do NOT skip, do NOT hack the guard):**
1. Restore branch `task/160-boot-decrypt-probe` (or cherry-pick `78edee6`+`af2210d`) onto current main.
2. Run a FRESH emulator run (27a android-emulator lane) over the code WITH 160's `connection.ts` change →
   a new `leg-1 = pass` artifact under `reports/device-gates/`.
3. Commit that artifact and **re-anchor** `device-gate-provenance.ts` to the new artifact's commit.
   Re-anchoring WITHOUT a real re-run is the §2.11 "move the yardstick" anti-pattern the guard exists to
   prevent — the whole point of task 28.
4. `pnpm verify:full` green (only SEC-AUTH-10 owed) before the ff.
The bug 160 fixes is unreachable today (no client DB has ever existed on any device; 160 blocks 27a, the
first hardware DB), so deferral is safe. Natural sequence: **re-land 160 + emulator re-run together, before
27a enrolls on hardware.** See also task 182 (stamp a build-sha in the artifact).

## The finding
`apps/mobile/src/bootstrap/recovery.ts` heals only on `missing_key` or a `driver_open_failed` classified `not_a_database`. **Post-148 the iOS restore-to-new-hardware path produces neither:**
- `ensureDatabaseEncryptionKey()` mints a fresh key → never `missing_key`.
- `open()` takes no key any more, so the restored **plaintext** SQLite file **opens fine** → never `not_a_database`.

Proof from 148's own suite: `at-rest-column-encryption.test.ts` `reopen(file, dir, WRONG_KEY)` **resolves**; the throw only arrives on the subsequent SELECT.

**Net effect:** the app boots "successfully" into a half-enrolled state — `readDeviceId` reads plaintext `meta_kv`, so it believes it is the old device — and then throws AEAD errors deep in the UI. Under SQLCipher this was a loud boot failure that self-healed. It is now a silent one.

## Deliverable
A boot-time **"can we decrypt a known cell?" probe** that classifies an undecryptable-but-openable DB as the same recoverable condition the SQLCipher path used to produce, and routes it to the existing self-heal.

**The hard part is semantics, not code — decide and TEST each:**
- an **empty** DB (fresh install: nothing to probe — must not wipe);
- a **partially-written** DB (interrupted first-run);
- a **transient I/O failure** during the probe — the existing rule is that a transient must **NEVER** reach the wipe, so the probe must distinguish "cannot decrypt" from "could not read right now";
- which cell is the canonical probe target (it must exist on every enrolled device and be one of the 11 encrypted columns).

## FALSIFY (§2.11 — REPORT it)
- Reproduce the silent path first: restore a plaintext DB alongside a freshly-minted key → the app boots, `readDeviceId` returns the old device, and the first encrypted read throws in the UI. Lead with that.
- After the fix: the same input is classified at boot and self-heals (or fails loudly), never a half-enrolled boot.
- **Positive controls (all three mandatory):** a fresh empty DB boots normally and is NOT wiped; a healthy enrolled DB boots normally; a simulated transient read error does NOT trigger the wipe.
- Reconcile `recovery.ts`'s header and `security-guide §6.6` (148 marked the SQLCipher paragraph as history; this task makes the replacement true).


---

## RAISED IN IMPORTANCE 2026-07-22 by task 148 round 3 (the keyed marker)

148's keyed marker makes the marker unforgeable by deriving it from the DB key. A necessary consequence: values sealed under a **different** key no longer match the marker, so a foreign-key DB's rows now surface as **opaque envelope text instead of throwing**. The security property is intact (no plaintext; `decrypt` still throws; `isCiphertext` false) — but it removes the last incidental place a restored foreign DB announced itself.

**So this task is now MORE load-bearing, not less:** a stored key-tag comparison at open is the ONLY remaining place a restored foreign DB gets caught. Before the keyed marker, a wrong-key read at least threw; now it can return sealed text that a caller may treat as data. Design the probe accordingly — it is no longer a nice-to-have boot check, it is the detection mechanism.

---

## REPRODUCTION (task-148 review, round 3) — traced AND executed, not reasoned

Wrote `users_directory` rows under key A, closed, reopened the same file under key B, and called the **real** `listSwitcherUsers`:

```
listSwitcherUsers → [{ id: 'user-1', name: 'gcm1:bk3aiowMaKSZ:SO95nBRnd7…' }]   (71 chars, NO throw)
```

Since D22's keyed marker, values sealed under a different key no longer match the reader's marker, so they are passed through as **opaque envelope text** rather than throwing. The render path swallows it silently:

- `SwitcherScreen.tsx:172` `{user.name}` — the sign-in screen renders the envelope string as a person's name; also `:165` `accessibilityLabel` and `:170` `initialsOf`.
- `NotesList.tsx:173`/`:213` and `NoteDetail.tsx:187`/`:196` — same for note titles/bodies.

**The only thing that throws is an accident, not a check:** `readVerifier` fails at `packages/core/src/projection/columns.ts:72` because `params` happens to be JSON and `JSON.parse` rejects the envelope; it is caught at `session.ts:246-250`. That is one column's data type, not a shape check — it does nothing for `salt`/`hash` alone, nothing for a user with no verifier row (§6.6 first-PIN), and nothing at all for notes.

So the honest statement of this task's severity: **not "opaque text in one place" but "the app renders ciphertext as user data across the switcher and every notes surface, with no error anywhere."**

## Why this blocks 27a (re-filed 2026-07-22)

This was first filed as a follow-up. It is re-filed as a **named blocker on task 27a**, on the reasoning the 148 reviewer proposed and the orchestrator accepted:

- It must NOT block `main`. Blocking on 160 deadlocks: 160 is far easier to build and falsify *with* 148 landed, and — decisively — **no client DB has ever existed on any device**, so the restore path is unreachable today. There is nothing to restore from.
- It MUST block **27a**. The emulator lane is the first moment a database exists on real hardware that can later be restored, and 27a is where **SEC-DEV-06 gets claimed**. Claiming "the sensitive columns are ciphertext at rest" on a device whose boot cannot tell a foreign database from its own would be claiming the control while its recovery leg is missing.

**The fix, for whoever takes it:** a boot-time probe that decides "is this database ours?" against a stored key tag (the cipher already derives one — `Aes256GcmColumnCipher.marker`), rather than waiting for a read to fail. The hard part is semantics, not code: what to do on an EMPTY database, on a partially-written one, and on a transient I/O failure — and `recovery.ts`'s existing rule that a transient must **never** reach the wipe still binds.

## BOOT EVIDENCE 2026-07-25 (emulator run 30147394950) — the app boots CLEAN post-148 on a cold start

The first real emulator run of the harness (task 175) booted the release app on an AVD post-SQLCipher
removal: `Boot completed`, the RN runtime came up, the JS harness ran, and the native emitter wrote a
valid result — with NO `FATAL EXCEPTION`, no AEAD boot error, no `not_a_database`, no emit-failure
marker. So the app-layer-AEAD boot path (148) initializes and runs on-device for a FRESH install.

This does NOT close task 160: 160 is about the RESTORE-foreign-DB path (a plaintext DB restored onto
new hardware opening successfully and booting half-enrolled), which a cold-install harness run does
not exercise. The decrypt-probe-at-boot this task specifies is still needed. But the baseline "does
the app boot at all post-148" worry is answered: yes, cleanly.
