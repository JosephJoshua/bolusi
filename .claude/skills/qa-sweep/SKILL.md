---
name: qa-sweep
description: Use for comprehensive AND continuous QA. Runs a multi-modal search strategy (state-map → spec-verify → explore/exploit → chaos personas → coverage) with parallel QA agents, and feeds every confirmed finding back into ai-docs/tasks/. Runs continuously as features land, not only at the end.
---

# QA Sweep

QA is continuous + comprehensive, and it feeds `tasks/`.

## Search strategy (multi-modal — parallel QA agents, each blind to the others)

1. **State-map** — enumerate every page/flow state (loading / empty / error / unauthorized / edge) and check each.
2. **Spec-verify** — behavior vs the owning ai-doc; flag drift.
3. **Explore / exploit** — adversarial: auth bypass, scope leaks, idempotency, race between two concurrent actors, injection, signed-URL tamper.
4. **Chaos personas** — frozen / expired / multi-tenant / concurrent users; the deny-list bypass zoo.
5. **Coverage** — what's untested? Which flows have no test at all?

## Rules

- **Parallel-QA fixture isolation** — concurrent QA agents namespace their fixtures or sequence exclusive windows; never a broad-sweep cleanup that clobbers a peer's live fixtures.
- **Prove illegitimacy before calling it a leak** — PII-in-a-response is not a leak; show an illegitimate relationship AND scope exceeded, via a zero-relationship control.
- **Verify ground truth** — reproduce each finding against the tool's own output.
- **Feedback loop** — every confirmed finding → a task file + an `_index.md` row (CLAUDE.md §2.7). Keep a cumulative **attack-ledger** so you don't re-test what's already covered.

## Done when

The strategy ran across the changed surface, findings are filed as tasks, and the attack-ledger is updated. Re-run continuously as features land.
