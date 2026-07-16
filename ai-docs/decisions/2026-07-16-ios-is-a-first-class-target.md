# D17 — iOS is a first-class target, and the frontend bar is "beautiful", not "functional"

**Date:** 2026-07-16
**Status:** Accepted — **owner directive**
**Amends:** D12/D13 (the no-device posture), `08-stack-and-repo.md` §2.2, `security-guide.md` §6, `api/04-push.md` §5
**Frontend work is deferred** ("frontend is later though") — but this decision is recorded NOW because it changes what "done" means for tasks **already merged**.

## The directive

> "note that we should also explicitly support iOS properly and beautifully. also again remember, our frontend should be absolutely beautiful, using modern components and having modern UX (load the frontend design and impeccable skills for these). frontend is later though."

## Why this cannot wait for the frontend phase

The repo has been built **Android-first**, and that assumption is load-bearing in shipped code. Several merged tasks made platform-specific rulings whose **premises change under D17**:

| shipped | what it assumed | what D17 changes |
| ------- | --------------- | ---------------- |
| **task 58** (`SEC-DEV-08`) | `keychainAccessible: WHEN_UNLOCKED_THIS_DEVICE_ONLY` was ruled **inert** — an iOS-only option on an Android-first product. Kept and marked `// iOS only:` | It is now **load-bearing on a first-class platform.** The `THIS_DEVICE_ONLY` guarantee (§7.4, "a device identity is never resurrected") must actually be **verified on iOS**, not merely retained. |
| **task 58** (the guard) | `android-backup.test.ts` asserts the **generated `AndroidManifest.xml`** + `allowBackup:false` + data-extraction rules | **iOS has no equivalent leg.** iOS backup exclusion is `NSFileProtection` + the Keychain's `ThisDeviceOnly` accessibility class + `isExcludedFromBackupKey` for files. **Nothing asserts any of it.** The Android guard now implies a symmetric guarantee it does not deliver (§2.11: a gate implying absent coverage). |
| **task 59** (push muting) | The muting model's whole analysis is **Android channel importance**; the recommendation (drop the in-app toggle, relocate to Android's settings) is an **Android-shaped answer** | iOS has **no channels** — it has per-app notification settings and no per-category OS surface. The v0 recommendation may be right for Android and wrong for iOS. **Reopen before implementing.** |
| **task 18 / D12-D13** | "no physical Android" ⇒ capture/compression/`FileHandle`/disk-space **unverified on device** | Now **two** unverified platforms. `Paths.availableDiskSpace`, `expo-camera`, `expo-file-system` behaviours diverge across them, and the residual-risk statements name only Android. |
| **`app.config.ts`** | already declares `platforms: ['android', 'ios']` | The **declaration was always there**; the *verification* never was. The config has been claiming iOS support the tests never checked — the repo's signature failure, at the platform level. |

## What this decision rules

1. **iOS is a first-class target.** Not a nice-to-have, not a v1 item. Every platform-conditional claim gets **both** legs verified or **both** gaps stated (T-14f: *"typed and compiling" is not "running on the target"* — now plural targets).
2. **No platform-specific control ships with only one leg guarded.** Task 58's Android backup guard needs its iOS counterpart, or `SEC-DEV-08`'s scope must say **in the SEC row** that iOS is uncovered.
3. **The device gap doubles.** D12/D13 recorded no physical Android; there is presumably no physical iPhone either. Every "unverified on-device" residual-risk sentence must now name **which** devices. Task 27's device-gates lane inherits both.
4. **The frontend bar is explicit and high:** *"absolutely beautiful, modern components, modern UX"* — and specifically **not** templated defaults. The `frontend-design` skill is **mandatory** for UI work (already enabled). The **`impeccable` skill is INSTALLED** (owner supplied the source: `https://github.com/pbakaus/impeccable`, marketplace `impeccable`, plugin v3.9.1, Apache 2.0, by Paul Bakaus — *"Design fluency for AI harnesses. 1 skill, 23 commands, curated anti-patterns"*). Verified after install: cache went 0 → **106 files**, `impeccable@impeccable: true` in settings, skill present.
  **Audited before enabling, because it ships a `PostToolUse` hook that runs on every `Edit|Write|MultiEdit`** — i.e. on backend and docs edits too, not just UI. Findings: the hook is a **61-line stdin/stdout adapter with no network calls**, its stated contract is *"never break a turn. Always exit 0"*, it has a re-entrancy guard, and the skill self-scopes (*"Not for backend-only or non-UI tasks"*). `allowed-tools` are narrow (`Bash(npx impeccable *)`, `Bash(node .claude/skills/impeccable/scripts/*)`). No MCP server. **If it starts emitting design findings on server/docs edits, that is a misfire worth reporting, not a signal to obey.**
  Commands available for the frontend phase: `/impeccable polish`, `audit`, `critique`, `craft|shape`, `animate|bolder|colorize|delight|layout|overdrive|quieter|typeset`, `adapt|clarify|distill`, `harden|onboard|optimize`, `init|document|extract|live`.
5. **Design for the real use case, not the template.** The product constraints are unchanged and they are the design brief: tech-inadept users, Indonesian-first, bright sunlight, one-handed, 2 GB Android — **and now iOS hardware too**, which is a *different* interaction language (no hardware back button; different safe areas; different gesture idioms). "Beautiful" means beautiful **on both**, not an Android layout shipped through an iOS shell.

## Consequences

- **Filed as task 79** — the iOS parity audit. It is scoped as an **audit**, not a build: find every platform-conditional claim, state which leg is verified, and file the gaps. Frontend implementation stays deferred.
- **Task 59 (push muting) must reopen its analysis for iOS before anyone implements it.** Its current recommendation is Android-reasoned. It is already batched as an owner decision; this adds a dimension to that decision rather than resolving it.
- **Task 27 (device gates)** now has two physical-device legs, and `27b` (the PHYSICAL lane) is already blocked/deferred.
- **`security-guide` §6** needs an iOS column, or an explicit statement that its checklist is Android-only — currently it reads as platform-neutral and is not.
- **The frontend phase, when it starts, loads `frontend-design` (and `impeccable`, once installed) — not optional.**

## The honest note

The uncomfortable part: **`app.config.ts` has declared `platforms: ['android', 'ios']` the entire time**, while every test, guard, and residual-risk sentence covered Android alone. Nothing lied outright — and nothing verified the declaration either. That is this repo's signature failure (a claim nothing checks) operating one level above the code, on the platform list itself. Task 58 found `keychainAccessible` inert *because* the product was Android-first; D17 makes the same line load-bearing. **A ruling's correctness depends on a premise, and premises are owner decisions that can change** — which is why the ruling was recorded with its reasoning rather than just its conclusion.
