# TASK 86 — D17 reversed the "Android-first" premise but never amended the line that states it, and every "unverified on-device" sentence still names one device

**Status:** todo
**Priority:** **MEDIUM — cheap, and it is the leverage point.** `00-product-overview:41` is the doc-router's **first** row ("Anything — orientation, scope"), so every future agent reads "Android-first" before it reads anything else, and will correctly re-derive the ruling D17 just overturned.
**Depends on:** 85 (if the owner rules v0 Android-only, the wording lands differently — but §2's device-gap half is unblocked and can go first)
**SEC ids owned by THIS task:** none.
**Filed by:** task 80 (iOS parity audit), 2026-07-16, under **D17**.

## 1. The premise D17 reversed is still written down as fact

D17's own header lists what it amends:

> **Amends:** D12/D13 (the no-device posture), `08-stack-and-repo.md §2.2`, `security-guide.md §6`, `api/04-push.md §5`

**`00-product-overview.md` is not in that list.** And `00-product-overview.md:41` says:

> **Client:** Expo React Native, **Android-first**. Shared TS core packages…

That is the literal statement of the premise D17 exists to reverse, in the one doc CLAUDE.md §3 routes **every** agent to for orientation, on **every** task. Task 58's ruling cited exactly this line (`58:81`: *"Android is not a side platform here… the product is 2 GB Android phones (`00-product-overview`)"*) — correctly, given what the doc said.

**So the failure mode is live and repeatable:** an agent reads §3's first row, learns the product is Android-first, meets an iOS-only option, and rules it inert — for the same good reasons, from the same good doc, reaching the same now-wrong conclusion. D17 is a decision doc; decision docs are read when you ask *why*, and nobody asks *why* about a premise they have already been handed as fact.

Related, same shape: `00-product-overview.md:23` states the v0 exit criterion as *"chaos harness + reference module on real **2GB Android**"* — which task 85's owner decision may or may not change, but which currently reads as the whole platform story.

## 2. Every "unverified on-device" sentence names one device, and the gap is not symmetric

D17 §3 rules: *"Every 'unverified on-device' residual-risk sentence must now name **which** devices."* The sentences, all currently Android-only:

| site | current wording |
| ---- | --------------- |
| `security-guide.md:194` (§6.2 checkbox) | *"…is unverified on-device (D12/D13)"* |
| `security-guide.md:222` (`SEC-DEV-08` row) | *"there is no physical Android on this project (D12/D13), and no green here may be read as device-verified"* |
| `tasks/58-*.md:45` | *"There is no physical Android on this project (D12/D13)"* |
| `tasks/59-*.md:91,104` | *"**No physical Android** (D12/D13)"* |
| `testing-guide.md:97` | *"The reference device is a designated physical 2GB-RAM / 32GB-storage **Android** unit… Emulators satisfy nothing in Part C."* |
| `decisions/2026-07-15-no-device-v0-exit.md` (D12/D13) | *"the owner confirmed no physical 2GB-class **Android** is available"* |
| `tasks/_index.md:37-38` (27a/27b) | neither lane names a platform at all |

**Do not simply append "or iPhone" to each.** The gap is **not symmetric**, and task 80 established why — reuse its wording rather than re-deriving it:

- **Android** has an emulator that runs the shipping APK's own Hermes 0.17 (D13), so a real subset of claims is honestly answerable *today* (task 27a: SQLCipher at-rest, the JCS vectors). D12's care is about *performance* numbers an emulator cannot produce.
- **iOS** has **no runnable target of any kind in this environment**: Linux x86_64 host, no Xcode, all 10 CI jobs `ubuntu-latest`, and a Simulator requires macOS. iOS is not "unverified on device" — it is **unverified on every target, including the one a reader would assume substitutes.**

**And a Simulator would not close it even given a Mac.** Task 80 checked this rather than repeating it, and the sourced part is narrow: the claim under test is *"the entry is excluded from an encrypted backup/restore"*, and a Simulator has no iCloud/Finder device-backup path to restore from; separately, Expo's SecureStore docs document a Keychain divergence — *"This library requires a real device for testing since emulators/simulators do not require biometric authentication when retrieving secrets, unlike real iOS devices."* **The common claim that a Simulator "shares the host filesystem" was NOT sourced by task 80 and must not be repeated until it is.**

## Scope

**In:** `00-product-overview:41` (and `:23` if task 85's decision touches the exit criterion); the residual-risk sentences above; task 27's lane descriptions in `_index.md` naming their platform.

**Out:** the build lane and its owner decision (task 85), the security controls (task 84), `app.config.ts` (task 83). **Do not restate task 80's table here** — cite it.

## Acceptance

- **`00-product-overview` states the platform posture D17 actually rules**, and names it as a premise that an owner set — so the next agent to meet an iOS-only option reads the current premise, not the one from before 2026-07-16. If task 85 rules v0 Android-only, say **that**, with its date and its decision id: *"iOS is a first-class target (D17); v0 ships Android-only (D**nn**)"* is honest and is not a contradiction. What it may not do is read `Android-first`, unqualified, forever.
- **D17's `Amends:` list gains `00-product-overview.md`** — the omission is the bug, and leaving it means the next premise change repeats this exactly.
- Every residual-risk sentence in the table names **which** target and does not imply the two gaps are the same size.
- Task 27's `27a`/`27b` rows name their platform; if the owner defers iOS (task 85), the iOS lane is **recorded as deferred, not omitted** — D12's own precedent (*"blocked, not deleted… deleting the gates makes the constraint invisible rather than unmet"*).
- **This is spec/doc work and it is its own task** (CLAUDE.md §4) — it must not ride along inside 83/84/85.
- `pnpm lint`, `pnpm typecheck`, `pnpm test` green — a doc task should move no numbers; if it does, say why (§2.1).

## Note

**This is the cheapest task filed by the iOS audit and probably the highest-leverage one**, and the reason is uncomfortable: task 58 did everything right and still landed a conclusion that is now wrong. It verified against live SDK docs, ruled correctly *given the premise*, and left `// iOS only:` marks so no future reader would delete a line that looked dead. Every step was diligent. The premise moved underneath it.

The marks are the tell. They were written to protect a line believed **inert**; D17 makes that same line the sole mechanism delivering `§7.4` on a first-class platform. **A comment written to say "don't delete this, it's harmless" now sits on load-bearing, effect-untested code** — the annotation inverted without a character of it changing.

The lesson is not "task 58 should have known". It is that **a ruling contingent on a product premise must name the premise**, so it fails loudly when the premise moves instead of sitting quietly wrong — and that the premise must be *written where the ruling's readers actually look*, which for this repo is `00-product-overview`, not a decision doc they have no reason to open.
