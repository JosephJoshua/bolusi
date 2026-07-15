# TASK 45 — `verifyPin` never bounds-checks the verifier it reads; task 10's "DELETE WHEN TASK 14 LANDS" is now false
**Status:** todo
**Priority:** LOW (F2 is defence-in-depth only; F5 is a comment that will mislead the next agent). From review-04's task 14 review.
**Depends on:** 14

Two small, unrelated-but-adjacent cleanups on the auth/runtime seam.

## F2 — `verifyPin` hands stored params straight to the KDF without a bounds check

`verifier.ts:160-169` + `repo.ts:144`. Reproduced: a tampered `pin_verifiers` row with `mKiB=1048576` (1 GiB) flows into the KDF as `{memoryCost: 1048576, …}` with nothing thrown.

**Why this is LOW, not a DoS** — size it honestly before "fixing" it:
- **The hostile vector is already closed.** `applyBundle` (`bundle-apply.ts:75`) *does* bounds-check, and that is the **server-supplied** path — the actual threat. Task 14's own falsification proved it: disable `assertVerifierInBounds` and a hostile bundle with `m=1 GiB` is accepted (5 red).
- The only entry here is **local DB write access** — and an attacker with that can zero the lockout counter anyway, which is strictly worse.
- **A read-side check would be partly vacuous as written:** `readVerifier` hardcodes `algorithm:'argon2id'` and `p:1` regardless of the stored bytes, so a check that doesn't *also* read those is checking a value it just invented (T-13 — interrogate what decides truth in the comparison).

**Also in scope, from the same review:** `buildPinVerifier` (`verifier.ts:184-194`) runs the KDF **before** `assertVerifierInBounds`. Hidden because its own test picks `memoryCost: 8192` — small enough that the ordering never shows. Params there come only from local config (`deps.kdfParams ?? DEFAULT_KDF_PARAMS`), never the server, so it is check-after-use on non-hostile input. Reorder it.

## F5 — task 10's `runtime/ports.ts:64-73` comment is false and will mislead

It says **"DELETE WHEN TASK 14 LANDS"**. Task 14 landed and correctly did **not** delete it. The reviewer's ruling, which I endorse:

> `SigningKeyPort` is a one-method structural constraint that `KeyStorePort` satisfies. Deleting it and typing `CommandRuntime.signingKey` as `KeyStorePort` would force the command runtime to depend on enrollment/token/wipe concerns and make every runtime test build a 6-method fake. **That's interface segregation, not duplication — §2.8 forbids duplicate *implementations*; `SigningKeyPort` carries no logic and there is exactly one impl.**

The harness proves both shapes work (`_harness.ts:390` minimal fake; `FakeKeyStore` full port). So the design is right and **the comment is the debt**: the next agent either obeys it and breaks the design, or stalls working out why it shouldn't. Task 14 declined to edit it because the file is contended (§4) — correctly. That's what this task is for.

**Rewrite it** to state the actual relationship: `SigningKeyPort` is the runtime's segregated view; `KeyStorePort` (task 14) structurally satisfies it; there is one implementation and no duplication; do not collapse them.

## Docs to read

- `packages/core/src/auth/verifier.ts` :160-169 (read path), :184-194 (`buildPinVerifier` ordering); `repo.ts:144`; `bundle-apply.ts:75` (the check that *is* correctly placed — mirror its shape).
- `packages/core/src/runtime/ports.ts` :64-73 (the false comment); `packages/core/test/runtime/_harness.ts:390` + `FakeKeyStore` (why both shapes exist).
- `api/02-auth.md` §6.5 (KDF params + bounds), §3 (the signing key is a *device* credential — see the note below).
- `CLAUDE.md` §2.8; `testing-guide.md` T-13, T-11.

## Skills

- `superpowers:test-driven-development`, `superpowers:verification-before-completion`.
- Worktree isolation per CLAUDE.md §2.3 — first step: `git branch --show-current`; STOP if on `main`.

## Files / modules touched

- `packages/core/src/auth/verifier.ts` (+ tests), `packages/core/src/runtime/ports.ts` (comment only). **`@bolusi/core` is contended (CLAUDE.md §4)** — serialize.

## Acceptance

- **F2 — prove it first** (T-11): tamper a stored verifier to `mKiB=1048576`, call `verifyPin`, watch it reach the KDF unchecked. Then add the read-side check — and **read the stored `algorithm`/`p` too**, or the check is partly vacuous (it would be validating constants `readVerifier` just hardcoded). Falsify: tampered row → rejected; **positive control**: a legitimate floor-params verifier (`mKiB=19456, t=2`) still verifies (T-14b — a bounds check that rejects everything is not a fix). Confirm `applyBundle`'s existing check still holds.
- **F2b** — reorder `buildPinVerifier` to check bounds **before** running the KDF. Its test uses `memoryCost: 8192`; make the ordering observable rather than accidentally invisible.
- **F5** — rewrite the comment to state the real relationship. No code change. Verify by grep that no other file carries a stale "delete when task N lands" instruction that is now false (**T-12: the class is "instructions to a future agent that expired"**, and this repo has now shipped four false claims-in-comments — task 10's brand comment, task 11's "dialect-neutral" docblock, task 41's lock-ordering comment, and this one).
- `pnpm test`, `pnpm lint`, `pnpm typecheck` green. **Read the output, not the exit code** (§2.1).

## Note

Both from review-04's task 14 review, and both correctly sized down rather than up — F2's headline ("a 1 GiB KDF param reaches the KDF!") is alarming until you check which path it's on, and the reviewer checked: the hostile path is closed, this one needs local DB write access, and an attacker with that owns the counter anyway.

Worth recording the F5 ruling explicitly, because it is the session's one case where **the "duplicate" was correct and the instruction to remove it was wrong**. §2.8 exists to stop two implementations drifting; it does not forbid a narrow interface. The reviewer's test for the difference is a good one: *does it carry logic, and is there more than one impl?* Here: no, and no.
