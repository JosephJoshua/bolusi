# TASK 110 — record the `SYSTEM_KEY_DIR` deployment convention (01 §3.6 defers system-key storage to a "deployment doc" that does not exist)

**Status:** in-progress
**Priority:** **LOW** — docs-only. Task 78 shipped + falsified the mechanism (`DirectorySystemKeyStore` + optional `SYSTEM_KEY_DIR`, default-off, byte-identical to `provision-tenant`'s key files) and documented it at the `main.ts` wiring site + `.env.example`. What's missing is the SPEC-level record: `01-domain-model.md §3.6` explicitly defers system-key storage to "the deployment doc", and no deployment doc exists — so the convention lives only in code comments.
**Depends on:** 78
**Blocks:** —
**SEC ids owned by THIS task:** none (records an existing, tested mechanism; changes no behavior)

## The finding (task 78)

Conflict detection is ACTIVE in production **iff** a `SystemKeyStore` is injected, which `main.ts` now builds from `SYSTEM_KEY_DIR` (unset ⇒ detection off, today's default). The key files are exactly what `apps/server/src/cli/provision-tenant.ts` writes: `system-device-<tenantId>.key`, base64 of the raw Ed25519 secret (`defaultKeyPath` :269-270, encoding :70). Opted-in-but-broken fails LOUD (malformed/wrong-length throws at load; wrong-tenant key fails `appendSystemOp`'s self-check; missing key throws at emission and rolls the push back).

Nothing in `ai-docs/` records this. A deployer reading 01 §3.6 is pointed at a document that does not exist.

## Acceptance

- Record the convention in the right place — either a new short deployment doc (`ai-docs/deployment.md` or similar) or a concrete pointer in `01-domain-model.md §3.6` + `08-stack-and-repo.md`: **run `provision-tenant` per tenant → point `SYSTEM_KEY_DIR` at the directory of `system-device-<tenantId>.key` files → conflict detection activates; unset ⇒ detection off.** State the fail-loud semantics (opted-in-but-broken throws, it never silently degrades) and that KMS is a future swap behind the same `SystemKeyStore` port.
- **Also record the latent contract tension task 78 flagged** (so the next reader isn't misled — T-15): `conflict-wiring.ts`'s `SystemKeyStore` contract comment describes an undefined signer as a graceful "detection off for this tenant", but task-17's `systemIdentity` **throws** at emission — so per-tenant graceful-off is NOT achievable; a tenant with `SYSTEM_KEY_DIR` set but no key file fails loudly on its first real collision. Either fix the comment to match, or (owner call) change the behavior — but do not leave the aspiration reading as fact.
- Docs-only: no code change, no behavior change. `pnpm test`/`lint`/`typecheck` should be unmoved — if they move, say why (§2.1).

## Note
Filed from task 78. The mechanism is real, tested (13 tests on real PG16, both directions falsified) and format-parity-verified against provisioning; this task just moves the knowledge out of code comments into the spec where a deployer will find it.
