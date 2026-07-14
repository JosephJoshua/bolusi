# PRD-012: Platform Core

## 1. Overview

### What this is

The foundation every other module sits on. Nobody uses it directly and no user story mentions it, but every PRD in this set assumes it exists and works.

If Platform Core is right, the modules above it are ordinary CRUD applications with an unusual data flow. If it is wrong, every module inherits the wrongness, and the failures will look like bugs in the modules rather than bugs in the foundation — which is the worst possible place for them to appear.

**This should be built first, and it should be built carefully.** It is the one part of the system where "we'll fix it later" is not available, because everything else will have been written against whatever it does.

### What it provides

- The **operation log** — append-only, signed, hash-chained
- **Projections** — read models derived from operations
- The **sync engine** — moving operations between devices and the cloud
- **Media handling** — capture, local storage, background upload
- **Offline infrastructure** — local database, queues, staleness
- **Realtime transport** — for chat and notifications
- **Push notifications**
- **Printing**
- **Internationalisation**
- **Onboarding framework**
- **The command layer** — where permissions are enforced and operations are born

---

## 2. The Core Model

Stated once, plainly, because every module depends on understanding it.

**Nothing in this system is stored as current state. Everything is stored as a log of things that happened, and current state is computed from it.**

A repair ticket's status is not a field that gets overwritten. It is the result of replaying `repair.created`, `repair.technician_assigned`, `repair.status_changed`, `repair.status_changed` again, and so on. Stock is not a number that gets decremented; it is the sum of every movement ever recorded.

**Why this, rather than an ordinary database with rows you update:**

1. **Offline sync becomes tractable.** Two devices that have both been offline for a day have two lists of things that happened. Merging two lists is easy. Merging two versions of the same row that were both edited is not, and every solution to it either loses data or requires a conflict UI that tech-inadept users cannot operate.

2. **The audit trail is not a feature; it is the storage.** Every fraud control in this system rests on knowing what happened, who did it, and that nobody quietly changed it afterwards. In a system that overwrites rows, an audit trail is a parallel record that can drift from the truth. Here, the audit trail *is* the truth, and the current state is the derived thing.

3. **The agent (PRD-004) needs reversibility.** Rolling back an agent's actions means appending inverse operations. In an overwriting system, "undo" requires having stored the old value somewhere — which is to say, requires having built an operation log anyway, badly.

**The cost, honestly stated:** this is harder than a normal CRUD app. Projections must be maintained and can be wrong. Rebuilding them takes time. Every developer touching the codebase must understand the model or they will try to `UPDATE` something and be confused when it does not work. This is a real tax and it is worth paying here — but it is worth paying *because of the offline and audit requirements*, not because event sourcing is fashionable. If those requirements went away, so should this design.

---

## 3. Functional Requirements

### 3.1 The Operation Log

- **FR-1101** [Must]: An operation records one thing that happened. It carries:
  - `id`, `type`, `entityType`, `entityId`
  - `payload` — the data
  - `tenantId`, `storeId`, `userId`, `deviceId`
  - `timestamp` — when it happened, per the originating device
  - `location` — where, if relevant and available (PRD-009)
  - `source` — ui | agent | api | system
  - `agentInitiated`, `agentConversationId` — present from day one (ARCH-001 §9.3)
  - `previousHash`, `signature`
  - `syncStatus`

- **FR-1102** [Must]: Operations are **append-only**. There is no update path and no delete path. Not "we don't use them" — they do not exist in the codebase.

- **FR-1103** [Must]: A correction is a new operation, not a modification. Correcting a stock count of 50 to 45 appends an adjustment of −5 with a reason; it does not change the 50.

- **FR-1104** [Must]: Every operation is **signed** by the originating device's key.

- **FR-1105** [Must]: Every operation carries the **hash of its predecessor** in that device's chain, so that deletion, reordering, or injection is detectable.

- **FR-1106** [Must]: The server validates signature and chain continuity on receipt, and **rejects** what fails.

- **FR-1107** [Must]: Operations are written locally first. The device does not wait for the server. Ever.

### 3.2 Commands

- **FR-1108** [Must]: Operations are produced by **commands**. A command validates input, checks permissions, decides whether the thing is allowed, and appends the operation.

- **FR-1109** [Must]: A command is a **pure function of its input and the current projected state.** No UI dependency, no side effects beyond the operation it appends. (ARCH-001 §9.1 — this is what makes the V2 agent possible without a rewrite.)

- **FR-1110** [Must]: A command **checks permissions itself** (PRD-011 §3.5). It does not trust its caller.

- **FR-1111** [Must]: Every command declares the permission it requires, in the registry (PRD-011 TASK-AUTH-002).

- **FR-1112] [Must]: Every operation type has a **documented reversal**. Appending the reversal of an operation returns the projection to its prior state. This is required for the agent's rollback and for the general undo, and it must be specified as each operation type is built — retrofitting reversals across a codebase is miserable.

- **FR-1113** [Should]: Commands are the only way to produce operations. Nothing writes to the log directly.

### 3.3 Projections

- **FR-1114** [Must]: A projection is a read model derived from operations. It is stored locally for fast query.

- **FR-1115** [Must]: Projections update **incrementally** as operations arrive. Replaying the whole log on every change will not work on a 2GB device with a year of history.

- **FR-1116** [Must]: A projection can be **rebuilt from scratch** from the log. This is the correctness escape hatch and it will be needed — a projection bug shipped to production is fixed by correcting the code and rebuilding.

- **FR-1117** [Must]: Projections are **queryable programmatically** — filters, sorting, pagination — not only through UI-specific hooks. The V2 agent will query them (ARCH-001 §9.5), and so will the reporting module.

- **FR-1118** [Must]: Operations arriving **out of order** (which sync will do routinely) must produce the correct projection. A projection that depends on arrival order is broken.

- **FR-1119** [Must]: Projections are **never** the source of truth. If a projection and the log disagree, the log is right and the projection is rebuilt.

### 3.4 Sync

- **FR-1120** [Must]: **Push:** the device sends unsynced operations to the server. The server validates, stores, and acknowledges. The device marks them synced.

- **FR-1121** [Must]: **Pull:** the device requests operations it has not seen. The server returns those relevant to the device's tenant and store scope. The device applies them and updates projections.

- **FR-1122** [Must]: Sync is **resumable**. A sync interrupted halfway through a hundred operations resumes; it does not start over.

- **FR-1123** [Must]: Sync is **incremental**. A device that has been offline for a week pulls a week of operations, not the whole history.

- **FR-1124** [Must]: A device may be offline for **days**. This is the design point, not an edge case — power outages in West Papua last a day or two (ARCH-001 §1).

- **FR-1125** [Must]: Sync happens in the background. It never blocks the user.

- **FR-1126** [Must]: Sync is **scoped**. A device pulls operations for its store, plus whatever cross-store data the user's permissions justify. A device at Toko Jayapura does not receive the whole franchise's operation log.

- **FR-1127** [Should]: Sync should be efficient on a bad 3G connection. Batch, compress, and do not chatter.

### 3.5 Conflict

- **FR-1128** [Must]: Because operations are append-only, there are no write-write conflicts in the storage sense. Two devices appending is just two appends.

- **FR-1129** [Must]: **Business-level conflicts** do occur and must be surfaced:
  - Stock sold twice offline, going negative on merge
  - The same repair advanced by two people
  - Contradictory adjustments

- **FR-1130** [Must]: **Minor conflicts auto-resolve.** Two small stock adjustments both apply. There is nothing to decide.

- **FR-1131** [Must]: **Significant conflicts surface to the store owner** for a decision, per Ocep. They are not silently resolved by a rule the owner cannot see.

- **FR-1132** [Must]: **Overselling is accepted, not prevented** (ARCH-001). Stock may go negative. It is flagged, reported (PRD-005 §3.6), and someone deals with it. This was an explicit decision: the reservation protocol that would prevent it was judged too complex for the user base and the benefit too small.

### 3.6 Staleness

- **FR-1133** [Must]: Every device knows when it last synced, and shows it.

- **FR-1134** [Must]: Staleness indication **escalates**. Five minutes is fine and should be quiet. Two days is not fine and should be loud.

- **FR-1135** [Must]: Data that is *definitionally* stale must say so. A main owner's cross-store dashboard is only as fresh as the **least recently synced contributing store** — not as fresh as the local device (PRD-005 §7). Getting this wrong produces false confidence, which is worse than an honest "we don't know."

- **FR-1136** [Must]: Within a single device, local data is always consistent. Local operations apply immediately. A user never sees their own action fail to appear.

### 3.7 Media

- **FR-1137** [Must]: Media (photos, videos, signatures) is captured locally and stored on the device.

- **FR-1138** [Must]: An operation references media by ID. The operation syncs independently of the media file — a repair ticket is usable before its photos have uploaded.

- **FR-1139** [Must]: Media uploads in the background, **chunked and resumable**. A 30-second video on a 3G connection that drops halfway must not start over.

- **FR-1140** [Must]: Media capture works fully offline.

- **FR-1141** [Must]: Media is **compressed at capture** for a 2GB-RAM device and a slow uplink. Full-resolution photos from a modern phone camera are wildly beyond what any of these use cases need.

- **FR-1142** [Must]: Media carries embedded metadata: timestamp, location, user, device (PRD-009 §2.4). Immutable.

- **FR-1143** [Must]: Media, once attached to an operation, cannot be replaced.

- **FR-1144** [Should]: There is no storage cap on the device (per Ocep), but local media should be prunable once safely uploaded — a device with 32GB will fill up eventually.

### 3.8 Realtime

- **FR-1145** [Should]: A realtime channel delivers chat messages and notifications when online.

- **FR-1146** [Must]: Realtime is an **optimisation, never a requirement.** Everything works without it, just less immediately. A system where a dropped socket breaks a feature has not understood the connectivity it is being deployed into.

- **FR-1147** [Must]: On reconnect, backfill. Nothing is lost because a socket dropped during a 3G handover.

### 3.9 Push Notifications

- **FR-1148** [Must]: Push notifications for: new chat messages, approvals awaiting the user, alerts (PRD-009 §2.5), attention items (PRD-005 §3.3).

- **FR-1149** [Must]: Notification preferences per user, not per device.

- **FR-1150** [Must]: Notifications are mutable by category. A notification stream that is mostly noise gets muted wholesale, and then the one that mattered is missed too.

### 3.10 Printing

- **FR-1151** [Must]: A shared printing layer serves both repair receipts (PRD-001 §3.9) and POS receipts (PRD-006 §3.6). **One printer integration, not two.**

- **FR-1152** [Must]: Thermal printers over Bluetooth, USB, and network.

- **FR-1153** [Must]: Standard printers for A4/A5 repair orders.

- **FR-1154** [Must]: Printer discovery with **minimal configuration.** The person setting this up is a shop owner, not an IT administrator.

- **FR-1155** [Must]: Printing works offline, from local data.

- **FR-1156** [Must]: A print failure **never blocks or rolls back the transaction.** The sale happened; the paper is a separate concern. Queue it and let them retry.

### 3.11 Internationalisation

- **FR-1157** [Must]: Indonesian and English, toggleable in-app.

- **FR-1158** [Must]: **No hardcoded user-facing strings anywhere.** This is trivially cheap to enforce from day one and enormously expensive to retrofit.

- **FR-1159** [Should]: Chinese, for the V2 agent (PRD-004 §3.12) and possible future need.

- **FR-1160** [Must]: Number, currency, and date formatting appropriate to locale. IDR has no minor unit; do not render `Rp 250.000,00`.

### 3.12 Onboarding Framework

- **FR-1161** [Should]: A reusable mechanism for role-specific guided tours (each module PRD specifies its own content).

- **FR-1162** [Should]: Tooltips with highlighted UI regions, not walls of text.

- **FR-1163** [Should]: Triggered on first login per role; re-triggerable from settings.

- **FR-1164** [Should]: Skippable. An onboarding flow that cannot be dismissed is a punishment.

---

## 4. Non-Functional Requirements

- **NFR-1101**: Runs on a 2GB-RAM, 32GB Android device. This is the constraint that kills naive implementations — a projection rebuild that assumes it can hold the log in memory will not survive contact with the target hardware.
- **NFR-1102**: Every user-facing operation completes locally, without a network round trip.
- **NFR-1103**: App cold start under three seconds with a year of history.
- **NFR-1104**: Sync must not degrade foreground responsiveness. A background sync that makes the POS screen stutter will get the app closed.
- **NFR-1105**: Battery. Continuous GPS during delivery runs, background media upload, and realtime sockets are all battery costs, and a driver whose phone dies loses proof of delivery (PRD-008 NFR-702).
- **NFR-1106**: Local data at rest encrypted (PRD-011 NFR-1006).
- **NFR-1107**: Desktop and mobile maintain feature parity where it makes sense (ARCH-001 §7). Shared logic, not two implementations.

---

## 5. Data Entities (Conceptual)

### Operation

As FR-1101.

### Projection

Not one entity — a pattern. Each module defines its own. What is shared is the machinery: incremental application, rebuild, ordered-independent correctness, programmatic query.

### SyncState

- `deviceId`
- `lastPushedOperationId`
- `lastPulledTimestamp`
- `pendingOperationCount`
- `pendingMediaCount`
- `lastSuccessfulSyncAt`

### MediaItem

- `id`
- `localPath`
- `remoteUrl` — Null until uploaded
- `type` — image | video | signature
- `metadata` — { capturedAt, location, userId, deviceId } — immutable
- `uploadStatus` — pending | uploading | uploaded | failed
- `uploadedBytes` — For resumption
- `attachedToOperationId`

---

## 6. Edge Cases & Error States

- **Device offline for a week.** Works throughout. Syncs a week of operations on reconnect. Pull is incremental; it does not re-download the world.
- **Two devices offline, both sell the last item.** Both sales are valid operations. Stock goes negative on merge. Flagged, reported, someone deals with it. **This is the accepted design (FR-1132), not a bug.**
- **Sync interrupted halfway.** Resumes. Operations already acknowledged are not re-sent.
- **Server rejects an operation** (bad signature, broken chain, failed validation). The device is told, the operation is marked rejected, and the user is informed that something they did did not stick. **Silent rejection is unacceptable** — a cashier who believes they recorded a sale that the server threw away is worse off than one who was told.
- **Projection is wrong.** Fix the code, rebuild from the log. This is the escape hatch that makes the model survivable, and it must actually work, on a real device, with a real amount of history — which means it must be tested against that, not against a toy dataset.
- **Rebuild takes too long.** A year of operations on a 2GB device is not fast. Snapshot periodically so a rebuild replays from the last snapshot rather than from the beginning.
- **Device clock wrong.** Cheap Android devices drift, and a device offline for days drifts badly. Operations carry the device's belief about the time. Detect gross skew, flag it, **do not assume malice** (PRD-009 §6).
- **Media never uploads.** Retries with backoff. Surface persistently failing uploads — a repair with no photos is a repair with no evidence, and the store should know before the customer disputes it.
- **Device runs out of storage.** Prune uploaded media. Warn before it becomes a problem, because the failure mode is the camera silently not working, which will be discovered at the worst moment.
- **Operations arrive out of order.** Routine, not exceptional. Projections must be correct regardless of arrival order (FR-1118). This is the single most common source of subtle bugs in this architecture and deserves real test coverage.
- **A device is restored from a backup** and replays operations it already sent. Server dedupes by operation ID. Idempotency is not optional.

---

## 7. Open Questions

- **OQ-1101**: Snapshot frequency for projection rebuild? Too rare and rebuilds crawl; too frequent and storage bloats.
- **OQ-1102**: How much history does a device retain locally? All of it, forever, on a 32GB phone, is not sustainable across years. Archive old operations server-side and let devices hold a window?
- **OQ-1103**: Sync scope — how much cross-store data does a device pull? A main owner's device wanting network-wide reporting is a different scope from a cashier's. Pulling everything to every device does not scale to a hundred stores.
- **OQ-1104**: What is the sync trigger? Periodic, on-connectivity-change, on-user-action, or all three?
- **OQ-1105**: Media retention on device after successful upload — how long before pruning?
- **OQ-1106**: Realtime transport — is it worth the complexity for V1, given chat is the lowest-priority module and everything else can poll?

---

## 8. Claude Code Task Breakdown

> **Build order matters here more than anywhere else in the project.** These tasks are roughly sequential, and later modules cannot start meaningfully until the first few are solid.

### TASK-CORE-001: Operation Log

**Context:** The foundation. Everything else is built on this, so it must be right before anything else is built.

**Acceptance Criteria:**
- [ ] Operation entity per FR-1101, **including the agent attribution fields from day one** (ARCH-001 §9.3)
- [ ] Append-only local storage
- [ ] **No update or delete path exists in the codebase**
- [ ] Device signing on every operation
- [ ] Hash chain linking each operation to its predecessor
- [ ] Server-side signature and chain validation; rejects failures
- [ ] **Idempotent** — replaying an operation the server already has is a no-op, not a duplicate
- [ ] Written locally first, always; never waits for the server

**Depends On:** Nothing. This is first.

**Relevant PRD Sections:** §2, §3.1, PRD-009 §2.6

---

### TASK-CORE-002: Projection Engine

**Context:** Turning the log into something you can query. The hard requirements are incremental update and order-independence.

**Acceptance Criteria:**
- [ ] Projection registration: a module declares how its projection responds to operation types
- [ ] **Incremental application** — does not replay the log on every change
- [ ] **Correct under out-of-order arrival** (FR-1118) — this needs real test coverage, not a happy-path test
- [ ] Full rebuild from log, and it must work **on a 2GB device with a realistic amount of history**
- [ ] Periodic snapshots so rebuilds don't start from zero
- [ ] **Programmatically queryable**: filter, sort, paginate (ARCH-001 §9.5)
- [ ] Projection is never the source of truth

**Depends On:** TASK-CORE-001

**Relevant PRD Sections:** §3.3

---

### TASK-CORE-003: Command Layer

**Context:** Where permissions are enforced and operations are born. This is the seam the V2 agent will plug into, and building it wrong means rewriting every module later.

**Acceptance Criteria:**
- [ ] Command interface: validate input → check permission → decide → append operation
- [ ] **Pure functions.** No UI dependency, no toast, no navigation, no side effects beyond the operation.
- [ ] **Permission checked inside the command**, not in the route handler above it (PRD-011 TASK-AUTH-003)
- [ ] Every command declares its required permission in the registry
- [ ] **Every operation type has a documented reversal**, written at the time the operation type is built, not retrofitted
- [ ] Commands are the only path to writing an operation

**Depends On:** TASK-CORE-001, TASK-AUTH-002, TASK-AUTH-003

**Relevant PRD Sections:** §3.2, ARCH-001 §9.1, §9.2

---

### TASK-CORE-004: Sync Engine

**Context:** Moving operations between devices and the cloud, over a network that will fail.

**Acceptance Criteria:**
- [ ] Push unsynced operations; server validates and acknowledges; device marks synced
- [ ] Pull operations the device hasn't seen, **scoped to tenant and store** (FR-1126)
- [ ] **Resumable** — interruption does not restart
- [ ] **Incremental** — a week offline pulls a week, not everything
- [ ] Background; never blocks the user
- [ ] Efficient on bad 3G: batched, compressed, not chatty
- [ ] **Rejected operations surfaced to the user** — never silently dropped
- [ ] Survives days offline

**Depends On:** TASK-CORE-001, TASK-CORE-002

**Relevant PRD Sections:** §3.4, §6

---

### TASK-CORE-005: Conflict Handling

**Context:** Append-only removes storage conflicts but not business conflicts. Someone still has to decide what to do about the item that was sold twice.

**Acceptance Criteria:**
- [ ] Business-conflict detection: negative stock, contradictory state transitions, contradictory adjustments
- [ ] **Minor conflicts auto-resolve** (both small adjustments apply)
- [ ] **Significant conflicts surface to the store owner** for a decision — not silently resolved by an invisible rule
- [ ] **Overselling permitted, flagged, reported** — never prevented (FR-1132)
- [ ] Conflicts feed reporting (PRD-005)

**Depends On:** TASK-CORE-002, TASK-CORE-004

**Relevant PRD Sections:** §3.5

---

### TASK-CORE-006: Staleness

**Context:** Telling the truth about how old the data is. Small feature, disproportionate consequence — this is what prevents an owner making a decision on two-day-old numbers believing they are live.

**Acceptance Criteria:**
- [ ] Last-sync time tracked and displayed
- [ ] **Escalating indication** — quiet at five minutes, loud at two days
- [ ] **Cross-store views reflect the oldest contributing store's sync time**, not the local device's (FR-1135, PRD-005 §7)
- [ ] Local data always immediately consistent within the device

**Depends On:** TASK-CORE-004

**Relevant PRD Sections:** §3.6

---

### TASK-CORE-007: Media Pipeline

**Context:** Photos and video, captured offline, uploaded over a connection that drops.

**Acceptance Criteria:**
- [ ] Capture works fully offline
- [ ] **Compressed at capture** for a 2GB device and a slow uplink
- [ ] Metadata embedded immutably: timestamp, location, user, device (PRD-009 §2.4)
- [ ] **Live camera only** where evidence is required — no gallery selection
- [ ] Operation references media by ID; **operation syncs independently of the file**
- [ ] **Chunked, resumable background upload** — a dropped 3G connection does not restart a video
- [ ] Media, once attached, cannot be replaced
- [ ] Persistently failing uploads surfaced
- [ ] Prunable once safely uploaded; warn before storage fills

**Depends On:** TASK-CORE-001, TASK-CORE-004, TASK-GPS-001

**Relevant PRD Sections:** §3.7

---

### TASK-CORE-008: Printing Layer

**Context:** **One printer integration, serving both repair and POS.** Two would be a waste and would drift apart.

**Acceptance Criteria:**
- [ ] Thermal over Bluetooth, USB, network
- [ ] Standard printers for A4/A5
- [ ] **Discovery with minimal configuration** — a shop owner sets this up, not an IT admin
- [ ] Works offline from local data
- [ ] **Print failure never blocks or rolls back a transaction** — queue and retry
- [ ] Shared by PRD-001 and PRD-006

**Depends On:** TASK-CORE-001

**Relevant PRD Sections:** §3.10

---

### TASK-CORE-009: Push Notifications

**Context:** Getting a person's attention, without exhausting their willingness to have it got.

**Acceptance Criteria:**
- [ ] Push for: chat, approvals, alerts, attention items
- [ ] **Preferences per user, not per device**
- [ ] **Mutable by category** — an all-or-nothing notification stream gets muted wholesale and then the important one is missed

**Depends On:** TASK-CORE-004

**Relevant PRD Sections:** §3.9

---

### TASK-CORE-010: Internationalisation

**Context:** Cheap now, expensive later. Do it on day one.

**Acceptance Criteria:**
- [ ] Indonesian and English, toggleable
- [ ] **Zero hardcoded user-facing strings.** Enforce with a lint rule, not with discipline.
- [ ] Chinese scaffolded for V2 agent
- [ ] IDR formatting correct — **no minor unit**
- [ ] Date and number formatting per locale

**Depends On:** Nothing. Do it from the first screen.

**Relevant PRD Sections:** §3.11

---

### TASK-CORE-011: Realtime Transport

**Context:** Nice to have. Not load-bearing. See OQ-1106 — this may not be worth building for V1 at all.

**Acceptance Criteria:**
- [ ] Channel for chat and notifications when online
- [ ] **Everything works without it** — it is an optimisation, never a requirement (FR-1146)
- [ ] Reconnect and backfill; nothing lost to a dropped socket
- [ ] Falls back to polling

**Depends On:** TASK-CORE-004

**Relevant PRD Sections:** §3.8

---

### TASK-CORE-012: Onboarding Framework

**Context:** The mechanism. Each module PRD supplies the content.

**Acceptance Criteria:**
- [ ] Role-specific guided tours
- [ ] Tooltips with highlighted regions, not walls of text
- [ ] First login per role; re-triggerable from settings
- [ ] **Skippable**

**Depends On:** TASK-AUTH-002 (roles)

**Relevant PRD Sections:** §3.12
