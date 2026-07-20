# TASK 98 — the SERVER arm may deny without an FR-1045 audit op — the mirror of task 44, one arm over (CONFIRM by producer-trace before fixing)

**Status:** in-progress
**Priority:** **MEDIUM** — a plausible FR-1045 (denial-audit completeness) gap on the server, surfaced + independently confirmed-as-real-but-out-of-scope by task 44's implement + review. Unlike task 44 (which had a clean producer-trace), this one is **not yet traced to a confirmed producer** — the FIRST deliverable is the trace (T-16); do not write a fix on the strength of this description.
**Depends on:** 13
**Blocks:** 28
**SEC ids owned by THIS task:** none new — this is the server arm of FR-1045 / SEC-AUTH denial auditing (confirm which, if any, SEC id's server leg lands here vs task 13 during the trace).

## The finding (task 44 implement f-1 + rev-44 check 5)

Task 44 closed the **client** arm: an offline `restriction_violated` denial now emits `auth.permission_denied`. Two independent passes then flagged the server arm:
- `apps/server` references `restriction_violated` / `permission_denied` **zero times** (grep).
- The server §5.4 identity-endpoint denials (`apps/server/src/identity/errors.ts`: `ACTING_USER_INVALID: 403`, etc.) deny via **HTTP errors** and appear NOT to emit an `auth.permission_denied` audit op.
- rev-44 confirmed this is **real but pre-existing**, out of task-44 scope, and that task 44's `02-permissions.md` §7 amendment does **not** falsely claim the server audits (§7 already routes server directory-mutation auditing to a separate `identity_audit` log — so part of the server story may be intentionally a DIFFERENT log, not a gap).

## Why a trace comes first (T-16, and this task's whole risk)

The question is **not** "does the server emit `auth.permission_denied`?" (it does not) — it is **"is that a GAP or the intended design?"** §7 says server directory mutations audit to `identity_audit`, NOT to the op-log denial trail. So some server denials are *supposed* to be absent from the `auth.permission_denied` fold. The task is to find the denials that SHOULD be audited (per FR-1045 / the §5.4 rules) and are in **neither** log — a real hole — versus those correctly routed to `identity_audit`.

**Deliverable 1 (before any code):** a producer-trace table — every server denial site (identity endpoints §5.4 rules 1–5, any permission gate on the sync/media surfaces), what it emits today (HTTP code + which audit log, if any), and whether FR-1045 requires it in an audit trail. Report that table and STOP if it shows no real gap (then this task closes as "no defect — server denials audit to `identity_audit` by design", and that becomes a one-line doc confirmation).

## Acceptance (only the arms the trace proves are gaps)

- For each CONFIRMED gap: emit the audit record through the server's **existing** audit mechanism (reuse `identity_audit` or the op-log denial trail as §7 dictates — do NOT invent a third; §2.8), at the one server enforcement point (mirror task 44's single-emitter discipline; no per-endpoint copies).
- **Falsify (§2.11):** a denied server request with the fix produces the audit record; break the emission → the record is absent → test RED (on real PG16 — this is a server surface, task 73's lane); restore → green. Assert the whole captured denial set (T-14).
- **Non-recursion + no new sanctioned type** — same constraints as task 44 (05 §5.1 closed set). If a server gap genuinely needs a new op type or a permission-matrix change, STOP and report (RED FLAG §6).
- Update `02-permissions.md` §7 only if the server behavior changes — and make the client/server split explicit so no future reader thinks one arm covers the other (T-15).
- `pnpm typecheck`/`pnpm lint`/`pnpm test` (incl real-PG16 server) green — read the output (§2.1).

## Note
Filed from task 44. This is the same server/client audit split that recurs on this project: one arm ships and looks done, the other is a different code path nobody re-checked. Task 44 closed the client arm honestly and flagged this rather than guessing at the server — the right call (§4). **Blocks task 28** (the security sweep reads back the denial audit trail; it must know whether the server arm is a real gap or an `identity_audit` design choice before it can assert completeness).
