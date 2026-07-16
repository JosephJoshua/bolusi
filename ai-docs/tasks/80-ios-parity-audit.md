# TASK 80 — iOS is a declared platform that nothing verifies: audit every platform-conditional claim and state which leg is covered

**Status:** in-progress
**Priority:** **HIGH — owner directive (D17)**. Not a build task; an **audit**. It exists because merged, reviewed, green code makes platform claims that were reasoned Android-first, and iOS is now first-class.
**Depends on:** —
**Blocks:** the frontend phase (deferred), task 27's device lanes
**SEC ids owned by THIS task:** none — but it will likely find that `SEC-DEV-08`'s scope needs an explicit iOS statement.

## The directive (D17)

Read **`ai-docs/decisions/2026-07-16-ios-is-a-first-class-target.md`** first — it is an owner directive and the whole premise:

> *"we should also explicitly support iOS properly and beautifully… frontend is later though."*

## The finding this task starts from

**`apps/mobile/app.config.ts` has declared `platforms: ['android', 'ios']` the entire time**, while every test, guard, and residual-risk statement in the repo covers **Android alone**. Nothing lied; nothing verified. **That is this repo's signature failure — a claim nothing checks — operating on the platform list itself.**

Concretely, shipped and merged:

| site | the Android leg | the iOS leg |
| ---- | --------------- | ----------- |
| `keystore.ts` `keychainAccessible: WHEN_UNLOCKED_THIS_DEVICE_ONLY` | ruled **inert** by task 58 (iOS-only option, Android-first product), kept + marked `// iOS only:` | **now load-bearing.** It is the mechanism delivering `api/02-auth §7.4` ("a device identity is never resurrected") on iOS. **Zero tests.** |
| `apps/mobile/test/android-backup.test.ts` (**SEC-DEV-08**) | asserts the **generated `AndroidManifest.xml`**, `allowBackup:false`, `<cloud-backup>`/`<device-transfer>` exclusions, resolved `@xml/…` on disk | **no counterpart.** iOS uses `NSFileProtection`, the Keychain accessibility class, and `isExcludedFromBackupKey`. **Nothing asserts any of it**, so a SEC id reads as a platform-neutral guarantee it does not deliver (§2.11). |
| `bootstrap/notifications.ts` + task 59 | the whole muting analysis is **Android channel importance**; the v0 recommendation (drop the in-app toggle, relocate to Android settings) is Android-shaped | **iOS has no channels.** The recommendation may be right for Android and wrong for iOS. |
| task 18's media adapters | `Paths.availableDiskSpace`, `expo-camera`, `expo-file-system`, `FileHandle` chunk reads — residual risk names **Android** only | iOS behaviours differ; the residual-risk sentence is now **incomplete**, not wrong. |
| D12/D13 | "no physical Android" | presumably **no physical iPhone either** — the gap doubled and nobody wrote it down. |

## Scope

**In:** an audit + the filed gaps. Find every platform-conditional claim (code, comment, test, spec, SEC row, residual-risk sentence) and produce a table: **claim → Android leg → iOS leg → verified?**

**Out:** building the iOS legs (each becomes its own task), any frontend/UI work (deferred), buying devices.

## Docs to read

- **D17** (above) — the directive and the five things it rules. **The `impeccable` skill is now installed** (`github.com/pbakaus/impeccable`, v3.9.1) alongside `frontend-design`; both are **mandatory for the frontend phase**, which this task does not do.
- `ai-docs/decisions/2026-07-15-no-device-v0-exit.md` (**D12/D13**) — the no-device posture this amends.
- `ai-docs/tasks/58-*.md` §Outcome — **read it closely.** It is the model for this work: it verified a platform claim against **live SDK docs**, found the option iOS-only, and ruled it inert *because the product was Android-first*. **D17 changes that premise.** Its reasoning is preserved, which is why the ruling can be re-evaluated rather than re-derived.
- `ai-docs/tasks/59-*.md` — the muting analysis, Android-reasoned, **already batched as an owner decision**; D17 adds a dimension to that decision.
- `ai-docs/security-guide.md` §6 — reads platform-neutral, is Android-only.
- `ai-docs/08-stack-and-repo.md` §2.2 (the Expo/RN stack + its platform notes).
- `ai-docs/testing-guide.md` **T-14f** (*"typed and compiling" is not "running on the target"* — now **targets**, plural), **T-15** (the well-typed no-op; `keychainAccessible` was its founding instance), T-16, T-12.

## Acceptance

**Observable done-condition:** a written table of every platform-conditional claim with its per-platform verification status, and a filed task for each uncovered leg. **No claim in the repo reads as platform-neutral while being verified on one platform.**

- **Trace to producers, do not grep for platform names** (T-16 — this repo's most-repeated failure, five instances by the orchestrator alone). A claim's platform-dependence usually is **not** spelled out: `keychainAccessible` looks platform-neutral in TypeScript and is iOS-only in Expo's docs; `getFreeDiskStorageAsync` **throws at runtime** on SDK 54+ while typechecking fine. **Check each API's platform column in current SDK docs via Context7**, not recall, not the symbol's existence.
- **Start with the security surfaces** (§2.5): `keystore.ts`, the backup exclusion (`SEC-DEV-08`), the `§7.4` never-resurrected guarantee. A security control verified on one of two shipped platforms is the highest-consequence instance of the class.
- **`SEC-DEV-08`'s scope is the first decision.** Either extend it with an iOS leg, or **state in the SEC row that iOS is uncovered**. What it may not do is keep reading as a platform-neutral guarantee (task 58 was careful to scope it to the build artifact for exactly this reason — extend that care, don't undo it).
- **The `// iOS only:` marks task 58 left are your map.** They were written to stop a future reader deleting a line that looked dead. They now mark **load-bearing, untested** code. That is the inversion worth reporting.
- **State the device gap precisely** (D12/D13's honesty clause, doubled): every "unverified on-device" sentence must name **which** device. "No physical Android" and "no physical iPhone" are different unverified claims, and a simulator is not a device (an iOS Simulator shares the host's filesystem and Keychain semantics differ — **verify that claim before repeating it**).
- **Do not build the legs here.** File each as its own task with next-free at the moment of filing (six collisions this session; task 66's gate now catches them; `pnpm task:status` is the only sanctioned way to set a Status — CLAUDE.md §5).
- `pnpm lint`, `pnpm typecheck`, `pnpm test` green — an audit should move none of them; if it does, say why (§2.1: read the output, not the exit code).

## Note

The instructive part is **why this was invisible**, and it is not carelessness. Task 58 did excellent work: it verified `keychainAccessible` against live docs, found it iOS-only, and correctly ruled it inert **on an Android-first product** — then kept the line and marked it, precisely so a future reader wouldn't delete something load-bearing on a platform they weren't thinking about. Every step was right. **The conclusion was contingent on a premise the owner has now changed.**

That is the argument for how this repo records decisions: task 58 wrote down *why*, not just *what*, so D17 could re-evaluate it in minutes instead of rediscovering the mechanism. A conclusion without its premise is unmaintainable — you cannot tell what would change it. Worth carrying: **when a ruling depends on a product premise (platform, scale, user), name the premise in the ruling.** The premise is an owner's to change, and the ruling should fail loudly when it does — not sit quietly being wrong.
