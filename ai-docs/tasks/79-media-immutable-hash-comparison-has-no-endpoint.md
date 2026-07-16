# TASK 79 — `api/03 §8`'s `MEDIA_IMMUTABLE` rule instructs a comparison against a value no endpoint returns
**Status:** todo
**Depends on:** —
**Filed by:** task 18 (media-client), 2026-07-16. **Fourth instance this session of "the spec cannot be implemented as written"** (62, 70, 72 are the others).

## The contradiction

`api/03-media.md §8`, the `409 MEDIA_IMMUTABLE` row, Client-behavior column:

> Treat as success if own sha256 matches **server's** (item is uploaded); else `LOCAL_CORRUPT`-class surfacing — never overwrite

**No endpoint returns the server's sha256.** Traced to the producer (T-16), not grepped:

- `GET /v1/media/:id/status` (§3.3) returns `status`, `sizeBytes`, `chunkSize`, `totalChunks`, `receivedChunks`. **No hash.**
- `POST /v1/media/:id/init` (§3.1) returns `chunkSize`, `totalChunks`, `receivedChunks`, `status`. **No hash.**
- The `409` itself carries no `details`. Verified in the shipped server: `apps/server/src/routes/media.ts:215` renders `renderMediaError(c, 'MEDIA_IMMUTABLE')` with **no third argument**, and that `complete`-status guard **returns before** the field-comparison branch at `:220` — so the code cannot even imply *which* field differed.
- The **only** place the server's hash reaches the wire is the download `ETag: "<sha256>"` (§3.5).

So the instruction, read literally, is unimplementable. It is also not obviously wrong on the merits — the *requirement* (converge to `uploaded` when the server already holds our exact bytes; never overwrite otherwise) is right and load-bearing. Only the mechanism is missing.

## What task 18 shipped (and why it is a workaround, not a fix)

A `MediaTransportPort.matchesServerHash(mediaId, sha256): Promise<boolean>` port method, implemented in `apps/mobile/src/media/transport.ts` with a **conditional GET** using §3.5 as written:

- `If-None-Match: "<sha256>"` → `304` ⇒ `true` (hashes match; **no body crosses the wire**), `200` ⇒ `false`.
- Any other outcome **rejects**, and `drain.ts` treats a rejection as *cannot confirm* ⇒ `LOCAL_CORRUPT`-class. **Fails closed**, deliberately: marking evidence `uploaded` on an assumption is the worst outcome available here, because the pruning pass then deletes the local file 7 days later (06 §7) and the evidence is gone for good.

This invents no wire — every part is §3.5 as specified — but it is **derived, not documented**, which is the problem. The next implementer reading §8 will look for an endpoint that returns the hash, not find one, and either re-derive this from scratch or get it wrong (e.g. infer a match from the `409` code alone, which is exactly what the server's early return makes unsound).

## What `§8` should say

Replace the Client-behavior cell of the `409 MEDIA_IMMUTABLE` row with something that names the mechanism, e.g.:

> Compare own `sha256` to the server's via a conditional `GET /v1/media/:id` with `If-None-Match: "<sha256>"` (§3.5): `304` ⇒ the bytes match, mark the item `uploaded` (treat as success); `200` ⇒ the server holds different bytes ⇒ `LOCAL_CORRUPT`-class surfacing, never overwrite. Any other response ⇒ cannot confirm ⇒ `LOCAL_CORRUPT`-class (fail closed — never assume a match).

**Owner decision required on one alternative** before writing that: it may be preferable to have `init`/`status` return the stored `sha256` outright (it is not a secret — the client signed it), which would make the rule a plain field comparison and remove a network round-trip from the resume path. That is a **wire change** (`/v1/` versioned, §"Change control": change the doc first, then the code) and touches task 19's server, so it is not task 18's to make. The ETag route was chosen precisely because it required **no** wire change.

## Acceptance

- `api/03-media.md §8`'s `MEDIA_IMMUTABLE` row names a mechanism that exists, OR §3.1/§3.3's response shapes grow the hash and the row cites it.
- If the ETag route is ratified: §3.5 gains a note that `If-None-Match` is the sanctioned hash-comparison path (today it reads as a pure caching affordance), and `MediaTransportPort.matchesServerHash`'s comment is repointed from "spec gap" to the ruling.
- If the field route is ratified: task 19 adds `sha256` to the `init`/`status` responses, `zMediaStatusResponse` grows the field, and task 18's `matchesServerHash` collapses into a comparison (the port method may then be deleted — the drain loop's call site is one line).
- Either way: an adversarial test proves a client **cannot** be induced to mark an item `uploaded` by a `409` alone. `packages/core/test/media/adversarial.test.ts`'s *"a server claiming MEDIA_IMMUTABLE for media it does not hold cannot mark evidence uploaded"* already asserts exactly this and must stay green through the change.

## Why this is worth a task and not a comment

Same shape as **task 72** (`06 §3.2` assigns `mediaRefSchema` to a package that cannot import zod). In both, an implementer hit a spec that cannot be followed, found a compliant route, and shipped it with a comment — and in both, the **spec text is still wrong**, so the next reader is misled by the doc rather than the code. CLAUDE.md §4: spec changes are their own task, never an implementation side effect.
