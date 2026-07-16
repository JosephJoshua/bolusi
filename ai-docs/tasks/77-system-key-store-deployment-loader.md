# TASK 77 — no server loader for the tenant system-device signing key; conflict detection is wired but OFF until one exists

**Status:** todo
**Priority:** HIGH — conflict detection is fully built, tested, and wired into the production push route, but **disabled in production** until a `SystemKeyStore` is provided. Without this, the server accepts colliding edits and detects nothing — silently.
**Depends on:** 17 (the seam), 13 (provisioning writes the key)
**Filed by:** impl-17, 2026-07-16
**Red flag (CLAUDE.md §6):** the key-loading MECHANISM (env format / file convention / KMS) is an outward-facing deployment decision — confirm the approach before building.

## The finding

Task 17 built server-side conflict detection end to end: the rules, the system-device op emission, the `conflicts`/`user_prefs` appliers, the push-transaction wiring, and the composition seam (`apps/server/src/sync/conflict-wiring.ts`). It is proven through the production route (`resolveDeps → routes/sync.ts → runPush → processPushBatch`) — see `conflict-wiring.test.ts`.

**But detection needs to SIGN `platform.conflict_detected` with the tenant's system-device Ed25519 private key, and there is no loader for that key.** 01 §3.6 is explicit: the key "is held server-side (KMS/env secret — deployment doc owns storage)". Today:

- `apps/server/src/config.ts` reads **only** `databaseUrl` and `port`. No secret loading of any kind.
- `provision-tenant` (task 13, hardened by task 17) **writes** the key to a 0600 file — but nothing reads it back into the running server.
- `resolveDeps` (`deps.ts`) enables detection **iff** an `overrides.systemKeyStore` is present. In production nothing provides one, so `detectConflicts` is `undefined` and the pipeline skips detection.

So detection is a **deliberate, visible no-op** in v0 — the same honest-default shape as an empty `SERVER_MODULES` folding nothing (task 49). This task provides the missing port implementation and flips it on.

## Why it is wired as "off by default" and not "throw when unconfigured"

If detection were enabled unconditionally and the key store threw when asked, the FIRST real collision between two devices would throw **inside the push transaction**, roll the whole push back, and hand the pushing device a 500 it can never get past — **sync wedged for that tenant, triggered by ordinary concurrent editing.** "Detect and fail" is strictly worse than "do not detect yet". The `conflict-wiring.ts` header documents this; it is why the seam is conditional on a store being present.

## Scope

Implement `SystemKeyStore` (`apps/server/src/sync/conflict-wiring.ts`):

```ts
export interface SystemKeyStore {
  getSystemSigner(tenantId: string): Promise<SystemSigner | undefined> | SystemSigner | undefined;
}
```

and inject it into `resolveDeps` in `main.ts` (production composition).

**Decide the key-loading mechanism first (the §6 confirm):**
- **Where does the key live in production?** Options 01 §3.6 names: KMS, or an env secret. `provision-tenant` currently writes a per-tenant file; a multi-tenant server needs a per-tenant lookup, so a single env var does not fit unless it holds a keyed map.
- **How is it keyed?** By `tenantId`. A file-per-tenant directory, a KMS alias per tenant, or a JSON map in one secret are the plausible shapes.
- **Rotation / absence.** `getSystemSigner` returns `undefined` for a tenant with no configured key — the store must not throw for an unknown tenant (that path is a startup-time "detection off for this tenant", not a per-push failure). It throws only when it HAS a key but cannot produce a signer.

**Security (this is a signing key — CLAUDE.md §2.5 / security-guide):**
- The key never touches Postgres (10-db §12; the RLS tables carry only the PUBLIC key on `devices`).
- The loaded private key stays in server memory, never logged (the pre-commit `gitleaks` scan and SEC-SECRET-02 are the backstop; task 17's `emitProvisionOutput` already keeps it off stdout at provisioning time).
- Adversarial test BEFORE review: a tenant whose key store returns `undefined` detects nothing and pushes succeed; a tenant WITH a key detects, and the emitted op **verifies against that tenant's system-device public key** (the `appendSystemOp` self-check already enforces this — a wrong key fails loudly at emission, not silently on a client pull).
- Falsify (§2.11): wire a key store returning the WRONG tenant's key → the emission self-check throws → the push rolls back. Watch it, then fix.

## Verify the premise (don't assume)

Confirmed by reading `config.ts` (2 fields), grepping `apps/server/src` for any system-key loader (only comments), and reading `deps.ts`'s `resolveDeps` (enables detection only on an injected `systemKeyStore`). Re-check before building — the seam may have moved.
