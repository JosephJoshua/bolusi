# TASK 152 — task 127's residuals: a false provenance claim on the v1 schema, and an import guard whose checked set is not the runtime's reachable set

**Status:** in-review
**Priority:** MEDIUM (item 2 — the guard hole) / MEDIUM (item 1 — the false provenance comment). **Corrected 2026-07-22:** this file originally labelled item 2 LOW. That was wrong and the implementer flagged the inconsistency rather than silently picking a reading. Item 2's falsification showed an unchecked, non-strict schema becoming the PRODUCTION validator for a v1 push (`deps.ts:161` calls `payloadSchemaFor` and validates against whatever it returns), so it is at least as severe as item 1 — low *reachability*, not low *severity*. — neither is a fail-open path in any realistic construction; both were falsified end-to-end by the reviewer and both are the §2.11 class the module contract exists to prevent.
**Depends on:** 127 (merged 2026-07-22)
**Blocks:** —
**SEC ids owned by THIS task:** none.
**Filed by:** the task-127 reviewer, 2026-07-22, on the approving pass.

## 1. MEDIUM — the v1 schema's provenance claim is false, and it cites T-16 while being wrong

`packages/modules/src/notes/operations.ts:68-73` says the v1 schema is *"NOT reconstructed from the applier's TypeScript interface… this is the schema **this repo actually shipped at v1**, recovered from the module's own migration history (`git show 5f1948d:…`)… **the history is the producer** (T-16: trace to the producer)."*

The reviewer traced to that producer. At `5f1948d`, `constants.ts` reads `NOTE_CREATED_SCHEMA_VERSION = 2` and the operations file contains the **v2** schema (`{title, body, mediaId: z.string().nullable()}`). **The notes module was introduced already at v2; this repo has never had a v1 registry schema.**

`noteCreatedPayloadV1` therefore *is* a reconstruction (v2 minus `mediaId`), cross-checked against `NoteCreatedV1Payload`. That is fine and almost certainly correct — **runtime risk is none**, and no v1 op can exist anyway (see below). The defect is the sentence: it asserts a producer that does not exist, in the exact register CLAUDE.md §2.11 warns "supplies the confidence that stops you checking", **while citing T-16**.

Suggested reword: *"reconstructed as v2-minus-`mediaId` from `5f1948d`, where the module was introduced already at v2 — this repo never shipped a v1 registry schema — and cross-checked against `NoteCreatedV1Payload`."*

## 2. LOW — the import guard checks own keys; the runtime reads through the prototype

`packages/core/src/module/define-module.ts:394-427`. The range / `parse()` / `.strict()` checks iterate `Object.entries(retained)` — **own** enumerable keys. The completeness loop (`:420`) and `payloadSchemaFor` (`:152`) both use `retained[version]` — **prototype-inclusive** property access. So a retained entry supplied on the prototype is invisible to the strictness check, satisfies completeness, and is what the runtime returns.

**Falsified end-to-end on the real module** with `payloadByVersion: Object.assign(Object.create({ 1: z.object({title,body}) /* NOT .strict() */ }), { 2: noteCreatedPayloadV2 })`:
```
TSC_EXIT=0
IMPORT: OK (import guard did NOT fire)
× HTTP-A(iii) — v1 carrying an unknown key → 200 rejected/SCHEMA_INVALID
  → AssertionError: Received { "status": "accepted" }
```
The unchecked, non-strict schema reached production validation and accepted an unknown-key op.

**Reachability is low** — it needs a module author to build `payloadByVersion` from something other than an object literal — which is why this is LOW. But the shape is §2.11's "a guard must assert its own coverage", and it closes by construction in one loop:
```ts
for (let version = 1; version < schemaVersion; version += 1) {
  const schema = retained[version];        // the SAME access payloadSchemaFor uses
  if (schema === undefined) { missing.push(version); continue; }
  // parse() + isStrictSchema checks HERE
}
// then, separately, reject any own key outside 1..schemaVersion-1
```

## 3. INFO — lexicographic version compare
`packages/modules/test/manifest.test.ts:141` compares `Object.keys(...).sort()` against `['1','2']` — a string sort that breaks at ≥10 retained versions. Cosmetic today.

## FALSIFY (§2.11 — REPORT it)
For item 2, reproduce the prototype probe above and lead with the `accepted`. After the fix the same construction must throw at import time. **Positive control:** the ordinary object-literal form still passes, and a legitimate v1/v2 payload is still accepted end-to-end — the guard must not become "reject any retained schema".

## Context worth preserving (established by the reviewer, so nobody re-derives it)
- **A client cannot choose a schema version at all.** `packages/core/src/runtime/ctx.ts:117-124` — `ctx.op()` deliberately has no `schemaVersion` parameter ("this absence is the contract"); `:309` stamps the registry's CURRENT version. Every real device emits v3 and only v3; a v1/v2 push can only come from a hand-crafted envelope.
- **Tightening v2's `mediaId` to `zUuidV7` cannot reject anything the old server ever durably accepted** — in the window when current was 2, a non-uuid `mediaId` was accepted at push and then threw `invalid input syntax for type uuid` inside the push transaction, so it could never become a logged op.
