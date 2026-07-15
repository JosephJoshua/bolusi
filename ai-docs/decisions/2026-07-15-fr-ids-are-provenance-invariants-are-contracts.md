# Decision — 2026-07-15 — D15: FR ids are **provenance**; invariants (I-#) are **contracts**

> Trigger: a QA sweep asked "which FR is unowned?" and found the question **cannot be computed for ~90% of them** — not because the work is missing, but because FR→owner was never recorded anywhere. This resolves what FR citations in the specs actually mean.

## The finding (measured, not asserted)

| | count |
| --- | --- |
| distinct `FR-####` ids anywhere in `ai-docs/` | **578** |
| — cited in the **v0 specs** (non-PRD) | **63–68** ← the load-bearing set, by the specs' own framing |
| — PRD/ARCH only | ~510 |
| `NFR-` ids (a **separate namespace**, excluded) | 77 |
| **FR ids cited across all 51 task files** | **7** (FR-1023, 1034, 1036, 1045, 1118, 1138, 1146) |
| task files citing any FR | **13 of 51** |

Of the 68 spec-cited FRs: **16** appear in code, **2** in a task only, **50 in neither**.

**"Neither" means untraceable, not unbuilt.** Spot-checked and confirmed built, just never linked by id:

| requirement | actually enforced by |
| ----------- | -------------------- |
| I-3 "last admin cannot be deactivated → `409`" | `core/src/errors/domain-error.ts:24` + i18n; **task 13 owns it** |
| I-9 "loginIdentifier globally unique across tenants" | `0004_identity_directory.ts:15` — `login_identifier text UNIQUE` |
| FR-1010 / 1012 / 1015 (offline auth, switcher, idle lock) | task 14's `SessionManager`, `verifyPin` |

So the build is doing the work. The **ids** are not the mechanism.

## D15a — FR ids in specs are PROVENANCE, not a discharge contract

**Ruling: option (b).** The spec **text** is the requirement. An `FR-####` beside it records *where the requirement came from*, not a promise that some task will cite it back.

**Why:**
1. **`CLAUDE.md` §1 already says it**: PRDs are *"stale input, not ground truth"*. FR ids are PRD ids. A traceability contract anchored in stale input inverts the doc hierarchy.
2. **The specs supersede by construction.** They were authored *from* the PRDs (phase 2, `author-ai-docs`); the doc router routes every concern to a **spec**, never a PRD. `04 §5` is the contract, not the FR it descends from.
3. **The evidence says FR-tracing wouldn't have helped.** Every orphan found this session — the auth appliers (task 43), `restriction_violated` (44), the missing server projection-apply (49) — was found by **artifact-tracing** ("does an applier exist? can anything emit this?"). Notably **FR-1045 is one of the 7 cited ids**, and its orphan was still found by asking about appliers, not by following the id.
4. **Option (a) costs real archaeology** — 51 task files × per-FR investigation — for a mechanism whose value is unproven, while the mechanism that *did* work (enumerate artifacts, check each has an owner) is cheap and already running.

**But the sweep's core criticism stands and must be answered:** *"the specs cite FRs as requirements and the build ignores them. Today it is neither."* **63 spec citations imply a traceability that does not exist.** That's the defect — not the missing index.

**So: keep the citations, state what they are.** The specs must say plainly that `FR-####` is provenance (a pointer back to the PRD that motivated the rule), that the **spec text is the requirement**, and that tasks discharge **spec sections**, not FR ids. A reader must not be able to infer a contract that isn't there. (Filed as the doc half of task 52.)

## D15b — Invariants (I-#) ARE contracts, and 8 of 12 have no owner

**Different verdict, because they are a different thing.** `01-domain-model.md §10` is titled **"Invariants (testable, numbered)"** — that title is a promise. Invariants are *spec-native* (not PRD ids), universally quantified, and explicitly claimed testable.

**Of 13 numbered, 12 live** (I-12 is explicitly *"Retired"* — its absence is correct):
- **1** cited in code (I-6)
- **3** cited in a task (I-7 / I-8 / I-11)
- **8 in neither**

A universally-quantified claim in a section promising testability, with no owner and no test, is exactly this project's signature failure: **it fails by being absent, and absence is invisible to every test we have.**

**I-13 is the instructive case and it is now closed** — worth recording because it shows the shape. *"PIN hash material never appears in the operation log or any op payload"* is **universal**. Task 14 proves it **per-case** (`pin-flows.ts` emits exactly `{targetUserId, verifierRef}`; its tests assert verifier-free payloads). The **universal scan** over every pushed payload is SEC-AUTH-09's push-scan leg — which was orphaned until it was repointed to **task 28** earlier today. So I-13's enforcement now has an owner. **The other 8 have not been checked that way.**

**Ruling: the 12 live invariants each get an owner and a test.** That is task 52. Note the asymmetry that makes this cheap where the FR version was expensive: **12 items, spec-native, already promised testable** — versus 68 ids inherited from stale PRDs.

## The mechanism that already works, and should be reused

`SEC-META-01` does exactly this for SEC ids: parse the guide for ids, require a shipped test title per id, allowlist the pending ones with a named owner. It is **wrong in both directions today** (it accepts disclaimers and rejects range notation — task 31 fixes that), but the *shape* is right and it has caught real gaps. Invariants should ride the same rails once task 31 lands the declarative-ownership marker.

**Do not build the same rails for FRs.** That is the point of D15a.
