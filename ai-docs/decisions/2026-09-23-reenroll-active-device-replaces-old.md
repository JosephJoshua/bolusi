# D27 — Owner ruling: build in-app re-enrolment for v0, and have enrolment REPLACE the outgoing device

**Date:** 2026-09-23 · **Status:** Accepted — owner decision ("build it now"; "client sends
`replacesDeviceId`, server revokes").
**Amends: D23 §3**, which ruled the empty-roster create-CTA out of v0. That ruling stands as correct
for its moment; the conditions it was made under have changed (see below).
**Unblocks:** task 168, which D23 §3 had deferred to v1.

## What changed since D23 §3

D23 §3 removed the switcher's empty-state CTA rather than wiring it, because v0 had a full queue and
the flow behind it was unbuilt. Task 130 did that correctly — the control is gone, not inert, and the
Empty state carries guidance text instead.

What is different now: **v0's actionable queue is empty**, and the hole the ruling accepted is real.
A store whose roster empties out (every user deactivated) has an enrolled, working device that cannot
be recovered from inside the app at all. The guidance text tells the user to ask the store owner —
who may be exactly the person who was just deactivated.

## Ruling 1 — the flow ships for v0

The switcher's empty state regains a control that opens Device Enrolment. It is reachable ONLY from
the empty-roster state; it is not a general "add a device" affordance.

**The shell gate's ordering is unchanged and remains the security property.** `resolveZone` checks
device status FIRST and unconditionally — a revoked device must route to the revoked wizard and can
never reach this flow. The new input sits INSIDE the `session === null` branch, AFTER the `locked`
and `pinFor` checks, so an idle lock and a pending PIN both beat it. `switching` (task 143) is the
precedent: same gate, same class of input, same "must not beat a lock" constraint.

## Ruling 2 — enrolment REPLACES the outgoing registration

api/02-auth §7.4 is unchanged: a device identity is never resurrected. Re-enrolling mints a new
`deviceId`, keypair, token and chain. The question this decision settles is what happens to the OLD
row, which nothing previously revoked.

**Rejected — accept the orphan.** It leaves two `active` registrations for one physical handset and,
worse, leaves the old device TOKEN valid indefinitely. "Someone will revoke it later" is not a
control.

**Accepted — the client names the device it replaces, and the server revokes it atomically.** The
enrolling device still holds its old `deviceId`, so `EnrollReq` gains an optional `replacesDeviceId`.
When present the server, inside the SAME transaction that registers the new device:

1. loads the named device and requires it to exist in this tenant;
2. requires the acting control-session user to hold `auth.device_revoke` scoped to THAT device's
   store — the same permission the standalone revoke endpoint demands, so this opens no new path;
3. revokes it through the existing `revokeDevice` helper — not a second implementation;
4. registers the new device.

Atomic by construction: there is no window in which the old device is revoked but the new one failed
to register, and no window in which both are active. The existing `Idempotency-Key` handling already
wraps the whole operation, so a retried enrol does not double-revoke.

**Authorisation note.** An earlier reading of task 168 assumed this flow had no authenticated actor
("the roster is empty, so nobody can sign in"). That is wrong: `POST /v1/devices/enroll` is
**control-session only** (§4.5), so the operator authenticates with owner credentials, not with a
local device user. There is therefore an acting user to authorise the revoke against, and NO new
permission model is required.

## Spec edits are IN SCOPE for task 168

CLAUDE.md §4 makes spec changes their own task. This decision declares the following in scope for 168
instead, on the precedent of task 27 (whose acceptance declares an `api/02-auth.md` edit in-scope
"not a side effect"), because they define the behaviour being built and would be meaningless apart
from it:

- `api/02-auth.md` §4.3 — `replacesDeviceId` on the enrol request, and its authorisation rule.
- `api/02-auth.md` §7.4 — note that re-enrolment may now revoke the replaced device.
- `03-state-machines.md` §5 — `active → revoked` gains a second trigger (enrol-with-replacement)
  alongside the existing explicit revoke endpoint.

## Security surface (CLAUDE.md §2.5 — adversarial tests BEFORE review)

At minimum, and all written before review:
- an idle lock beats the new `enrolling` input;
- a **revoked** device still routes to the revoked wizard, never to this flow;
- abandoning the flow leaves the original identity, its token and its chain untouched;
- `replacesDeviceId` naming a device in ANOTHER tenant fails closed (the lookup is tenant-scoped);
- `replacesDeviceId` without `auth.device_revoke` on that device's store is denied, and the enrol
  does NOT partially apply.

## Residual risk

The replaced device's revocation fires the existing revocation hooks (socket close), so an in-flight
sync on the old identity is terminated rather than left running. Un-pushed ops held only by the old
identity are lost — unchanged from any revocation, and inherent to §7.4's "the old chain simply
ends". The operator is choosing recovery over those ops, which is the same trade the wipe-and-enrol
path already makes.
