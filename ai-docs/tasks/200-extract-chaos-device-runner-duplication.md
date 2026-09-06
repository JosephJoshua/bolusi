# TASK 200 — extract the four duplicated helper/scaffold families across the CHAOS-03/06/07 device-runner trio into one shared home each

**Depends on:** 198 (the trio landed there; extract after it merges so this rebases onto one settled copy-set)
**Blocks:** — (maintainability; no behavior change)
**SEC ids owned by THIS task:** none.
**Priority:** LOW — no current failing input; this is drift-prevention (§2.8 rule-of-three), filed by review-wave-198.
**Filed by:** review-wave of task 198 (2026-09-06). Four duplication findings were adversarially *confirmed factually real* (byte-identical copies / three-way near-siblings) and refuted only on "no concrete failing input **now**" — i.e. they do not block 198's merge, but per the review-wave skill a confirmed duplication becomes an extraction task naming every copy by path, and per CLAUDE.md §2.8 there must be one implementation, not per-file copies.

## The finding (four independent copy-sets, each already at the rule-of-three trigger)

The CHAOS-03/06/07 device-runner trio (~440-line near-siblings) hand-rolled four helper/scaffold families three times each instead of importing one shared version. The 2026-07-26 duplication audit already showed how this class bites: an "aware copy" that cites its twin in a comment is exactly how two copies silently *diverge* (`severity()` drifted between two Verdict enums that linked to each other). Every copy below is value-identical **today**; the risk is the next edit that touches one and misses the others.

### Copy-set A — chaos wire helpers `deviceSeed` / `notesOnly` / `dedupeById`
A canonical (but **unexported**, file-local) implementation already exists:
- `packages/test-support/src/chaos/convergence.ts:29` (`notesOnly`), `:34` (`deviceSeed`), `:168` (`dedupeById`)

re-declared byte-identically in each of:
- `packages/test-support/src/chaos/chaos03.ts`
- `packages/test-support/src/chaos/chaos06.ts`
- `packages/test-support/src/chaos/chaos07.ts`

**Extract to:** a new exported home (e.g. `packages/test-support/src/chaos/wire-helpers.ts`), imported by convergence.ts + chaos03/06/07.ts. (convergence.ts's copies are private `function`s — hoist + export, don't just re-point.)

### Copy-set B — device-env gate runners (`gateFromVerdict` + `runChaosNNGate`)
Three near-identical runners (finding: rule-of-three, §2.8):
- `apps/mobile/src/harness/part-c/chaos-03-device-env.ts`
- `apps/mobile/src/harness/part-c/chaos-06-device-env.ts`
- `apps/mobile/src/harness/part-c/chaos-07-device-env.ts`

**Extract to:** one parameterised `runChaosNetGate(scenarioId, runChaosNN)` (+ the shared `gateFromVerdict`) in a sibling module the three device-env files call. The verify pass proved the three runners are *structurally identical* (same two-try/catch shape) — the extraction is mechanical.

### Copy-set C — `driveRun` host-binding scaffolds
Three near-identical host-binding test scaffolds:
- `packages/harness/scenarios/device-runner-chaos-03.test.ts`
- `packages/harness/scenarios/device-runner-chaos-06.test.ts`
- `packages/harness/scenarios/device-runner-chaos-07.test.ts`

**Extract to:** one shared `driveRun` fixture helper under `packages/harness/scenarios/` (or `packages/test-support`) the three tests import.

### Copy-set D — `CountingTransport` (self-cited aware copy)
An extracted home already exists:
- `packages/test-support/src/chaos/transport.ts`

but a pre-existing Node twin was left in place, citing its sibling in a comment (the exact aware-copy pattern the audit flagged):
- `packages/harness/scenarios/chaos-03-days-offline.test.ts`

**Extract to:** delete the twin; import `CountingTransport` from `packages/test-support/src/chaos/transport.ts`. (Confirm the twin is byte-behaviour-identical first — both count `request.ops.length` on push, `response.ops.length` on pull.)

## Acceptance / FALSIFY (§2.11)

- **Behaviour-preserving:** the whole harness + mobile + test-support suite stays green before and after each copy-set's extraction; no scenario's outcome changes (these are test-only helpers — `@bolusi/harness` / `@bolusi/test-support` are `"private": true`, no production importer, so there is no runtime surface to regress).
- **Duplication actually gone (the load-bearing check):** after each extraction, `grep -rn "<symbol>"` across `packages` + `apps` shows exactly ONE definition and N imports — not N definitions. Falsify by re-adding a second definition and confirming a lint/knip or the grep-count assertion goes red, then revert.
- **No new coupling into production:** the shared home stays inside the test-only packages; `apps/mobile` must not gain a `@bolusi/harness` / `@bolusi/server` dependency (standing constraint).

## Sequencing

Own branch off `origin/main` **after 198 merges** (so it rebases onto the single settled copy-set, not a moving target). Four copy-sets → four atomic commits (one per set), each building + green, squashed before merge. Test-only packages are uncontended, so extract in-place here rather than filing further sub-tasks (§2.8). Then `review-wave`.
