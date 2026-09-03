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
// ── THE MECHANISM: THE SELF-DECLARED BUILD SHA (PRIMARY), GIT ANCHOR (CROSS-CHECK) ────────────────
// Task 182 bumped the producer so the `bolusi-harness-result/1` document now STAMPS the git sha the APK
// was built from (`buildSha`, inlined from `EXPO_PUBLIC_BOLUSI_BUILD_SHA` at build time) INTO the
// tamper-evident artifact. That is the code state whose emulator run produced the JSON, declared by the
// producer itself — so it is the PRIMARY freshness binding. Before 182 the schema self-reported nothing
// (its `runId` is a timestamp, not a sha), and the only binding was WHERE THE ARTIFACT SITS IN GIT
// HISTORY (its introducing commit); that anchor is KEPT as a belt-and-braces cross-check. So the gate:
//
//   1. requires the committed artifact to DECLARE a buildSha (absent ⇒ RED — a build that did not stamp
//      its commit cannot discharge the leg; an omitted sha can never masquerade as fresh — this is what
//      closes the pre-182 downgrade-by-omission / fabricated-artifact residual),
//   2. requires that declared sha to be a REAL commit in this repo (`git cat-file -e <sha>^{commit}`) —
//      "unknown" (env unset), a forged hex, or an unreachable sha ⇒ RED (fail CLOSED),
//   3. diffs the AT-REST SURFACE between THAT BUILD COMMIT and the WORKING TREE — ANY change ⇒ STALE ⇒
//      RED: a fabricated artifact must now name a sha whose tree still matches, not just re-commit an
//      old pass at a fresh path,
//   4. ALSO anchors on the introducing commit (`git log --diff-filter=A -- <artifact>`) and diffs the
//      surface against IT (cross-check), requires that commit to have introduced NO at-rest surface
//      change (the artifact is committed CLEANLY, separate from code), and requires the surface paths to
//      exist at the anchor (T-14: a moved surface entry would diff nothing — a guard that checks nothing),
//   5. requires the working-tree artifact to be BYTE-IDENTICAL to its committed form (a hand-edit that
//      flips `skipped`/`fail` → `pass`, or that rewrites `buildSha`, is a change since the provenance
//      commit ⇒ RED),
//   6. reads the verdict AND the buildSha from the COMMITTED bytes (provenance), not the mutable on-disk copy.
//
// KNOWN RESIDUAL (the honest limit, §2.11 — a self-declared field cannot out-trust its own author): a
// brazen insider who rewrites `buildSha` to the CURRENT HEAD and fabricates the leg-1 `pass` WITHOUT ever
// running the emulator names a sha whose surface legitimately matches HEAD, so no git diff reds it — they
// control both the field and the file. No git-only or self-declared-field scheme closes that; only a
// signed producer attestation (a device-held key over the artifact bytes) would. What 182 DID close is the
// laundering class: re-committing an old passing artifact (its buildSha's surface ≠ HEAD ⇒ RED) and
// downgrade-by-omission (no buildSha ⇒ RED). See the task-28/182 reports + `sec-pending-allowlist.json`.
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
  /**
   * The `buildSha` the COMMITTED artifact declares (task 182), or `null` when the field is absent or not
   * a string. `null` ⇒ RED (downgrade-by-omission): a build that did not stamp its commit cannot discharge
   * the leg, and an omitted sha can never masquerade as fresh.
   */
  readonly declaredBuildSha: string | null;
  /**
   * Whether {@link declaredBuildSha} resolves to a real commit object in THIS repo
   * (`git cat-file -e <sha>^{commit}`). `false` when the sha is null, `"unknown"` (env unset), a forged
   * hex, or unreachable ⇒ RED (fail CLOSED — an unverifiable sha is not a freshness binding).
   */
  readonly declaredBuildShaKnown: boolean;
  /**
   * Surface paths that CHANGED between {@link declaredBuildSha} (the ACTUAL build commit) and the working
   * tree — the PRIMARY freshness diff (STALE if non-empty). Left empty by the gatherer when the sha is
   * not known; the {@link declaredBuildShaKnown} guard reds that case instead.
   */
  readonly surfaceChangedSinceBuildSha: readonly string[];
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
 * artifact commit that smuggled a code change, a MISSING or UNKNOWN declared buildSha (task 182 —
 * fail-closed downgrade-by-omission), or ANY at-rest surface change since the build sha OR the git anchor
 * (STALE). The build sha is the primary freshness binding; the git anchor is the belt-and-braces cross-check.
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

  // ── BUILD-SHA PROVENANCE (task 182): the PRIMARY freshness binding, self-declared by the producer ─
  // Preferred over the introducing-commit anchor because the producer stamps the ACTUAL build commit into
  // the artifact. REQUIRED and fail-closed: a missing sha (downgrade-by-omission) or an unverifiable one
  // (unset "unknown", forged, unreachable) reds — an omitted/unknowable sha can never masquerade as fresh.
  if (facts.declaredBuildSha === null) {
    failures.push(
      `${facts.artifactPath} declares no buildSha — the emulator build did not stamp its commit (task ` +
        `182), so the leg-1 result cannot be bound to a code state. An omitted sha is not a fresh one: ` +
        `re-run the emulator lane on a build that sets EXPO_PUBLIC_BOLUSI_BUILD_SHA (§2.11).`,
    );
  } else if (!facts.declaredBuildShaKnown) {
    failures.push(
      `${facts.artifactPath}'s declared buildSha ${JSON.stringify(facts.declaredBuildSha)} is not a ` +
        `commit in this repo — it is "unknown" (env unset), forged, or unreachable. Fail closed: an ` +
        `unverifiable build sha is not a freshness binding.`,
    );
  } else {
    for (const changed of facts.surfaceChangedSinceBuildSha) {
      failures.push(
        `at-rest surface file ${changed} changed since the artifact's DECLARED build commit ` +
          `${facts.declaredBuildSha} — the committed leg-1 result no longer reflects the code. Artifact ` +
          `STALE: re-run the emulator lane before discharging SEC-AUTH-09.`,
      );
    }
  }

  // ── STALENESS CROSS-CHECK: any at-rest surface change since the introducing anchor ⇒ RED ──────────
  // Belt-and-braces alongside the build-sha diff above: it also catches the task-28 accidental case (a
  // dev edits the seal and forgets to re-run the lane) even for an artifact predating the buildSha field.
  for (const changed of facts.surfaceChangedSinceAnchor) {
    failures.push(
      `at-rest surface file ${changed} changed since the emulator artifact's provenance commit ` +
        `${facts.anchorCommit ?? '<none>'} — the committed leg-1 result no longer reflects the code. ` +
        `Artifact STALE: re-run the emulator lane before discharging SEC-AUTH-09.`,
    );
  }

  return { ok: failures.length === 0, failures, leg1, anchorCommit: facts.anchorCommit };
}
