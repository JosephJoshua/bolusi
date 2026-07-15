# TASK 30 — resolve 3 `ui-labels.md` keys that violate the 07-i18n §3.1 key grammar
**Status:** in-review
**Depends on:** 22

## Goal

Task 22 built the namespace-grammar gate exactly to `07-i18n.md` §3.1 (keys are `<namespace>.<screen>.<label>`, ≥3 segments) and it immediately rejected three keys that `ui-labels.md` ships:

| key | segments | needed by |
| --- | --- | --- |
| `auth.switchStore` | 2 | annotated v1 (store switcher deferred — roadmap) |
| `sync.pullToRefresh` | 2 | v0 — tasks 23/24 |
| `conflict.banner` | 2 | v0 — tasks 18/23/24 |

Two docs disagree and both claim authority: 07 §3.1 owns the grammar, ui-labels owns the catalog. Task 22 correctly refused to silently rename spec content mid-implementation (CLAUDE.md §4: spec changes are their own task) and parked all three in `SEED_DEFERRED_KEYS` with `TODO(spec-conflict)`. That parking is a stopgap: `sync.pullToRefresh` and `conflict.banner` are real v0 copy, and the tasks that need them are downstream.

Decide and land it: either rename the keys to satisfy the grammar (e.g. `sync.banner.pullToRefresh`, `conflict.banner.title`), or amend §3.1 to permit 2-segment keys for namespace-level singletons. **Recommendation: rename.** The grammar's value is that a key's namespace and screen are mechanically derivable; a 2-segment exception costs that for three strings. `auth.switchStore` is v1-deferred anyway (roadmap) — annotate or drop it rather than inventing a screen for it.

Whichever way it goes, one doc changes and the other follows, then `SEED_DEFERRED_KEYS` empties.

## Docs to read

- `07-i18n.md` — §3.1 (the key grammar and its reserved namespaces; the owning doc for the rule).
- `ui-labels.md` — the three key rows plus their surrounding sections (the owning doc for the catalog).
- `roadmap.md` — the store-switcher deferral, which decides `auth.switchStore`'s fate.

## Skills

- `superpowers:verification-before-completion` — the gate passing with an empty `SEED_DEFERRED_KEYS` is the evidence.
- Worktree isolation per CLAUDE.md §2.3 — first step: `git branch --show-current`; STOP if on `main`.

## Files / modules touched

- `ai-docs/ui-labels.md` and/or `ai-docs/07-i18n.md` §3.1 — one of them changes; the other is cross-referenced.
- `packages/i18n/` — `SEED_DEFERRED_KEYS` emptied; catalogs reseeded from the doc (the seed is mechanical — do not hand-edit catalog JSON).

## Acceptance

**Observable done-condition:** `pnpm i18n:check` passes with **`SEED_DEFERRED_KEYS` empty** — no parked keys, no `TODO(spec-conflict)` left in the package.

- The seed-parity gate passes: catalogs still derive mechanically from `ui-labels.md`. If keys were renamed, they were renamed **in the doc** and reseeded — never renamed in the catalog alone, which would break parity and re-introduce the drift the gate exists to prevent.
- Every reserved namespace in 07 §3.1 and every key in ui-labels satisfy one grammar; the docs do not contradict each other after this task.
- `auth.switchStore` has an explicit disposition recorded (renamed / dropped / annotated v1 per roadmap) — not left ambiguous.
- `pnpm test` and `pnpm lint` green.
- If §3.1 is amended instead of the keys renamed, the amendment states the exception precisely (what qualifies as a namespace-level singleton) so the gate can encode it — an exception the gate cannot express is not a decision.

## Outcome

Re-derived independently (ran `keyGrammarError` over all 127 parsed rows of `ui-labels.md` rather than
trusting the table above): **exactly three** violations, matching the handed-down list. All three are
2-segment keys; no other row violates §3.1.

**Ruling — fix the key, not the grammar, for all three.** The grammar is right and the keys were sloppy.
`<namespace>.<screen-or-area>.<label>` earns its keep by making a key's screen mechanically derivable, and
a "namespace-level singleton" exception would have destroyed that for three strings while being unfalsifiable
in the gate ("singleton" is a judgement, not a predicate). None of the three was expressing something the
grammar failed to anticipate — each had an obvious area that the author simply skipped:

| key | disposition | why |
| --- | ----------- | --- |
| `sync.pullToRefresh` | → `sync.action.pullToRefresh` | It is a user-initiated affordance, exactly like the neighbouring `sync.action.syncNow`. Deliberately not `sync.banner.*` — that area is reserved for the staleness level names (03-state-machines §8) |
| `conflict.banner` | → `conflict.list.banner` | A count banner that taps through to the conflict list — same shape as the existing `sync.rejected.banner`, so it is keyed to the list it opens |
| `auth.switchStore` | **dropped from the v0 seed**; copy parked in roadmap R22 | v1-deferred (FR-1034) and never rendered in v0. Its legal name depends on the screen the switcher lands on, which is not designed — inventing a screen segment now would be a guess that the R22 author has to unpick. `ui-labels.md` owns *v0* strings; a v1 string in the v0 seed is dead copy in the app bundle |

**The gate was green for the wrong reason (CLAUDE.md §2.11 — a sixth instance).** Parking a key in
`SEED_DEFERRED_KEYS` skipped it in `buildCatalogs`, so it never reached a catalog — and the grammar gate
read *catalogs*. The three keys §3.1 forbids were invisible to the gate that exists to flag them, and
`i18n:check` reported PASS. The parking did not defer the violation; it deleted the alarm. Worse, the same
blindness silently exempts every module-owned row (`notes.*`, §3.3) permanently: the gate's real denominator
was **113 of 127** keys. Fixed by linting §3.1 over the seed doc itself (`checkSeedKeyGrammar`), which sees
every row whatever its namespace and fails when it parses fewer rows than the seed carries (`SEED_MIN_ROWS`,
testing-guide T-14). Falsified both ways: the three old keys make it go red; a starved parse makes it go red.

**Also fixed (pre-existing, unrelated to the keys):** the extraction gate captured `core.errors.` as a key
from `t('core.errors.' + code)` — the derived-key call §4.2 *mandates* — so `pnpm i18n:check` failed on
`main` before this task. The regex now excludes concatenated call sites; those keys are covered by the
error-code gate, which enumerates them from the registry.
