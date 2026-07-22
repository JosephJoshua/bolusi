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

## 3. Task 141b — `05 §9.2` lets any device write into any store of its tenant. RULING: **add a device→store scope rule (restrict a device to its own store's ops).**

The owner ruled that a mechanic's device should NOT be able to write ops into another branch's store. This is a **permission-matrix change (a new scope rule)** — a CLAUDE.md §6 surface — so it is filed as its own task (**157**) with adversarial tests (a device pushing an op scoped to a store that is not its own is rejected per-op as `SCOPE_VIOLATION`; the honest same-store sibling still commits, §4.1; a system/multi-store device, if that concept exists, is handled per spec). `05 §9.2` and `security-guide` are updated in the same change. Any legitimate multi-store flow the spec assumed must be re-examined against this rule before it lands.

## What each ruling does NOT do
- 148's ruling does not bless a specific encryption mechanism — that is the design task's output, owner-reviewed before code.
- 141a documents existing behaviour; it does not change the wire.
- 141b is approved in principle; the exact scope-rule shape (and any system-device carve-out) is the task's design, adversarially tested, and must not silently break a spec'd multi-branch flow.
