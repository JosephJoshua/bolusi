# Review model — v0 (owner decision, 2026-07-15)

Midpoint between task 01's 27-agent wave (~1.6M tokens, ultracode on) and the single-reviewer model
used for tasks 02–05. Both worked; the wave was disproportionate, the single reviewer was thin on
breadth for high-stakes surfaces.

## Shape: 3 blind dimension reviewers → adversarial verification of findings → orchestrator verdict

1. **Three independent reviewers**, blind to each other, one lens each:
   - **spec-conformance + correctness** — field-by-field against the owning doc; would this accept
     what it must reject?
   - **security + adversarial** — try to construct the exploit/leak/bypass. Ships with the surface
     per CLAUDE.md §2.5.
   - **tests + guard integrity** — testing-guide T-1..T-14b. Is every guard falsified? Does any
     guard check nothing? Is the oracle stricter than the code under test?
2. **Adversarial verification** of every finding: a separate agent tries to REFUTE it, defaulting to
   "not real" unless it reproduces concrete evidence itself. Kills plausible-but-wrong findings
   before they cost an implementer a round. (This is the review-wave skill's own rule; task 01's
   wave killed 1 of 22 that way — worth keeping, cheap at this scale.)
3. Orchestrator verifies gates independently, rules on findings, dispatches.

Budget: ~6-9 agents per review vs 27. Use the Workflow tool (the review-wave skill sanctions it).

## Non-negotiable reviewer instructions (learned the hard way, all five documented in CLAUDE.md §2.11)

- **Drive the mechanism; do not reason about it.** Every claim mechanically testable in under a
  minute gets tested. A grep for the shapes you _expect_ to be dangerous only finds dangers you
  already imagined — that is how the `op_a_id` camelCase bug survived a reviewer's analysis.
- **Probe THEIR code, not a lookalike.** The orchestrator has now made this error three times:
  measured `Buffer.from`'s leniency instead of the branch's base64 validator; probed with
  `parseTableMap`'s regex instead of `parseInterfaces`'s; grabbed `JcsInputError` (an error class)
  instead of `canonicalizeJcs`. Import the branch's built artifact and call it.
- **Assert the fixture before believing an absence** (T-14b). `0 rows` / `UPDATE 0` / "no findings"
  reads identically to success and to a wiped database. A shared docker daemon already produced
  exactly this fake green during the task 05 review.
- **Separate "incorrect by its own stated job" from "exploitable."** State both, conflate neither.
  An overclaimed vuln costs credibility; a missed one costs the product.
- **Default to MERGE** unless you have concrete reproduced evidence. Do not invent ideal-world
  requirements the specs don't state. Verdict: MERGE or FIX-FIRST.

## Depth by surface

| Surface                                                                | Depth                                               |
| ---------------------------------------------------------------------- | --------------------------------------------------- |
| 07 oplog-server, 13 auth-server, 16 sync-server, 17 conflict-detection | full 3+verify, plus a second security pass          |
| 06, 08, 09, 10, 11, 12, 15, 18, 19, 20, 21, 25, 26                     | full 3+verify                                       |
| 23 ui-kit, 24 app-shell                                                | 3+verify, one lens swapped to UX/design-conformance |
| 29, 30, 31 (small follow-ups)                                          | single reviewer + verify                            |
