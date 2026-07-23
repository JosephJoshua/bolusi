# D23 — Owner rulings: push-tap draft retention, media-init existence oracle, empty-roster CTA, emulator API level

**Date:** 2026-07-23
**Asked by:** orchestrator, as a batch (CLAUDE.md §2.2 — batch questions, interrupt only for §6 decisions).
**Status:** BINDING. Supersedes any contrary reasoning in the task files listed below.

Four questions, all §6 red flags (hard-to-reverse, security-surface, or outward-facing). Each was put
with its real costs stated so the ruling could be made without re-deriving them.

---

## 1. Push-notification tap while a draft is dirty (task 159) → **PRESERVE THE DRAFT, THEN NAVIGATE**

**Ruled:** the tap must always navigate, and the draft must survive it. NOT gated behind the discard
prompt, and NOT deferred to v1.

**What this changes.** The orchestrator recommended gating behind the existing `leaveHome` /
ConfirmSheet path because it ships now with no new machinery. The owner ruled for the better UX
instead, accepting the dependency it creates.

**Consequence — sequencing, not a nicety:** preserve-then-navigate requires **task 155** (work
retention into task 133's idle-lock path), which is currently `todo` and unstarted. So:

- **155 now BLOCKS 159.** 159 cannot be implemented first, and must not be implemented as a partial
  ("navigate and hope") — that would ship the silent draft-loss this ruling exists to remove.
- **155's priority rises accordingly.** It stops being a leftover and becomes the prerequisite for a
  ruled-on user-facing behaviour.
- 159 remains the LAST producer of task 145's draft-loss class; with this ruling the class is closed
  by retention rather than by prompting.

## 2. `POST /v1/media/:id/init` cross-tenant existence oracle → **TENANT-SCOPE THE MEDIA ID**

**Ruled:** make media id uniqueness `(tenant_id, id)` rather than global, so an id another tenant
holds simply does not exist in your tenant and both cases answer `200`. **Remove the oracle rather
than document it.**

**Why the alternative was rejected.** Documenting it as a §2.2 exception 3 was available and cheap,
but its justification could not be borrowed from exception 2: impl-141a traced this route's budget to
`routeLimit` → `perRoutePerMinute: 120` (`apps/server/src/deps.ts:71`) — **120/min, not 30/day**.
That is ~172,800 probes/day against UUIDv7's 74 random bits, three orders of magnitude looser than
the push-token budget, and a rate rather than a daily cap. The budget leg that carries exception 2
does not reach here (see D22 §2 addendum: exception 2's entropy leg was withdrawn, leaving only the
budget).

**Consequences:**
- Needs a **DB migration + index change**. Migrations serialize globally (CLAUDE.md §4) — this must
  not run concurrently with another migration task.
- `security-guide.md` §2.2 stays at **exactly two** documented exceptions. Task 141a's gate asserts
  that count; this ruling means it does not have to move.
- `KNOWN_EXISTENCE_CONTROL_DIFFERENCES`' pin on `POST /v1/media/:id/init` is **temporary by
  construction** and must be REMOVED when the fix lands — the pin is bidirectional, so it will red
  the day the difference disappears. That red is the signal to delete the entry, not to widen it.
- Filed as its own task; see `ai-docs/tasks/_index.md`.

## 3. Switcher empty-roster CTA (`onEnroll`, task 130 / 168) → **REPLACE WITH GUIDANCE TEXT**

**Ruled:** do not wire it, and do not ship it inert. Replace the control with empty-state guidance
text, and file the enrollment flow for v1 with its security work scoped properly.

**Why.** design-system §5 forbids a control that cannot work from rendering at all, so "leave inert
and file for v1" was not available — it is the exact defect task 130 exists to remove. Wiring it was
rejected for v0 because it requires a new input on the **`resolveZone` security gate** and completing
it runs api/02-auth §7.4 re-enrollment: new `deviceId`, new keypair, a fresh chain at seq 1, and the
**old registration left active server-side**. Both are security surface that §2.5 requires be worked
through a checklist with adversarial tests written BEFORE review — not bolted onto a dead-control fix.

**Consequences:**
- The empty state must still tell the user what to do (design-system §5 mandatory states); guidance
  text goes through the i18n catalogs (07-i18n), Indonesian-first — no hardcoded string.
- v1 enrollment task must carry the two costs above as its scope, not discover them.

## 4. Android emulator lane `api-level` (task 167) → **RAISE TO API 36**

**Ruled:** raise the lane to API 36 so it exercises the OS version we actually ship.

**Why.** `.github/workflows/ci.yml` pinned `api-level: 34` while the app builds `targetSdk 36`
(`ai-docs/tasks/148-….md:89`). `AndroidVersion.kt:51-53` gates the predictive-back shim on
`SDK_INT >= 36` **AND** `targetSdkVersion >= 36`, so every `isAtLeastTargetSdk36` behaviour —
predictive back among them — was unexercised **by construction**. A lane answering correctness for a
different OS version than we ship puts an unstated caveat on every claim it produces.

**Accepted cost:** API 36 system images are newer; some CI flakiness and longer boot are possible on
first runs. Running both 34 and 36 was rejected as roughly doubling wall-clock on a nightly job whose
build step alone is ~21 minutes.

**Consequence:** this lands on top of task 162 (which made the lane's gates executable at all — they
had never run). Expect the first genuinely-executing run to be red; that is progress, not regression.

---

## Cross-cutting note
Rulings 2 and 4 both correct a situation where a green or documented state was resting on something
unexamined — a budget assumed comparable to another route's, and a lane assumed to test what we ship.
Neither was visible to any gate. Both were found by asking what would notice if the assumption were
wrong (CLAUDE.md §2.11).
