# Decision — 2026-07-14 (evening) — D11: identity is control-plane, not op-sourced

> Trigger: the spec coherence review surfaced that two authoring passes had assumed opposite identity architectures. All three reviewers flagged it as the top blocker. Resolved during the reconciliation pass.

## D11 — Users, roles, grants, PIN verifiers are server-administered directory data

**What:** Identity/authz data (users, roles, role-grants, PIN verifiers, devices, permission registry) is **control-plane**: mutated online-only via REST endpoints (api/02-auth), audited in `identity_audit`, distributed to devices via the enrollment bundle + conditional bundle refresh + the pull devices sidecar. It is **not** event-sourced through the operation log. The op log records *business actions* and *auth session/audit events* (user switches, permission denials, PIN lockouts, pin-change audit refs) — never identity mutations or credential material.

**Why (deciding argument):** PIN hashes inside an append-only, forever-retained, tenant-wide-replicated log are an unrotatable, undeletable credential store — old PIN verifiers could never be purged, and every device in the tenant would hold every user's verifier forever. Control-plane identity enables **verifier minimization** (a device holds verifiers only for its own store's users) and normal credential rotation.

**Also:** kills three structural complications the op-sourced model required — genesis carve-outs (ops whose actor is the user being created), offline loginIdentifier-collision conflict machinery, and system-device signing of identity ops inside push transactions. Offline PIN *authentication* is unaffected (verifiers are local via bundle); offline user *creation* is given up — an accepted, rare-case cost (PRD-011 requires offline auth, not offline user admin).

**Alternatives rejected:**
- *Op-sourced identity* (tenant-scoped auth.* ops replicated everywhere): single-mechanism elegance, offline user creation — rejected for the credential-in-immutable-log problem and tenant-wide verifier spread.
- *Hybrid (identity ops + server-side verifier channel):* keeps the worst of both; rejected.

**Consequences:** system device/user survives narrowed to signing `platform.conflict_detected`; auth op registry (api/02-auth §6.2) shrinks to session/audit events; 05 §9 gains per-type push rules incl. server-side permission validation of PIN ops (the one v0 exception to client-side-only authz — 02-permissions §4).
