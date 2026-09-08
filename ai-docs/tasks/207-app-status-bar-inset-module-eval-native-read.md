# TASK 207 — App.tsx reads a native member at module top level, so importing App crashes any test whose RN double omits it

**Priority:** LOW-MEDIUM — not a user-facing bug; a testing-infrastructure fragility class (§2.11). It has already bitten once this cycle (the StatusBar module-eval import crash in the mobile unit suite), which is why it is filed rather than left implicit.
**Depends on:** —
**Blocks:** —
**SEC ids owned by THIS task:** none.
**Filed by:** the QA sweep of the 201-B emulator surface, 2026-09-08 (CLAUDE.md §2.7).

## The finding (citations verified at the producer, HEAD 17868eb)

`apps/mobile/App.tsx:941`:

```ts
const STATUS_BAR_INSET = Platform.OS === 'android' ? (RNStatusBar.currentHeight ?? 0) : 0;
```

This runs at MODULE EVALUATION time — the moment any file `import`s `App`. It reads `RNStatusBar.currentHeight`, a native member. Under the mobile vitest environment, `react-native` is aliased to `apps/mobile/test/doubles/react-native.tsx`; if that double does not export a `StatusBar` with a `currentHeight`, the top-level read throws and the ENTIRE importing test file fails to load — a whole-file crash at import, not a focused assertion failure. The reactive patch is already in place at `apps/mobile/test/doubles/react-native.tsx:51` (`export const StatusBar = { currentHeight: 24 };`), which is exactly the symptom: a test-double member exists only to keep a production module's top-level side effect from crashing on import.

Why this is a class, not a one-off: any module-top-level native read couples every test that imports the module to the double's fidelity, silently. A future top-level read of a different native member (or a double refactor that drops `StatusBar`) reintroduces the same whole-suite import crash with no local signal — the failure surfaces as "cannot import App", far from the cause (the `Falsify at the boundary` / stale-dist class this repo keeps re-learning).

## Fix direction (pick one; owner-facing on the guard choice)

Prefer removing the top-level side effect over widening the double:
1. **Lazy the read.** Compute the inset inside the component body / a `useMemo` / a small `getStatusBarInset()` called at render, not at module scope. Then importing `App` performs no native call, and a double missing `StatusBar` fails only the tests that actually render the status-bar path — where it belongs. (Same treatment for `NAV_BAR_INSET` at `App.tsx:964` if it ever grows a native read; today it is a constant, so it is safe.)
2. **If the constant must stay module-scope** (it is read by `StyleSheet.create` at module load), then add a GUARD that makes the coupling load-bearing by construction (§2.11): a tiny test that imports `App` under a double with `StatusBar` deleted and asserts a clear, attributable error — so the fragility is a fact a test asserts, not a silence. This is the weaker option (it documents the coupling instead of removing it).

## Acceptance
- Importing `App` performs no native member read at module-eval time (option 1), OR a guard exists that reds with an attributable message when the double omits `StatusBar` (option 2).
- The mobile unit suite (`cd apps/mobile && pnpm test` = `tsc -b ../.. && vitest run`) stays green.
- `pnpm lint` / `pnpm typecheck` green.

## Falsify (§2.11)
- Option 1: temporarily delete `StatusBar` from `apps/mobile/test/doubles/react-native.tsx` and run the suite — it must STAY green (no test imports a native read at module scope). Restore.
- Option 2: with the guard in place, delete `StatusBar` from the double — ONLY the guard reds, with its attributable message, and it names the cause. Restore → green. Report which option shipped and the observed falsification.
