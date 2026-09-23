# TASK 168 — v1: re-enrolling an ACTIVE device from the empty roster (the flow D23 §3 ruled out of v0)

**Priority:** LOW for v0 (the v0 hole is closed — the affordance is gone, not inert), MEDIUM for v1: an enrolled device whose store has zero `active` users is currently a device the shop cannot recover from in-app at all.
**Depends on:** 130
**Blocks:** —
**SEC ids owned by THIS task:** none yet — see §"Security surface" below; this flow touches the shell's gate and the device registry, so `security-guide` §1 review applies and an id may be owed.
**Filed by:** task 130's implementer, 2026-07-23. **Origin: owner ruling D23 §3** (`ai-docs/decisions/2026-07-23-owner-rulings-push-tap-media-oracle-enroll-cta-emulator-api.md`).

## What was decided, and what is left

`SwitcherScreen`'s §5 Empty state carried a create-CTA (`auth.switcher.addUser`, "Tambah Pengguna")
whose `onCreate` the composition root wired to `noop`. design-system §8.2 says that CTA should open
Device Enrollment (§8.5).

**D23 §3 ruled: remove the affordance for v0, do not wire it.** Task 130 did that — the CTA is gone,
the `onEnroll` prop is deleted (not stubbed), and the Empty state now carries guidance text
(`auth.switcher.emptyUsers`: *"Belum ada pengguna di perangkat ini. Minta pemilik toko untuk
mendaftarkannya."*). §5's "a control that cannot work must not render" is satisfied, and §5's
"Empty must say what to do" is satisfied by text naming the real-world action.

**This task is the flow itself, for v1.** It is filed with the two costs already established, so the
next person implements them rather than re-deriving them — that is the whole point of the file.

## Cost 1 — a new input on the shell's SECURITY gate

`resolveZone` (`apps/mobile/src/navigation/zone.ts:79-100`) returns `{kind: 'enrollment'}` for
`unenrolled` and `revoked` devices **only**, and device status is checked FIRST and unconditionally.
That ordering is a stated security property, not an implementation detail: *"a gate that checked the
session first would leave a revoked device usable until someone happened to lock it"* (zone.ts:73-77),
and task 24's tests drive exactly that combination.

Reaching the wizard from an `active` device therefore needs a new field on `ZoneInput`, in the shape
of task 143's `switching`. Constraints that fall out of the existing model:

- The check must sit **inside** the `session === null` branch and after the `locked` / `pinFor`
  checks, so an idle lock and a pending PIN both beat it. Anywhere earlier and `enrolling: true` set
  before a lock would render the wizard over a locked device.
- `backTarget` (zone.ts:116-134) returns `null` for `enrollment` — *"Nothing behind the wizard: the
  device is unusable until it enrolls"*. That is no longer true for a voluntary re-enrollment, which
  must be abandonable back to the switcher. Adding an answer there is part of this task.

## Cost 2 — the orphaned ACTIVE registration

api/02-auth §7.4 (`ai-docs/api/02-auth.md:460`): *"A wiped (or factory-reset) device may enroll again
via §4 as a **new device**: new `deviceId`, new keypair, new token, new chain starting at seq 1
(05 §4). A device identity is never resurrected; the old chain simply ends."*

So completing this flow mints a second registration. 03-state-machines §5
(`ai-docs/03-state-machines.md:95`) gives `Device.status` exactly one transition out of `active` —
`active → revoked`, via `POST /v1/devices/:deviceId/revoke`, online-only, control plane. **Nothing in
the re-enrollment path revokes the old row**, so absent extra work the shop is left with two `active`
registrations for one physical handset, one of which nothing will ever use again.

That is the question this task must answer explicitly rather than inherit: does the flow revoke the
outgoing device (needs `auth.device_revoke` or a control session — 02-permissions §11), does the
server do it at enroll time, or is the orphan accepted and surfaced in the device list?

## Security surface

Both costs are security surface: the first changes the shell's auth gate, the second changes what a
device registry means. `security-guide` §1's checklist applies and adversarial tests are written
BEFORE review (CLAUDE.md §2.5) — at minimum: an idle lock beats `enrolling`; a revoked device still
routes to the revoked wizard and not to this one; abandoning the flow leaves the original identity
and its chain untouched.

## Falsify

A COMPOSED test on the real `App`/`Root` tree — `apps/mobile/test/live-shell-dead-controls.test.tsx`
is the pattern and already contains the v0 half (`an empty directory renders guidance text and NO
pressable create control`, falsified by restoring `createLabel`/`onCreate` → the CTA node reappears
and the test reds). A component test injecting `vi.fn()` proves nothing here: that is exactly what
let this control ship dead through task 24, 119 and 143 without a single red.

## BUILT FOR v0 2026-09-23 — D23 §3 amended by D27

Owner ruled the flow in for v0 and chose the replacement semantics
(`decisions/2026-09-23-reenroll-active-device-replaces-old.md`). Both costs this file recorded are
paid, not inherited.

**Cost 1 — the gate.** `ZoneInput` gains `reenrolling`, read INSIDE the `session === null` branch and
AFTER `locked`/`pinFor`, exactly where this file predicted. `Zone`'s enrolment variant gains
`voluntary`, which is what lets `backTarget` answer `{kind:'switcher'}` for a chosen re-enrolment
while still returning `null` for a forced one — the semantic change this file flagged.

**Cost 2 — the orphan.** Answered explicitly rather than inherited: the enrol request carries
`replacesDeviceId`, and the server revokes the named device in the SAME transaction that registers
its successor, through the existing `revokeDevice` (so the audit row, push-token cleanup and
revocation hooks come for free). One handset is never two `active` registrations, and the old device
token does not outlive the swap.

**A premise in this file was wrong, and is corrected in D27.** It reads as though the flow has no
authenticated actor. `POST /v1/devices/enroll` is control-session only (§4.5), so the operator
authenticates with owner credentials — there IS an acting user to authorise the revoke against, and
no new permission model was needed.

**Falsified (§2.11), both directions:**
- Wired the CTA to `() => {}` — the composed test red: *"the CTA did not reach Device Enrolment"*.
  That is the precise defect that shipped dead through tasks 24, 119 and 143 without a single red,
  and the reason this file demanded a composed test over an injected `vi.fn()`.
- Removed the `!input.locked` guard so `reenrolling` could beat a lock — *"an IDLE LOCK beats
  re-enrolling"* red. Restored; 47/47 navigation tests green.

**Not run locally, and not claimed:** `apps/server/test/identity/enroll-replaces.test.ts` (six
adversarial controls incl. the cross-tenant `replacesDeviceId` case) needs Docker/testcontainers,
which this host lacks. CI's `server-integration` lane executes them — read that lane, do not infer
from this file.

**Spec edits, in scope per D27:** `api/02-auth.md` §4.3 + §7.4, `03-state-machines.md` §5 (the
`active → revoked` row gains the enrol-with-replacement trigger, converging on one implementation).
