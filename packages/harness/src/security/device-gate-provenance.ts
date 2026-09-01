// SEC-AUTH-09 discharge gate — the PROVENANCE + FRESHNESS logic behind reading an ON-DEVICE gate
// artifact as release-gate proof (task 28; CLAUDE.md §2.11 "a real number with fictional provenance").
//
// ── THE PROBLEM THIS FILE EXISTS TO STOP ────────────────────────────────────────────────────────
// SEC-AUTH-09 leg 1 ("the PIN-verifier salt/hash/params are ciphertext at rest") can only be settled
// on real hardware (an assembled APK + the emulator), so the per-push release gate (`pnpm sec:sweep`)
// cannot run it. Its evidence is therefore the COMMITTED artifact `reports/device-gates/*.json`, emitted
// by the emulator lane (task 27a/178). A gate that reads that JSON and asserts `SEC-AUTH-09-leg1 == pass`
// WITHOUT checking the artifact's provenance is exactly the failure §2.11 names: a stale artifact from an
// old passing run would keep the gate GREEN after the column cipher regressed. The developer who edits
// the seal and forgets to re-run the device lane must be caught here, not by review alone.
//
// ── THE MECHANISM, AND WHY GIT AND NOT A SELF-DECLARED FIELD ─────────────────────────────────────
// The `bolusi-harness-result/1` schema records NO build commit (its `runId` is a timestamp, not a sha),
// so the artifact cannot self-report the code it exercised. The one tamper-evident binding available is
// WHERE THE ARTIFACT SITS IN GIT HISTORY: the commit that INTRODUCED the pinned artifact file. That
// commit's tree is the code state whose emulator run produced the JSON. So the gate:
//
//   1. anchors on the artifact's INTRODUCING commit (`git log --diff-filter=A -- <artifact>`),
//   2. requires that commit to have introduced NO at-rest surface change (the artifact is committed
//      CLEANLY, separate from code — else its freshness cannot be trusted),
//   3. diffs the AT-REST SURFACE (the column cipher, `writeVerifier`, the on-device gate body, the seed,
//      the probe) between that commit and the WORKING TREE — ANY change ⇒ STALE ⇒ RED, demanding a
//      fresh emulator run,
//   4. requires the working-tree artifact to be BYTE-IDENTICAL to its committed form (a hand-edit that
//      flips `skipped`/`fail` → `pass` is a change since the provenance commit ⇒ RED),
//   5. reads the verdict from the COMMITTED bytes (provenance), not merely the on-disk status string,
//   6. and asserts each declared surface path actually EXISTS at the anchor and on disk (T-14: a surface
//      entry pointing at a moved file would make the diff vacuously empty — a guard that checks nothing).
//
// KNOWN RESIDUAL (surfaced to the owner as a freshness-policy question, not silently accepted): because
// the artifact carries no build-sha, an adversary who deliberately COMMITS a doctored artifact at a
// later commit can move the *last-touching* commit forward. This gate anchors on the INTRODUCING commit
// (immutable for a given file path) precisely to blunt that: a later in-place edit does not move the
// anchor and is caught by the byte-integrity check (4). A fully fabricated NEW artifact file committed by
// a malicious insider is a higher threat class that no git-only scheme closes — the durable fix is for
// the emulator producer to record the build sha INSIDE the artifact (an immutable binding the gate would
// then prefer). See the task-28 report + `sec-pending-allowlist.json` $comment.
//
// Pure by construction: every git/fs fact is gathered by the caller and passed in, so each RED path is
// unit-testable against synthetic facts (T-11 — a guard nobody has watched go red is not believed).

/** The pinned schema id the on-device harness stamps every result with (harness-device.mjs). */
export const HARNESS_RESULT_SCHEMA = 'bolusi-harness-result/1';

/** The on-device gate id carrying SEC-AUTH-09 leg 1 (the PIN-verifier-material-at-rest leg). */
export const VERIFIER_AT_REST_GATE_ID = 'SEC-AUTH-09-leg1';

/** The pinned artifact whose committed emulator run is leg 1's evidence (task 160 reland, CI run 33530599150). */
export const DEVICE_GATE_ARTIFACT = 'reports/device-gates/2026-09-01-emulator.json';

/**
 * The AT-REST SURFACE — the files whose change invalidates the leg-1 claim "the PIN-verifier bytes are
 * ciphertext at rest". Curated to the code that DETERMINES the seal, not unrelated dispatch, so the gate
 * reds on a real regression and not on unrelated harness churn. Traced to producers (T-16):
 *
 *   • the column cipher (seal format, keyed marker, AEAD contract, write-side plugin, registry seam)
 *   • the connection — the seal's ON/OFF SWITCH: `openClientDb` REGISTERS the cipher and installs the
 *     encryption plugin, and the leg-1 seed opens its sealed DB through it. Omitting it was a real
 *     stale-blind hole (rev-28-sec09): removing `registerColumnCipher` writes leg-1's verifier columns
 *     in cleartext on device, yet the gate stayed green because this file was not watched.
 *   • `writeVerifier` — the production writer that seals salt/hash/params
 *   • the on-device gate body — `runVerifierAtRestGate` (reads the stored cells, asserts the marker)
 *   • the seed — drives `writeVerifier` under the real cipher on device
 *   • the DEVICE SEAL BINDING — the ONE native-binding site that injects the real AES-256-GCM primitive
 *     and the op-sqlite driver into the seed that PRODUCES the artifact (`deviceAtRestSeams`), plus the
 *     `deviceColumnAead` primitive itself. A no-op/misconfigured AEAD or a wrong driver binding un-seals
 *     the verifier bytes invisibly and would keep the artifact falsely green — so both are watched.
 *   • the probe — reads the physically-stored cells / the sealed-prefix the gate compares against
 *
 * If any is renamed, the freshness check would silently diff nothing for it — so the gate ALSO asserts
 * every path here still exists (T-14). Extend this list when a new file joins the seal path.
 */
export const AT_REST_SURFACE: readonly string[] = Object.freeze([
  // the column cipher
  'packages/db-client/src/crypto/column-cipher.ts',
  'packages/db-client/src/crypto/aead.ts',
  'packages/db-client/src/crypto/column-encryption-plugin.ts',
  'packages/core/src/crypto/column-cipher.ts',
  // the connection — registers the cipher + installs the plugin (the seal on/off switch); the seed
  // opens its sealed DB via openClientDb, so this is on leg-1's attested seal path.
  'packages/db-client/src/connection.ts',
  // writeVerifier
  'packages/core/src/auth/repo.ts',
  // the on-device at-rest gate body
  'apps/mobile/src/harness/part-c/at-rest-device-ctx.ts',
  // the seed that drives writeVerifier under the real cipher
  'apps/mobile/src/harness/part-c/at-rest-device-env.ts',
  // the device seal binding: injects the real AEAD + op-sqlite driver into the artifact-producing seed…
  'apps/mobile/src/harness/run-and-emit.ts',
  // …and the AES-256-GCM primitive itself (deviceColumnAead) that column-cipher.ts calls to seal.
  'apps/mobile/src/ports/aead.ts',
  // the at-rest probe (reads the stored cells + the sealed prefix)
  'packages/test-support/src/driver-conformance/at-rest.ts',
]);

/**
 * A producer-shaped run id — `run-<ISO with :/. → ->-<hex>` (harness-device.mjs `runCli`). Asserting
 * the SHAPE is a weak-but-real "this came off the real driver" signal: a hand-typed `"pass"` run id does
 * not match. It is NOT a substitute for the git provenance below — that is the load-bearing binding.
 */
export const RUN_ID_PATTERN = /^run-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{4,8}$/;

export type GateStatus = 'pass' | 'fail' | 'skipped';

export interface HarnessGateLike {
  readonly id?: unknown;
  readonly status?: unknown;
  readonly detail?: unknown;
}

export interface HarnessResultLike {
  readonly schema?: unknown;
  readonly runId?: unknown;
  readonly variant?: unknown;
  readonly target?: unknown;
  readonly gates?: unknown;
}

/** The git/fs facts the verdict needs — gathered by the caller so the verdict stays pure (T-11). */
export interface DeviceGateFacts {
  /** The pinned artifact path being discharged. */
  readonly artifactPath: string;
  /** The declared at-rest surface (defaults to {@link AT_REST_SURFACE}). */
  readonly surface: readonly string[];
  /** The commit that INTRODUCED the artifact file, or `null` when it is not in git history. */
  readonly anchorCommit: string | null;
  /** Whether {@link anchorCommit} has a parent (a root-commit artifact cannot be freshness-checked). */
  readonly anchorHasParent: boolean;
  /** The artifact's bytes AT the anchor commit (`git show <anchor>:<path>`), or `null` if unreadable. */
  readonly committedArtifactText: string | null;
  /** The artifact's bytes in the WORKING TREE, or `null` when it is absent on disk. */
  readonly worktreeArtifactText: string | null;
  /** Surface paths that CHANGED between the anchor commit and the working tree (STALE if non-empty). */
  readonly surfaceChangedSinceAnchor: readonly string[];
  /** Surface paths the ANCHOR COMMIT ITSELF modified vs its parent (must be empty — clean commit). */
  readonly surfaceChangedInAnchorCommit: readonly string[];
  /** Surface paths missing at the anchor OR on disk (T-14: a surface entry checking nothing). */
  readonly missingSurfacePaths: readonly string[];
}

export interface DischargeVerdict {
  readonly ok: boolean;
  readonly failures: string[];
  /** The leg-1 gate's status as read from the COMMITTED artifact, or a reason it could not be read. */
  readonly leg1: GateStatus | 'absent' | 'unreadable';
  readonly anchorCommit: string | null;
}

function findGate(result: HarnessResultLike, id: string): HarnessGateLike | undefined {
  const gates = Array.isArray(result.gates) ? (result.gates as HarnessGateLike[]) : [];
  return gates.find((gate) => gate.id === id);
}

/**
 * The whole discharge verdict for one on-device gate artifact. Reads leg 1 from the COMMITTED bytes and
 * fails RED (never silently green) on: no git provenance, an unreadable/absent/hand-edited artifact, a
 * malformed run, a leg-1 gate that is absent or not `pass`, a surface path that checks nothing, an
 * artifact commit that smuggled a code change, or ANY at-rest surface change since the anchor (STALE).
 */
export function assessDeviceGateDischarge(
  facts: DeviceGateFacts,
  legGateId: string = VERIFIER_AT_REST_GATE_ID,
): DischargeVerdict {
  const failures: string[] = [];
  let leg1: DischargeVerdict['leg1'] = 'unreadable';

  // ── denominator guard: the surface must never be empty (T-14) ─────────────────────────────────
  if (facts.surface.length === 0) {
    failures.push(
      'the at-rest surface is EMPTY — the freshness check would compare nothing and pass vacuously',
    );
  }

  // ── git provenance must exist ─────────────────────────────────────────────────────────────────
  if (facts.anchorCommit === null) {
    failures.push(
      `${facts.artifactPath} is not in git history — its provenance cannot be established, so the ` +
        `emulator result cannot be trusted as release-gate proof (§2.11)`,
    );
  } else if (!facts.anchorHasParent) {
    failures.push(
      `${facts.artifactPath}'s introducing commit ${facts.anchorCommit} has no parent — the at-rest ` +
        `surface freshness cannot be diffed against it`,
    );
  }

  // ── the artifact must be readable at its provenance commit AND on disk, and byte-identical ─────
  if (facts.committedArtifactText === null) {
    failures.push(
      `could not read ${facts.artifactPath} at its provenance commit — no committed evidence to trust`,
    );
  }
  if (facts.worktreeArtifactText === null) {
    failures.push(
      `${facts.artifactPath} is absent on disk — there is no emulator evidence to read`,
    );
  }
  if (
    facts.committedArtifactText !== null &&
    facts.worktreeArtifactText !== null &&
    facts.committedArtifactText !== facts.worktreeArtifactText
  ) {
    failures.push(
      `${facts.artifactPath} has been MODIFIED since its provenance commit (working tree ≠ committed ` +
        `bytes) — a hand-edit is not evidence; re-run the emulator lane, do not edit the JSON`,
    );
  }

  // ── read leg 1 from the COMMITTED bytes (provenance), not the mutable on-disk status ───────────
  if (facts.committedArtifactText !== null) {
    let result: HarnessResultLike | null = null;
    try {
      result = JSON.parse(facts.committedArtifactText) as HarnessResultLike;
    } catch (error) {
      failures.push(
        `${facts.artifactPath} at its provenance commit is not parseable JSON (${
          (error as Error).message
        }) — a broken artifact is not an empty pass (§2.1)`,
      );
    }
    if (result !== null) {
      if (result.schema !== HARNESS_RESULT_SCHEMA) {
        failures.push(
          `unexpected artifact schema ${JSON.stringify(result.schema)} (want ${HARNESS_RESULT_SCHEMA})`,
        );
      }
      if (result.variant !== 'release') {
        failures.push(
          `artifact is not a release run: variant=${JSON.stringify(result.variant)} — a dev-mode ` +
            `run is meaningless (testing-guide §2.6)`,
        );
      }
      if (result.target !== 'emulator') {
        failures.push(
          `artifact target=${JSON.stringify(result.target)} (want "emulator") — the leg-1 claim is ` +
            `an on-device correctness result`,
        );
      }
      if (typeof result.runId !== 'string' || !RUN_ID_PATTERN.test(result.runId)) {
        failures.push(
          `artifact runId ${JSON.stringify(result.runId)} is missing or not a real driver-shaped run ` +
            `id — the artifact does not record a real emulator run`,
        );
      }
      const gate = findGate(result, legGateId);
      if (gate === undefined) {
        leg1 = 'absent';
        failures.push(`the artifact carries no ${legGateId} gate — leg 1 was never run on device`);
      } else {
        const status = gate.status;
        leg1 =
          status === 'pass' || status === 'fail' || status === 'skipped' ? status : 'unreadable';
        if (status !== 'pass') {
          failures.push(
            `${legGateId} is ${JSON.stringify(status)} in the committed artifact, not "pass": ${String(
              gate.detail ?? '',
            )}`,
          );
        }
      }
    }
  }

  // ── every declared surface path must exist (T-14: no path that checks nothing) ────────────────
  for (const missing of facts.missingSurfacePaths) {
    failures.push(
      `at-rest surface path ${missing} does not exist at the provenance commit or on disk — the ` +
        `freshness check silently diffs nothing for it; fix AT_REST_SURFACE`,
    );
  }

  // ── the artifact commit must be clean (no smuggled at-rest change) ────────────────────────────
  for (const changed of facts.surfaceChangedInAnchorCommit) {
    failures.push(
      `the artifact's provenance commit itself modified at-rest surface file ${changed} — the ` +
        `artifact must be committed separately from code, so its freshness cannot be trusted`,
    );
  }

  // ── THE STALENESS GATE: any at-rest surface change since the anchor ⇒ RED ──────────────────────
  for (const changed of facts.surfaceChangedSinceAnchor) {
    failures.push(
      `at-rest surface file ${changed} changed since the emulator artifact's provenance commit ` +
        `${facts.anchorCommit ?? '<none>'} — the committed leg-1 result no longer reflects the code. ` +
        `Artifact STALE: re-run the emulator lane before discharging SEC-AUTH-09.`,
    );
  }

  return { ok: failures.length === 0, failures, leg1, anchorCommit: facts.anchorCommit };
}
