# TASK 72 — `06 §3.2` puts `mediaRefSchema` in a package that structurally cannot author it: it contradicts `08 §3.3`

**Status:** todo
**Priority:** **MEDIUM** — no live defect (nothing has built it yet; task 18 was ruled to `@bolusi/schemas` before writing a line). The defect is that the spec **instructs the next agent to commit a boundary violation that would compile, lint green, and break only at runtime as a missing dep in `dist`.**
**Depends on:** —
**Blocks:** —
**SEC ids owned by THIS task:** none

## The finding (impl-18, task 18 T-11 reproduction, 2026-07-16)

**`06-media-pipeline.md §3.2:72`**, verbatim:

> Defined once in `@bolusi/core` as `mediaRefSchema` (Zod, `.strict()`); any module payload that attaches media embeds it. Never redefine per module (CLAUDE.md §2.8).

**`@bolusi/core` cannot author a Zod schema.** Three independent confirmations, verified by the orchestrator against the tree (not taken from a report):

| evidence | says |
| -------- | ---- |
| `08-stack-and-repo.md §3.3:159` | `\| \`core\` \| \`schemas\` (+ \`canonicalize\`, \`kysely\` types) \|` — **zod is not on core's allow-list** |
| `packages/core/package.json` | zod is a **devDependency**, not a dependency |
| `packages/core/src/module/strict-schema.ts:6` | *"@bolusi/core may not import zod (08 §3.3 …)"* — stated outright, in code |

So §3.2's *requirement* is right and load-bearing — **defined once, Zod, `.strict()`, never redefined per module** — and its *stated location* is impossible.

## Why this is a task and not a one-line edit: no gate can catch it

impl-18 established, and the orchestrator confirmed, that the violation is **invisible to every check we have**:

- `bolusi/boundaries` is a **deny-list**. Its own header records that §3.3's positive allow-matrix is **"NOT YET IMPLEMENTED"**, and `zod` is not in `PLATFORM_FORBIDDEN`.
- So `import { z } from 'zod'` inside core would **compile** (zod is a devDependency — present at build time), **lint green**, and fail only at runtime, as a missing dependency in core's published `dist`.

That is precisely CLAUDE.md §2.11's class: a rule stated in prose, enforced by nothing, whose violation is silent. The repo now has **seven** instances of authoritative prose being wrong or unenforced in one clause (`keystore.ts:16`, `notifications.ts:4`, `PinScreen.tsx:52`, `13-auth-server.md:60`, `08 §5.6:284` → task 62, `pipeline.ts:17` → fixed by 49, and this).

## The ruling already made (record it; do not re-litigate)

**`zMediaRef` lives in `@bolusi/schemas`.** Decided when it blocked task 18; impl-18 built against it. Reasons:

- `zUuidV7`, `zSha256Hex`, `zMsEpoch`, `zLocation` — all four `mediaRef` needs — already live in `@bolusi/schemas`.
- **`zLocation` reuse is mandatory, not stylistic:** `tooling/eslint/src/index.js:17-18` allowlists float props (`lat`/`lng`/`accuracyMeters`) to **`packages/schemas/src/envelope.ts` alone**. Retyping them in a media file fires `no-float-money` *and* violates §2.8.
- `schemas` may import zod; `core` may import `schemas`. Boundary satisfied, §2.8's "defined once" satisfied, runtime `.strict()` validation preserved.
- The alternative considered and rejected: a plain TS `MediaRef` type in core with no runtime schema. It is unblocked and violates nothing, but a `MediaRef` arrives **inside op payloads from other devices** — dropping `.strict()` leaves an unvalidated wire input on a security surface (§2.5) with nobody owning the gap.
- Also rejected: giving core a zod runtime dependency. That is a stack change (§6) and would undo a deliberate architecture — core is platform-free and zod-free by design, and `strict-schema.ts` documents the reasoning.

## Acceptance

**Observable done-condition:** `06 §3.2` names a package that can actually host the schema, and the next agent who reads it cannot derive a boundary violation from it.

- **Doc-first and doc-only** (§4) — this is a spec change; it *is* the task. Do not move code: `zMediaRef` already lands in `@bolusi/schemas` via task 18. Verify where it actually shipped before editing the text (T-16 — do not write "it lives in schemas" on the strength of this task file; go look).
- **Fix §3.2's location and keep its requirement intact.** The sentence's force — *defined once, Zod, `.strict()`, never redefined per module (§2.8)* — is correct and must survive verbatim in spirit. Only the package name changes.
- **State WHY in one clause**, so the next reader doesn't "helpfully" move it back: core may not import zod (`08 §3.3`), and the primitives + the float allowlist live in schemas. A bare corrected name invites a future agent to re-derive the original error.
- **Check the class** (T-12): does any **other** spec sentence assign a Zod schema, or any dependency, to a package `08 §3.3` forbids it? `06 §3.2` was found only because an implementer tried to build it. Sweep the specs for "defined in `@bolusi/core`" + zod/runtime-dep claims and report. **This is the valuable half** — the same sentence pattern may sit unbuilt in other docs.
- **The real fix is the gate, and it is NOT this task's** — record the dependency: `08 §3.3`'s positive allow-matrix is unimplemented (`bolusi/boundaries` is a deny-list; owner noted as task 28). Until it lands, §3.3 is prose. Say so in the spec text if that helps the next reader, and make sure task 28's file carries the pointer.
- `pnpm lint`, `pnpm typecheck`, `pnpm test` green — a docs-only change should move none of them; if it does, say why (§2.1: read the output, not the exit code).

## Note

Found by **impl-18 refusing to build against a brief it had traced and found false** — the fourth premise refuted on this project (after tasks 54, 58, and task 61's §218 leg), and the fourth time the refusal was correct and worth more than the work it replaced. It also caught two dead premises the orchestrator had written into task 18's file (the `media_items` migration and `pendingMediaCount`, both already shipped by tasks 04 and 15).

Worth carrying: the spec said "core", and **core's own source file says "may not"** — `strict-schema.ts:6` has been sitting there stating the rule that §3.2 breaks. Two documents, one repo, flatly contradicting, and the contradiction survived because **nothing reads prose** and no one had tried to build that particular sentence. The failure mode is not that someone wrote a wrong sentence; it is that a wrong sentence has no way to fail until an implementer trips over it. That is the argument for the §3.3 allow-matrix (task 28) over any amount of careful writing.

**Stale pointer found in the same sweep, filed here so it isn't lost:** `apps/server/src/media/schemas.ts` says lifting media DTOs into `@bolusi/schemas` is *"a coordinated follow-up (noted for task 31)"* — **task 31 shipped the SEC-META ownership gate**, not media DTOs. A mention pointing at a task that never accepted it: T-16's shape again, and the same defect task 61 found in `13-auth-server.md:60`. Whoever takes this task should repoint or delete that note.
