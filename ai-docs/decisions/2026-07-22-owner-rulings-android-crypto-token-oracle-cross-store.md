# D22 — Owner rulings (2026-07-22): the Android crypto stack, the push-token oracle, and cross-store writes

**Date:** 2026-07-22 · **Status:** Accepted — owner decisions (three questions answered directly).
**Unblocks:** task 148 (+ the whole native chain 27a/27b/28/117 and D21's credibility), task 141 (both legs).

Three questions were put to the owner with their tradeoffs; the rulings:

## 1. Task 148 — the Android app cannot build (duplicate `libcrypto.so`). RULING: **drop SQLCipher, re-home at-rest DB encryption off the second-OpenSSL path.**

op-sqlite (SQLCipher, whole-DB at-rest encryption) and react-native-quick-crypto (argon2id + Ed25519) each vendor their own OpenSSL, so `:app:mergeReleaseNativeLibs` refuses two `lib/arm64-v8a/libcrypto.so`. The two `pickFirst` branches are asymmetric and one runs the DB encryption silently on an OpenSSL it was never built against (see task 148's investigation); upstream calls `pickFirst` "not a real fix."

**The owner chose the correct-by-construction option: remove `sqlcipher: true` from op-sqlite and protect the local DB at rest by a mechanism that does NOT drag in a second OpenSSL.**

**This is an architecture change to a security control, so it does NOT authorize a blind implementation.** The next step is a DESIGN task: produce the concrete re-homing mechanism + its threat-model implications (what encrypts the SQLite file at rest now; where the key lives; how it compares to SQLCipher's guarantees; what `10-db-schema`/`security-guide`/`api/02-auth` must change) and bring that mechanism back before writing code. Only after the mechanism is agreed does implementation proceed — with adversarial at-rest tests (a wrong key must fail; on-disk bytes must not be readable as plaintext SQLite) and the SEC-AUTH-09 leg it feeds. Recorded as the plan for task 148; 27a/27b/28/117 stay blocked until the APK builds AND the new at-rest control is proven.

## 2. Task 141a — the `POST /v1/push/tokens` cross-tenant existence oracle. RULING: **document it as a second, allowed `security-guide §2.2` exception (the entropy argument).**

A cross-tenant token collision returns 403 vs 200 for a fresh token — distinguishable. §2.2 currently declares the media-id probe "the only v0 exception." The owner ruled to **document a second exception** rather than make the responses indistinguishable, on the same reasoning the media exception uses: an Expo push token carries ~88 bits of CSPRNG entropy, so this confirms a token the caller **already holds**, never enumerates one; the confusion set is not usefully reducible. The 403 behaviour (task 118's fail-closed transfer) stays; `security-guide §2.2` is amended to enumerate BOTH exceptions with the entropy rationale, and the "only v0 exception" wording is corrected. Any gate/test that treats the push-token 403 as a §2.2 violation is reconciled to the documented decision (not weakened — reconciled).

> *2026-07-23 (task 141a review): the "~88 bits" premise above was traced to a test fixture (`apps/server/test/helpers/push.ts`, 22 hex characters) and does not hold — Expo publishes no length, alphabet, entropy or secrecy property for what `getExpoPushTokenAsync` returns. `security-guide §2.2` exception 2 was re-based on the 30/day per-device probe budget, which is enforced in code this repo owns (`apps/server/src/routes/push.ts:43-50`, charged before the collision path at `:100`). **The ruling stands; its stated rationale does not.** The ruling text above is left as ruled — this line is the forward reference, not a correction of the record.*

## 3. Task 141b — `05 §9.2` lets any device write into any store of its tenant. RULING: **add a device→store scope rule (restrict a device to its own store's ops).**

The owner ruled that a mechanic's device should NOT be able to write ops into another branch's store. This is a **permission-matrix change (a new scope rule)** — a CLAUDE.md §6 surface — so it is filed as its own task (**157**) with adversarial tests (a device pushing an op scoped to a store that is not its own is rejected per-op as `SCOPE_VIOLATION`; the honest same-store sibling still commits, §4.1; a system/multi-store device, if that concept exists, is handled per spec). `05 §9.2` and `security-guide` are updated in the same change. Any legitimate multi-store flow the spec assumed must be re-examined against this rule before it lands.

## What each ruling does NOT do
- 148's ruling does not bless a specific encryption mechanism — that is the design task's output, owner-reviewed before code.
- 141a documents existing behaviour; it does not change the wire.
- 141b is approved in principle; the exact scope-rule shape (and any system-device carve-out) is the task's design, adversarially tested, and must not silently break a spec'd multi-branch flow.

---

## D22 addendum — 148 mechanism accepted (2026-07-22): application-layer AEAD, reshaped guarantee

After the design pass established that NO whole-file encryption survives without the second-OpenSSL collision, the owner accepted the recommended mechanism: **application-layer AEAD (AES-256-GCM via quick-crypto's already-linked OpenSSL) on the sensitive columns**, with the reshaped at-rest guarantee — **sensitive VALUES encrypted (note bodies, GPS, op payloads, PIN verifiers); relational STRUCTURE plaintext (ids, op types, timestamps, hashes, row counts)**. The key stays 32 CSPRNG bytes in expo-secure-store (Keystore-wrapped), unchanged.

**Accepted residual:** metadata/activity-shape exposure to forensic extraction of a non-running, non-rooted device; "attacker running as the app decrypts everything" is unchanged from SQLCipher today (revocation is the answer). Perf on the P-2 budget is verifiable only on the emulator/device.

**GATE before implementation:** the owner still signs off the exhaustive encrypted-column set (a missed column is a silent PII leak). The orchestrator produces that list from a full walk of the client DDL (`10-db-schema §9`), classifying EVERY column encrypt/plaintext with the reason, and verifying no encrypted column is ever content-filtered by SQL (WHERE/index/ORDER BY) — an encrypted column that a query filters on would break. Only after column sign-off does code begin, with adversarial at-rest tests (raw file → ciphertext for protected columns; wrong key fails; VACUUM leaves no stale plaintext) and the SEC-AUTH-09 leg.

**Task 151 re-scoped** (not closed): app-layer AEAD is platform-agnostic JS, so "iOS SQLCipher-off" ceases to be a bug and the "iOS collision on config-fix" risk is pre-empted; 151's root cause (podspec misses the pnpm-root config block) still governs `performanceMode` discovery on iOS, which is 151's remaining scope.

---

## D22 addendum 2 — 148 encrypted-column set SIGNED OFF (2026-07-22)

The orchestrator walked the authoritative client schema (`packages/db-client/src/generated/db.ts`). The owner signed off the following. **This is the complete encrypt set — implementation encrypts exactly these and no others; adding/removing a column later is a new decision.**

**ENCRYPT (app-layer AES-256-GCM via quick-crypto; key = the existing 32-byte SecureStore DB key):**
1. `operations.payload`
2. `operations.signed_core_jcs`
3. `operations.location`
4. `notes.title`
5. `notes.body`
6. `user_pin_verifiers.salt`
7. `user_pin_verifiers.hash`
8. `user_pin_verifiers.params`
9. `media_items.location`
10. `quarantined_ops.signed_core_jcs`
11. `users_directory.name` — **owner ruled ENCRYPT** (employee PII). REQUIRES moving any user-name ORDER BY out of SQL into app-layer (a handful of users; trivial). An encrypted column can never be SQL-filtered/ordered/joined by content — verify no query touches `name`'s content before encrypting it.

**PLAINTEXT (must stay — queried by content, or not sensitive):** all ids/FKs, `entity_type`/`type`/`schema_version`, `seq`/`arrival_seq`/`timestamp_ms`, `hash`/`previous_hash`/`signature` (signature is not secret), `sync_status`/`synced_at`, all enums (`kind`/`status`/`severity`/`end_reason`/…), counters (`edit_count`/`failure_count`/`suppressed_repeats`), `media_sha256` (a hash), `signing_key_public` (PUBLIC key), `meta_kv.value` (device ids/scalars; secrets live in SecureStore, not here), locale, denial `reason`/`target`/`surface` (audit metadata, not core PII), conflict keys.

**Rule the implementer MUST honor:** before encrypting ANY column, confirm no SQL WHERE/JOIN/ORDER BY/index touches its content. `users_directory.name` is the one known case needing an app-layer sort move; if any other listed column turns out to be content-queried, STOP and report — encrypting it would break the query.

**Media FILES on disk (the captured photos `media_items.local_path` points to) — SEPARATE TASK (158), does NOT block 148.** Owner ruled: land 148's column encryption now; file the media-file-at-rest encryption as its own task so photos-on-disk is tracked, not forgotten. Record the photos-on-disk residual in the threat model as accepted-until-158.

**148 may now proceed to implementation** with this exact set + adversarial at-rest tests (raw file → ciphertext for these columns; wrong key fails decrypt, never silent plaintext; migration VACUUMs so no stale plaintext survives in freed pages; encrypt→decrypt round-trip lossless). The APK-assembles + on-device-ciphertext legs remain emulator-only (no Android SDK on this host).
