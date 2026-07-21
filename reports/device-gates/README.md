# reports/device-gates/

Committed captures from the device-gate lanes (task 27). Each is the raw `BOLUSI_HARNESS_RESULT`
JSON a run emitted (testing-guide §2.6) — raw distributions per gate, not just pass/fail.

- **`android-emulator` lane (27a, CORRECTNESS):** the CI `android-emulator` job (`.github/workflows/
ci.yml`, scheduled/dispatch) runs `pnpm harness:device` and drops its capture here. **Every figure
  is labelled EMULATOR** (`target: "emulator"`) — a regression canary, never a device acceptance
  number (D12/D20 §1). No capture exists until that lane is first observed green; this directory is a
  placeholder until then (§2.1 — the lane does not run on the Linux dev host: no emulator/adb).
- **Physical-device lane (27b, PERFORMANCE):** P-1..P-5, SEC-AUTH-10, and the write-throughput figure
  — BLOCKED on a physical 2 GB device the owner has not provided. Its captures land here when 27b runs.

Filenames: `YYYY-MM-DD-<lane>.json` (e.g. `2026-07-21-emulator.json`).
