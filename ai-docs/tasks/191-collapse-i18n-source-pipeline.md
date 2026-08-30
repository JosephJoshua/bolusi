# TASK 191 — make one i18n representation canonical; retire the format-conversion gates

**Depends on:** —
**Blocks:** —
**SEC ids owned by THIS task:** none.

**Filed by:** the 2026-08-30 complexity/over-engineering audit (owner-approved cut-list, Tier 2 #4).

## Goal

i18n copy exists in **three representations**: markdown (`ai-docs/ui-labels.md`) → parsed to JSON catalogs → codegen'd to TS. ~10 gates across `packages/i18n/scripts/{check.mjs (283), gates.mjs (413), seed.mjs (125), gen.mjs (201), error-code-registry.mjs (92)}` police this. A subset of those gates exists **only to guard the format conversions** — and the incident documented inline at `gates.mjs:141-150` (the `SEED_DEFERRED_KEYS` blindness, where parked keys stayed out of catalogs so the gate's denominator was 113 of 127) is a **symptom of the doc being a separate source**. Make **one representation canonical** (JSON or TS catalogs — implementer's brainstorm) so the conversion gates vanish by construction. Target **10 → ~6 gates**.

## Must preserve (do NOT cut — these guard REAL properties, not conversions)

- `checkKeyGrammar` (key-namespace grammar)
- `checkParity` (id ↔ en completeness — both locales ship)
- `checkIcuSubset` (ICU message safety)
- `checkErrorCodeCoverage` (every error code has a label)
- `checkCollision`

These survive any canonical format and stay.

## Cut (conversion-only ceremony)

- **Seed parity** (catalog-reproduces-the-doc) and `checkSeedKeyGrammar` / `checkSeedBlankValues` (they lint the **doc as a second source**). Remove the doc-as-source and these are moot — the `gates.mjs:141-150` blindness class disappears at the root, not with another guard on top.
- `error-code-registry.mjs` **only if** it is a conversion artifact and not the home of `checkErrorCodeCoverage`'s real data.

## Must preserve — the two runtimes

Both consumers must still resolve keys after the collapse: **mobile** (react-i18next) and the **server push-composition** runtime. The canonical format must feed both.

## Docs to read

- `ai-docs/07-i18n.md` (§1, §7.1.3, §7.3 gates); `ai-docs/ui-labels.md`; `ai-docs/testing-guide.md` T-14.
- **Load i18n/frontend context and brainstorm the canonical-format choice before cutting** — this moves the i18n source of truth; it is the riskiest Tier-2 item.

## Files / modules touched

- `packages/i18n/scripts/{check,gates,seed,gen,error-code-registry}.mjs`, the i18n catalogs, `ai-docs/ui-labels.md` (may become generated or cease to be the source), `ai-docs/07-i18n.md` (spec edit for the new source of truth — this task owns it).

## Acceptance

- One canonical representation; the format-conversion gates are gone; ~6 property gates remain.
- Both runtimes render a sample key end-to-end after the change.

### Falsification (§2.11)

1. **Each preserved property gate still bites** — drop an `en` key → `checkParity` reds; write an illegal key → `checkKeyGrammar` reds; break an ICU message → `checkIcuSubset` reds; add an error code with no label → `checkErrorCodeCoverage` reds.
2. **Prove the removed seed-* gates are vacuous post-collapse** — there is no doc source for a catalog to drift from; demonstrate the removed gates protected a conversion that no longer occurs (the `gates.mjs:141-150` class is unconstructable now).
3. **Both runtimes** — mobile and server push composition each resolve a known key against the canonical catalog.
