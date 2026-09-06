# TASK 201 — an enrollment-seed / device-fixture seam so the pending Maestro flows can reach the enrolled+unlocked app on the serverless emulator lane

**Priority:** MEDIUM — this is the missing producer that blocks task 117's suite. Without it, 5 of 117's 6 authored flows can never run.
**Depends on:** 117 (the parked flows + the Maestro wiring), 27a (the emulator lane), 119 (the live-session app wiring — done)
**Blocks:** promoting `.maestro/pending-119/*` to top-level (i.e. 117's Deliverable #1 suite: pin-entry, shell-nav, note-create, archive-ConfirmSheet, i18n-toggle)
**SEC ids owned by THIS task:** none yet — **but option A below is a security surface** (§2.5): it forges enrolled-device state, so it must ship adversarial tests proving the door is production-unreachable BEFORE review, and likely earns a SEC id.
**Filed by:** the orchestrator, 2026-09-06, from a §2.1 ground-truth check while assessing whether 117 could be flipped `done`.

## The finding — why 117's suite has no producer

`01-launch-enrollment.yaml` is 117's one LIVE flow. It is serverlessly reachable because a fresh, unenrolled device gates unconditionally to the enrollment wizard (`navigation/zone.ts`), and the flow deliberately **stops before submit** — the login POST needs a server the emulator lane does not stand up (`EXPO_PUBLIC_API_URL=http://10.0.2.2:3000` is inlined but nothing listens).

The 5 pending flows (`.maestro/pending-119/02..06`) each need the app to boot into an **ENROLLED, ACTIVE device with a populated user list and no open session** → `resolveZone` returns `{ kind: 'switcher', mode: 'choose' }`. `02-pin-entry.yaml:9-12` states this precondition explicitly and credits the seeding seam to task 119 ("that seam is out of scope for task 117").

Ground truth on 2026-09-06: **119 is `done`, but it delivered the composition-root wiring** (`Root` constructs a session-scoped `NotesRuntime` *after* enrollment+PIN unlock, proven by a JS composed-app render test) — **not** an emulator seeding harness. The `.maestro/README.md` promotion plan ("once 119 lands, move the pending flows to the top level") assumed 119 would make the switcher reachable on the lane; it does not, because:
- the emulator lane runs **no server** (`scripts/emulator-gates.sh`: harness gates → `adb install` → `maestro test .maestro/`; no server, no seed step), and
- the app's only enrolled-state producer is real server enrollment; the harness door (`EXPO_PUBLIC_BOLUSI_TEST_HARNESS=1`) exposes the 27a correctness runners (SEED-200K op-log builder, rebuild/execute-latency, CHAOS) — it does **not** seed an enrolled device / session / user list into the UI-backing storage.

So the pending flows, if promoted today, would launch to the enrollment wizard (unenrolled) and RED on the first `assertVisible: switcher-screen`. **The blocker is a missing capability, not a missing `git mv`.**

## Two ways to close it (pick one — this fork is part of the task)

**Option A — client-side, harness-gated enrollment seed (no server on the lane).**
A harness command (behind `EXPO_PUBLIC_BOLUSI_TEST_HARNESS=1`, invoked via `adb` in `emulator-gates.sh` before `maestro test`) that writes a synthetic enrolled device + device key + populated user list into the app's persistent storage (SQLCipher DB + secure store), leaving `session:null` (locked) so the app boots to the switcher.
- **This is a §2.5 security surface.** It fabricates the exact enrolled state the auth gate is supposed to prove. It MUST be unreachable in production (the flag is compiled out of prod builds — falsify that), and MUST NOT weaken SEC-DEV-06 (the enrolled-but-bound key invariant) or the boot probe (task 160/197). Ship adversarial tests that the door is shut in a prod-profile build BEFORE review.
- Cheapest to run (no server infra on the lane), but the highest-care surface.

**Option B — stand up `@bolusi/server` on the emulator lane.**
Run a real (PGlite or ephemeral-PG) `@bolusi/server` inside the `android-emulator-runner` `script`, reachable at `10.0.2.2:3000`, so the flows enroll for real through the UI. Reuses task 198's socket-exposed `HarnessServer` + `adb reverse` / `10.0.2.2` mapping — but note 198's server is a TEST harness (`"private": true`) and **must not** become an `apps/mobile` dependency (standing constraint). Heavier infra; no forge-enrolled-state door, so a smaller security surface.

**Owner input wanted:** if the v0 intent for 117 was only the launch-enrollment native flow (the one serverlessly-reachable journey), the alternative to building this seam is to **formally re-scope 117** (spec change, its own task per §4) to launch-only for v0 and move the 5-flow suite to v1 — then this task becomes a v1 item. Do not silently shrink 117's acceptance; that is the owner's call.

## Acceptance (whichever option)
- The 5 pending flows are promoted to top-level `.maestro/` (or a `config.yaml` with `flows: ['**']`) and **pass on the emulator lane** — read the lane's OWN output, not the badge (§2.1); the emulator lane is schedule/`workflow_dispatch`, so verification is a dispatched run, not a PR.
- **Falsify (§2.11):** point one promoted flow's `assertVisible` at a label the screen does not show → the flow reds and fails the job (no `|| true`, no `continue-on-error`); restore → green. Report it (CI-observed if no local AVD).
- Option A only: a prod-profile build cannot reach the seed door — falsify by building without the flag and asserting the command is absent/no-op; the seed must not weaken SEC-DEV-06 or the 160/197 boot probe.
- `pnpm typecheck` / `lint` green.

## Note
117 stays `blocked` on this task until the suite runs. `01-launch-enrollment` remains live+green meanwhile — the native-E2E harness itself (install → APK → `maestro test` → artifacts → non-zero on failure) is delivered and proven; only the enrolled-state journeys are gated here.
