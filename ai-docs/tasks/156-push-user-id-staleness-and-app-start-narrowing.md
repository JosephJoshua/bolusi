# TASK 156 — two spec-vs-code deltas the push client accepted for v0, recorded so the REASONS stay true: `push_tokens.user_id` goes stale on a PIN switch, and app-start registration narrows api/04-push §2(a)

**Status:** todo
**Priority:** LOW — both are deliberate, bounded v0 scope with the capability already built. Filed so the deltas are tracked rather than living in a commit message, and because one commonly-stated justification for them is **wrong** and must not be quoted later as settled.
**Depends on:** 135 (merged 2026-07-22), 21 (EAS creds)
**Blocks:** —
**SEC ids owned by THIS task:** none.
**Filed by:** the task-135 reviewer, 2026-07-22, on the approving re-verify.

## Delta 1 — `push_tokens.user_id` goes stale on a PIN switch (and the WRONG reason for accepting it)

`registerPushTokenOnAppStart` is diff-gated on the token, so a user switch with an **unchanged** token does not re-POST, and `push_tokens.user_id` keeps the *previous* user's id.

**The reason to REJECT, because it is false:** "§4 falls back to `id-ID`, and this is an Indonesian-first product." **No.** §4's `id-ID` fallback applies when `user_id` is **NULL**. In the staleness case `user_id` is not null — it is a *different, real* user's id — so the server renders the notification in **that user's** locale. Concretely: user A (id-ID) logs in first → `user_id` = A; user B (en) PIN-switches in on the same device with an unchanged token → no POST → a conflict push renders in **Indonesian** while B is holding the device.

**The reasons that actually hold:** api/04-push §1/§9 — v0 addresses **devices, not users** ("the server cannot know who is holding the device"); per-user targeting and preferences are the explicit v1 bucket (FR-1149); push is best-effort and never load-bearing; the notification content ceiling is generic. On an Indonesian-first product the blast radius is one wrong-locale notification. **And the diff-gate is positively desirable here:** re-POSTing on every PIN switch on a shared counter terminal would burn §2's 30-registrations/day/device budget.

**Deliverable:** keep the behaviour; correct the stated justification wherever it is recorded (code comment and/or api/04-push), so no future reader inherits the false `id-ID` premise. If per-user locale ever moves into v0 scope, the fix is to re-stamp `user_id` on session change — but that needs the 30/day budget accounted for.

## Delta 2 — app-start registration narrows api/04-push §2(a)

`Root`'s effect gates on `sessionUserId !== null`, so a previously-enrolled device sitting on the switcher with **nobody logged in** does not (re)register. api/04-push **§2 trigger (a)** reads "**every app start** … POST when the token differs" — with **no session condition**. So this is a genuine narrowing of §2(a), not a spec match. (The permissive reading of "`user_id` can be null" explains why the *server* tolerates a null user, not why the client may skip.)

Accepted for v0 because task 135's own deliverable #1 specified "once a session exists", and §1 bounds the cost to a possibly-missed best-effort `sync` wake on a device where nobody logs in.

**The capability is ALREADY fully built** — `createFetchPushTransport` omits `X-Acting-User` when `actingUserId === null` (`transport.ts:45`) and `createPushRegistration` already accepts `string | null`. So strict §2(a) compliance is a **one-line change** to `Root`'s early return.

**Deliverable:** either make the one-line change (register at app start regardless of session, with a null acting user), **or** record the v0 narrowing in api/04-push §2 so the spec and the code agree. Do not leave them silently divergent.

## FALSIFY (§2.11)
If you take the one-line option: a composed test where a pre-enrolled device with **no session** boots and still POSTs its token with `actingUserId: null`. Break the change → reds. Positive control: with a session, the acting user is still stamped (don't regress 135's enrollment/app-start guards).
