# TASK 115 — `security-guide.md` §12's roll-up omits **SEC-DEV-08**, so the sweep's declared denominator is one id short

**Status:** done
**Priority:** MEDIUM — nothing is unprotected today (SEC-DEV-08 has a shipped, passing test), but the roll-up is the SEC inventory's **declared denominator**, and a denominator that disagrees with the doc it summarises is the drift the inventory exists to catch. It keeps `pnpm sec:sweep` red until fixed.
**Depends on:** —
**Blocks:** 28 (security-sweep — the inventory's roll-up assertion is RED on this)
**SEC ids owned by THIS task:** none.
**Invariants owned by THIS task:** none.
**Filed by:** task 28's SEC inventory, 2026-07-21 — a spec change, so it is its own task (CLAUDE.md §4: "do not edit spec content as a side effect of implementation").

## The finding (measured)

`scripts/sec-inventory.mjs` parses `ai-docs/security-guide.md` two ways and compares:

- the doc BODY defines **57** ids;
- §12's roll-up line — `OPLOG 01–09 · SYNC 01–10 · AUTH 01–11 · DEV 01–07 · MEDIA 01–06 · TENANT 01–05 · RT 01–05 · SECRET 01–02 · META 01` — declares **56**.

The difference is **SEC-DEV-08**, which task 58 shipped and which §6.2/§6.5 document at length ("**Shipped (task 58) as SEC-DEV-08**", plus a full row in §6.5's required-tests table). The roll-up says `DEV 01–07`. It was never updated when the id was minted.

```
sec-inventory: FAIL SEC-DEV-08 appears in security-guide.md but NOT in the §12 roll-up —
the roll-up is the sweep's declared denominator and must name every id
```

## Why it matters even though SEC-DEV-08 is green

The roll-up is the only place the guide states *how many* adversarial tests the suite is supposed to contain. Every count downstream quotes it (task 28's acceptance says "**56 ids**"). While it disagrees with the body, "the SEC suite is complete" is a claim checked against the wrong number — and the direction of the error is the dangerous one for the next edit: an id **deleted** from a surface table would restore agreement and read as correct.

## The fix

- Update §12's roll-up to `DEV 01–08` (and re-count the total in any prose that quotes it — task 28's file says 56; that number becomes 57).
- Nothing else changes: SEC-DEV-08's row, scope, and Android-only framing (§6.5, §6.6, task 80's ruling) are correct and must not be touched.
- **Falsify:** after the edit, drop any single id from a surface table and watch `pnpm sec:inventory` name it as "declared by the §12 roll-up but appears nowhere else"; restore, watch it go green. Report the verbatim red.

## Docs to read

- `security-guide.md` §12 (the roll-up), §6.5 (SEC-DEV-08's row), §2.1.4 (the SEC-META-01 contract the roll-up backs).
- `ai-docs/tasks/28-security-sweep.md` (the "56 ids" acceptance line that must move to 57).

## Acceptance

- `node scripts/sec-inventory.mjs` reports the parsed set and the roll-up set as EQUAL, with no roll-up failure in its output.
- Task 28's acceptance text quotes the corrected count.
- Read the tool's own output, not a summary (§2.1).
