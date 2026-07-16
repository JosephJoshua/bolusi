# TASK 03 — crypto + canonicalization (@bolusi/core crypto, JCS, RFC 8785 vectors)
**Status:** done
**Depends on:** 01, 02

## Goal
Deliver the crypto foundation of `@bolusi/core`: the `CryptoPort` interface (`sha256`, Ed25519 `sign`/`verify` (+ keygen), argon2id `kdf`, `randomBytes` — surface per 08 §3.2), a JCS canonicalization wrapper over `canonicalize` 3.0.0 with input guards (typed rejection of `undefined` values, `NaN`, `±Infinity`, `BigInt` — never silent key-dropping), the canonical-order comparator (`timestamp ASC, deviceId ASC, seq ASC` per 05 §4), and the hash/sign helpers for the signed core (`hash = SHA-256(JCS(signedCore))`, Ed25519 signature over the **raw 32-byte hash**, per 05 §2.2/§3). It also delivers the noble-based reference `CryptoPort` implementation (`@noble/curves` + `@noble/hashes` 2.2.0) in `@bolusi/test-support` — the boundary matrix (08 §3.3) forbids noble inside `core`; `apps/server` binds its own thin adapter over the same pins in task 07/12, and the shared logic lives once in core (CLAUDE.md §2.8). Finally, it ships the shared golden vector file (`@bolusi/test-support/vectors/ed25519.json`: Ed25519 seeds→pubkeys, messages→signatures, SHA-256 vectors, full RFC 8785 appendix vectors — one file per testing-guide §2.2) and wires the vector suites into CI stages 5–7 (08 §5.6). No op-log append path, no UUIDv7, no on-device quick-crypto adapter — those are tasks 06 / 14 / device lane.

## Docs to read
- `05-operation-log.md` — §2.1–2.2 (signed-core field set; hash/signature definitions), §3 (canonical serialization rules incl. absent-vs-null, verbatim-storage rationale), §4 (canonical total order).
- `08-stack-and-repo.md` — §2.3 (`canonicalize`, `@noble/*`, zod pins + caveats), §3.2 rows for `@bolusi/core` and `@bolusi/test-support` (port shapes, vector-file ownership), §3.3–3.4 (import boundaries + platform-free locks), §5.6 stages 5–7 and 12 (where these suites run).
- `decisions/2026-07-14-v0-stack-pins.md` — D8 (crypto providers, argon2id params, RFC 8032 interop contract).
- `security-guide.md` — op-log table, **SEC-OPLOG-06** row only.
- `testing-guide.md` — T-5 (golden-file rule), §2.1 rows L1 + L7, §2.2 (crypto interop suite: fixture format and both-direction contract).

## Skills
- `superpowers:test-driven-development` — always; vectors first, then implementation.
- `superpowers:verification-before-completion` — run the actual CI commands, read their output.
- `context7-mcp` — verify current API of `canonicalize@3`, `@noble/curves@2.2.0`, `@noble/hashes@2.2.0` before use (ESM-only, `.js`-extension subpath imports — 08 §2.3).
- Worktree isolation per CLAUDE.md §2.3 — first step: `git branch --show-current`; STOP if on main.

## Files / modules touched
- `packages/core/src/crypto/port.ts` — `CryptoPort` interface (KDF param names `memoryCost`/`timeCost`/`parallelism`, mirroring quick-crypto/Node per 08 §2.2). **`@bolusi/core` is contended (CLAUDE.md §4)** — serialize with any in-flight core/schemas task.
- `packages/core/src/crypto/jcs.ts` — guarded JCS wrapper (the only importer of `canonicalize`).
- `packages/core/src/crypto/order.ts` — canonical-order comparator.
- `packages/core/src/crypto/signed-core.ts` — `hashSignedCore` / `signOp` / `verifyOp` helpers, typed against the task-02 envelope schema from `@bolusi/schemas`.
- `packages/core/test/jcs-vectors/` — Node vector suite (exact path named by CI stage 5, 08 §5.6).
- `packages/core/test/crypto/*.test.ts` — unit + property tests.
- `packages/test-support/src/crypto/noble-port.ts` — noble `CryptoPort` (test-only; never imported by shipping source, 08 §3.3 rule 6).
- `packages/test-support/vectors/ed25519.json` — the single shared golden vector file (testing-guide §2.2). Golden files are wire-format vectors only (T-5); adding a vector later requires a spec-doc change first.
- Hermes vector-runner entry (standalone bundle: `canonicalize` + core serialization + vector data only) — extend the stage-6 mechanism task 01 bootstrapped (08 §5.6); do not invent a second one.
- CI workflow: fill stage 5/6/7 job bodies if task 01 left them as placeholders. No other packages touched.

## Acceptance
- `pnpm lint`, `pnpm typecheck`, `pnpm test` green; CI stages 5 (JCS vectors, Node), 6 (JCS + crypto vectors, Hermes VM), 7 (Ed25519 interop) exist and pass on the PR.
- **RFC 8785 vectors:** every appendix vector in `vectors/ed25519.json` passes byte-exact through the core JCS wrapper on Node AND Hermes (number→string serialization is the point — Hermes proven, not assumed).
- **JCS guard tests:** input containing an `undefined` value (top-level and nested), `NaN`, `+Infinity`, `-Infinity`, or a `BigInt` → typed error, never a silently-dropped key or coerced value (upholds 05 §3 absent-vs-null: explicit `null` passes, omission-by-`undefined` is rejected).
- **Hash/sign helpers:** `hashSignedCore` hashes exactly the §2.1 field set (test: bookkeeping/`hash`/`signature` keys in input are rejected by the schema type / excluded, and a known envelope fixture produces the recorded digest); `signOp` signs the raw 32-byte digest, not its hex string (test asserts input bytes to the port); round-trip `signOp`→`verifyOp` true; flipping any single byte of payload-derived hash, signature, or pubkey → `verifyOp` false.
- **Cross-impl fixture:** noble port reproduces every `ed25519.json` vector — seed→pubkey and message→signature byte-equal (Ed25519 is deterministic) — and verifies the fixture signatures recorded as quick-crypto expectations (RFC 8032 interop contract, testing-guide §2.2). The fixture format carries both directions; the quick-crypto leg itself runs in the device lane (stage 12), not this task.
- **KDF:** noble argon2id reproduces a pinned RFC 9106 test vector; port accepts D8 default params (m=32768 KiB / t=3 / p=1, 32-byte output). Param-floor *enforcement* is task 14's SEC-AUTH-01, not here.
- **Comparator property tests** (seeded, deterministic): total order on random op triples (antisymmetry, transitivity, totality — ties broken by `deviceId` then `seq`); permutation-invariance (any shuffle of a generated op set sorts to the identical sequence, incl. equal-timestamp and equal-timestamp+deviceId collisions).
- **SEC-OPLOG-06** — id verbatim in the test title: full RFC 8785 appendix vectors + random-envelope property test (fixed-seed generated envelopes → JCS byte digest identical between the Node run and the Hermes run) executed in CI on both runtimes. This is the only SEC-* id owned by this task (SEC-OPLOG-01/04/05/09 are tasks 07/15 — they consume these primitives). No CHAOS-* scenario belongs to this surface (CHAOS-05/12 exercise it downstream via tasks 07/15/26).
- **Lint/CI gates:** boundary lint stays green — no `@noble/*`, `node:*`, or platform imports inside `packages/core` (08 §3.4 three locks); `@bolusi/test-support` appears only in test files and CI entry points; the only golden files added are the wire-format vectors (T-5).

## Review-round findings (in-review)

- **JCS guard now rejects the whole non-JSON class, not the types someone listed.** The
  first guard blacklisted exotic types by name; enumerating the class exposed that `Set`,
  `Map`, boxed primitives, and `Date` were accepted and their contents vanished from the
  preimage (`new Set([1,2])` and `new Set([9])` both → `{}`, a collision across distinct
  data). Replaced with a plain-object whitelist (prototype check). A second door — an
  **own `toJSON` function**, non-enumerable — bypassed even that: `Object.keys` cannot see
  a non-enumerable key but canonicalize honours `toJSON` regardless, so the guard validated
  one value while the preimage was another. Closed with a descriptor probe keyed on
  `typeof value === 'function'` (matching canonicalize's own trigger): rejects own/inherited
  `toJSON` **functions** at any enumerability, accepts a `toJSON` **data** key (legitimate
  wire JSON, `{"toJSON":"note"}`), and does not invoke an accessor `toJSON` (the getter
  TOCTOU is wire-unreachable and deliberately left as accept). Tests enumerate the class:
  placement × enumerability for `toJSON`, value × position for the exotic types.

- **Falsification is a re-runnable artifact, not a claim.** `pnpm falsify:crypto`
  (`scripts/falsify-guards.mjs`) breaks each crypto guard in source, rebuilds (`tsc -b`),
  runs the specific test that must catch it, asserts it goes red, and restores — 6/6 caught,
  every mutant BEHAVIOURAL (compiles clean, fails on behaviour). "Caught" requires exactly
  one outcome: the mutant COMPILED **and** the test then went RED. A non-compiling mutant is
  a `HOLE`, not a catch — it ran no test, so it proves nothing about what the test detects
  (this is the guard-of-the-guard: a falsification harness that scored green on a build error
  could itself pass with no behavioural failure). The harness's own assertions were falsified:
  a deliberately non-compiling mutant and a compiles-but-test-passes mutant were both reported
  `HOLE` (exit 1), then removed; gutting a guard's test also reports `HOLE`. Manual/CI-optional,
  not wired into the every-PR gate.

- **CI build-ordering trap (repo-wide, fixed at the script level).** Unit tests import
  `@bolusi/core` → `dist/`, but the CI `unit` job (stage 4) ran `pnpm test` with no build
  and does not depend on `typecheck`, so a cold run resolves nothing (this task is the first
  to add cross-package `@bolusi/core` dist imports in tests — it would have made stage 4 go
  red). Fixed by making the root vitest scripts build first: `test` and `test:ed25519-interop`
  are now `tsc -b && vitest run …`. This also fixes the local dist-vs-src staleness footgun
  (a `pnpm test` without a prior `tsc -b` used to test stale dist). `ci.yml` (the verifier
  boundary) was not modified. A broader convention — every vitest CI lane builds first, or
  `unit needs: [typecheck]` — is left for the coordinator as a cross-cutting call.
