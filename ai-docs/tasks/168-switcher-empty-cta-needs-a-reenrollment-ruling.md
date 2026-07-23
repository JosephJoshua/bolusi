# TASK 168 — the empty switcher's "Tambah pengguna" CTA is still dead, and wiring it is a device-lifecycle decision nobody has made

**Status:** todo
**Priority:** LOW-frequency, MEDIUM-consequence — the state is rare (an enrolled device whose store has zero `active` users), but the CTA renders, responds to touch, and does nothing (design-system §5 MUST-NOT), and the obvious wiring has an irreversible side effect.
**Depends on:** 130
**Blocks:** —
**SEC ids owned by THIS task:** none.
**Filed by:** task 130's implementer, 2026-07-23 — the one control of five it declined to wire unilaterally.

## The finding

`App.tsx` passes `onEnroll={noop}` to `SwitcherScreen`. It is the create-CTA of the §5 Empty state
(`SWITCHER_EMPTY_CTA_KEY = 'auth.switcher.addUser'` — "Tambah pengguna"), reachable when
`switcherState` sees an empty directory on an enrolled device: every user deactivated, or a bundle
that has not populated `users_directory`.

design-system §8.2 states the intended destination outright: *"empty (no enrolled users → CTA to
Device Enrollment §8.5)"*. So this is not an undecided design — it is a decided design whose wiring
has a consequence the design does not mention.

## Why task 130 stopped rather than wiring it

Two things, both load-bearing:

1. **It needs a new input on the shell's SECURITY gate.** `resolveZone` returns
   `{kind: 'enrollment'}` for `unenrolled` and `revoked` devices only (`navigation/zone.ts` — device
   status is checked FIRST and unconditionally, and that ordering is the property task 24's tests
   pin). Reaching the wizard from an `active` device means a new field, in the shape of task 143's
   `switching` — plus a `backTarget` answer for "abandoned re-enrollment", which today is `null`
   ("nothing behind the wizard") because the wizard has only ever been the terminal surface of a
   device that cannot work.

2. **Completing it is irreversible and outward-facing (CLAUDE.md §6).** api/02-auth §7.4 is explicit:
   re-enrollment is *"a **new device**: new `deviceId`, new keypair, new token, new chain starting at
   seq 1 (05 §4). A device identity is never resurrected; the old chain simply ends."* So the CTA on
   a working device ends that device's op chain and mints a second registration server-side, while
   the first stays `active` until someone revokes it (03 §5 has no `active → re-enroll` transition —
   only `active → revoked`, via the control plane). A staff member tapping "Tambah pengguna" would
   not expect that, and nothing on the wizard's step 1 says it.

## What a ruling has to choose between

| Option | What it costs |
| ------ | ------------- |
| (a) **Wire it, with a confirm.** New `enrolling` gate input (checked strictly inside `session === null && !locked && pinFor === null`, so a lock always wins), plus a ConfirmSheet naming the consequence in the label catalog. | A new gate input on the security gate; new i18n copy (contended); the orphan-registration question stays open unless the wizard revokes the old device first. |
| (b) **Remove the affordance.** §5's own rule is that a create-CTA renders *iff* the user holds the create permission — and this surface is pre-auth, so there is no user and no permission. Empty then reads "no users; ask the store owner" with no button. | Deviates from §8.2's stated CTA, so §8.2 changes first (spec edit — its own task). New copy (contended). |
| (c) **Re-point it at the directory read** (the same producer `onRetry` now uses). | Rejected on sight, recorded so nobody re-proposes it: the button says "add user" and would refresh a list. A control that lies about what it does is worse than one that does nothing. |

## Deliverable

- An owner ruling between (a) and (b), recorded in `decisions/`.
- Then the code: either the gate input + confirm + revoke question answered, or the affordance
  removed and `design-system.md` §8.2 amended in the same change.
- Delete `App.tsx`'s `noop` helper with it — task 130 left it alive for this one call site only, and
  a `noop` helper with no callers is the next dead control waiting to happen.

## Falsify

Whichever way it goes, the proof is a COMPOSED test on the real `App`/`Root` tree (task 130's
`test/live-shell-dead-controls.test.tsx` is the pattern), not a component test injecting `vi.fn()` —
that is precisely what let this control ship dead. For (a): seed a directory with zero `active`
users, press the CTA, observe the enrollment zone AND that an idle lock still beats it. For (b):
observe that no pressable node renders in the empty state at all.
