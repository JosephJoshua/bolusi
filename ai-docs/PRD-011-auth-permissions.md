# PRD-011: Auth, Users & Permissions

## 1. Overview

### Why this is its own PRD

Permissions are not a feature. They are a property of every other feature, and they are the thing most likely to be got wrong in a way that is expensive to fix.

Three constraints in this project make the permission model load-bearing rather than incidental:

1. **The fraud model depends on attribution.** Every control in every other PRD — cash reconciliation, void rates, stock adjustments, attendance corrections — rests on knowing *which human* did a thing. A permission system that cannot reliably attribute an action makes the entire anti-fraud design decorative.

2. **The agent (PRD-004) executes as the user.** In V2, an LLM will attempt to call commands on a person's behalf. The only thing standing between that and a very bad day is that permissions are checked at the command layer, granularly, at execution time. If permissions are enforced by hiding buttons, the agent bypasses them by not being a button.

3. **This becomes multi-tenant SaaS in six months.** A permission model that assumes one franchise will need to be torn out. Tenant isolation is not a feature to add later; it is a property that either holds from the first line or does not hold at all.

### Goals

- Attribute every action to an individual human
- Make role definition and permission assignment configurable by the main owner, not hardcoded
- Enforce permissions at the command layer, not the UI layer
- Support fast user switching on a shared device without sacrificing attribution
- Isolate tenants completely
- Let a store owner hold several stores and move between them

---

## 2. The Shared-Device Problem

This deserves stating directly because it was a real fork in the design.

**The situation:** a store may have one device. Several people use it across a day. They are, in Ocep's words, "very tech inadept." The original instinct was a shared generic "Kasir" login.

**Why that was rejected:** a shared login destroys attribution. Every fraud control in PRD-005 §8 — void rate per cashier, cash variance per cashier, discount volume per cashier — becomes meaningless if "Kasir" is four people. The audit trail records that Kasir did it, which is to say it records nothing.

**The resolution, agreed with Ocep:** individual user accounts, with **PIN-based quick-switch** on a shared device. The friction is a four-digit PIN, which is roughly the friction of unlocking a phone, and which tech-inadept users already do a hundred times a day without thinking about it.

**What this means in practice:**

- Each employee has their own account
- A device remembers which accounts are enrolled on it
- Switching user is: tap a face/name, enter a PIN. Two seconds.
- Every operation carries the ID of the user who was active
- Shifts (PRD-006 §3.9) belong to users, not devices

The design cost is small. The alternative cost — a fraud detection system that cannot name a person — is not.

---

## 3. Functional Requirements

### 3.1 Users

- **FR-1001** [Must]: A user account belongs to exactly one tenant.
- **FR-1002** [Must]: Users are created by the main owner or by a store owner. **There is no self-registration.**
- **FR-1003** [Must]: A user has: name, a login identifier, a PIN, one or more assigned stores, and one or more roles.
- **FR-1004** [Must]: A user may be deactivated. Deactivation revokes access but **preserves every operation they ever performed** — the audit trail does not shrink when someone leaves.
- **FR-1005** [Must]: A user is linked to an Employee record (PRD-007 §3.1) where one exists. They are separate entities: an employee may exist before a login is issued, and a login may be revoked while the employment record persists.
- **FR-1006** [Should]: A user may be assigned to more than one store.

### 3.2 Authentication

- **FR-1007** [Must]: Initial authentication on a device shall establish the device as enrolled and the user as present.
- **FR-1008** [Must]: Once enrolled, subsequent authentication on that device shall be by **PIN** — a short numeric code.
- **FR-1009** [Must]: PINs shall be per-user, not per-device.
- **FR-1010** [Must]: Authentication shall work **fully offline.** A store whose connection has been down for two days still has staff who need to log in. Credentials must be verifiable locally.
- **FR-1011** [Must]: PIN attempts shall be rate-limited locally, with escalating delay. A four-digit PIN is ten thousand possibilities and an unthrottled attacker with the device gets in.
- **FR-1012** [Should]: A device shall be able to hold several enrolled users, presented as a switcher.
- **FR-1013** [Must]: Switching users shall take under five seconds, including the PIN.
- **FR-1014** [Must]: A user switch shall be recorded as an operation. Who was on the device, and when, is itself audit-relevant.
- **FR-1015** [Should]: An idle device shall lock back to the switcher after a configurable period, so that a cashier who walks away does not leave their identity available to the next person.

### 3.3 Device Enrolment

- **FR-1016** [Must]: A device shall be enrolled to a tenant and a store.
- **FR-1017** [Must]: An enrolled device shall hold a signing key used for the operation log's signatures (PRD-009 §2.6, ARCH-001 §2.2).
- **FR-1018** [Must]: A device shall be revocable. A lost or stolen device is a live threat: it holds local data and a valid signing key.
- **FR-1019** [Must]: Revoking a device shall not invalidate the operations it signed before revocation. The history remains verifiable; only future operations from that key are rejected.
- **FR-1020** [Should]: The main owner and store owner shall see enrolled devices, when each last synced, and be able to revoke.

### 3.4 Roles

- **FR-1021** [Must]: Roles shall be **configurable by the main owner**, not hardcoded. Ocep was explicit about flexibility here, and the SaaS case makes it necessary — another business will not have "teknisi."
- **FR-1022** [Must]: A role is a named set of permissions.
- **FR-1023** [Must]: A user may hold several roles. Their effective permissions are the union.
- **FR-1024** [Should]: The system shall ship with sensible default roles for a repair shop — main owner, store owner, manager, cashier, technician, purchaser, driver, accountant — which a tenant may then edit.
- **FR-1025** [Must]: A role may be scoped to a store. "Manager at Toko Jayapura" is not "manager everywhere."

### 3.5 Permissions

This is the part that must be got right.

- **FR-1026** [Must]: Permissions shall be **granular**, expressed as capabilities on specific operations — not coarse module-level access.

  Not: `can_use_inventory`
  But: `inventory.adjust_stock`, `inventory.view_cost_price`, `inventory.approve_opname`, `inventory.copy_catalog`

- **FR-1027** [Must]: Permissions shall be **enforced at the command layer.** A command checks the caller's permissions before it does anything, every time.

- **FR-1028** [Must]: UI-level hiding is a **convenience, not a control.** A hidden button must also be an unauthorised command. This is not defensive over-engineering — it is the precondition for the V2 agent (PRD-004 §3.6), which will call commands directly and will never see a button.

- **FR-1029** [Must]: Permissions shall gate **data**, not merely actions. `inventory.view_cost_price` must mean cost price is not *sent to the client*, not that it is sent and then hidden. Ocep was specific that a purchaser must not see cost price; a purchaser with a browser devtools console must also not see it.

- **FR-1030** [Must]: Every permission check shall be evaluated in a **scope** — this user, this store, this tenant. A store owner has `finance.view_pl` at their store and nowhere else.

- **FR-1031** [Must]: A permission check shall fail **closed**. An unrecognised permission, a missing scope, or an ambiguous state denies.

- **FR-1032** [Must]: Permission checks shall work **offline**, from locally cached role and permission definitions.

- **FR-1033** [Must]: When a user's permissions change, the change shall take effect on their next sync, and any cached privileged data on their device shall be invalidated.

### 3.6 Scope & Store Switching

- **FR-1034** [Must]: A store owner assigned to several stores shall be able to switch the active store within the app, without logging out.
- **FR-1035** [Must]: A store owner shall be able to view an aggregate across their stores (PRD-005 §3.1).
- **FR-1036** [Must]: A user shall never see data from a store they are not assigned to. Attempting it returns a permission error — **not an empty result.** An empty result is indistinguishable from "there is nothing there," which leaks the fact that the store exists and is quiet.
- **FR-1037** [Must]: The main owner sees all stores in their tenant, and **only** their tenant.

### 3.7 Multi-Tenancy

- **FR-1038** [Must]: Every entity in the system shall belong to a tenant.
- **FR-1039** [Must]: Tenant isolation shall be enforced at the **data layer**. A query that forgets to filter by tenant must not silently return another tenant's rows — it must be impossible to write that query, or it must fail.
- **FR-1040** [Must]: There shall be no cross-tenant access path. Not for the main owner, not for support, not for an admin. If platform support needs to see a tenant's data, that is an explicit, logged, consented impersonation — not an ambient capability.
- **FR-1041** [Must]: A user belongs to exactly one tenant. There is no cross-tenant user.
- **FR-1042** [Should]: Tenant-level configuration — active modules, custom roles, customer tiers, feature flags — shall be per tenant.

### 3.8 Audit

- **FR-1043** [Must]: Every operation shall carry the acting user, the device, the tenant, the store, and the timestamp.
- **FR-1044** [Must]: Every operation shall carry the fields defined in ARCH-001 §9.3 — `source` (ui / agent / api / system), `agentInitiated`, `agentConversationId` — from day one, even though the agent does not exist yet. Adding an attribution field to an append-only log after the fact means the history before the change cannot be attributed, permanently.
- **FR-1045** [Must]: Permission denials shall be logged. A pattern of a user repeatedly attempting actions they cannot perform is worth seeing.
- **FR-1046** [Should]: Changes to roles and permissions shall themselves be audited. Who granted whom the ability to approve their own stock adjustments, and when.

---

## 4. Non-Functional Requirements

- **NFR-1001**: Authentication works fully offline. This is not negotiable — the alternative is a store that cannot open because the network is down.
- **NFR-1002**: A permission check must be cheap enough to run on every command without thought. If checking is expensive, developers will cache it, and cached authorisation is stale authorisation.
- **NFR-1003**: User switch under five seconds.
- **NFR-1004**: PINs stored as salted hashes, never recoverable. A store owner resetting a forgotten PIN issues a new one; they do not look up the old one.
- **NFR-1005**: Device signing keys stored in platform secure storage where available.
- **NFR-1006**: A lost device is a live threat. Local data at rest should be encrypted, and revocation should be effective on the device's next contact with the server — accepting that a device that never reconnects cannot be reached.
- **NFR-1007**: Indonesian and English.

---

## 5. Data Entities (Conceptual)

### Tenant

- `id`
- `name`
- `activeModules`
- `configuration` — Custom tiers, feature flags, defaults
- `status` — active | suspended

### User

- `id`
- `tenantId`
- `employeeId` — Nullable
- `name`
- `loginIdentifier`
- `pinHash`
- `storeIds`
- `roleIds`
- `status` — active | deactivated
- `createdBy`, `createdAt`

### Role

- `id`
- `tenantId`
- `name`
- `permissionIds`
- `isSystemDefault` — Shipped defaults may be edited but the fact they were defaults is worth knowing
- `scopeType` — global | store

### Permission

- `id` — e.g. `inventory.view_cost_price`
- `module`
- `action`
- `description` — Human-readable, because a main owner configuring roles must understand what they are granting
- `isDangerous` — Flags permissions that should be granted deliberately (approve own adjustments, void sales, correct attendance, copy catalog)

### Device

- `id`
- `tenantId`, `storeId`
- `signingKeyPublic`
- `enrolledAt`, `enrolledBy`
- `lastSyncAt`
- `status` — active | revoked
- `revokedAt`, `revokedBy`

### UserSession (Operation)

- `userId`, `deviceId`
- `startedAt`, `endedAt`
- Recorded as an operation — who was on which device, when

---

## 6. UI/UX Flows

### 6.1 User Switch

The most-used auth interaction, and it must be fast enough that nobody is tempted to share a login to avoid it.

A row of enrolled users on the device — name, and a photo if one exists. Tap yours. Enter PIN. In.

The photo matters more than it looks. Tech-inadept users identify themselves by face far faster than by reading a name, and a wall of names in an unfamiliar script — for an employee whose literacy may be limited — is a barrier where a face is not.

### 6.2 Idle Lock

After idle, back to the switcher. Not a logout — the cart, the open repair, the half-finished form all survive. The user comes back, taps, PINs, and continues.

**Design note:** an idle lock that loses work will be disabled by whoever can disable it, and then it protects nothing. Preserve state.

### 6.3 Store Switch

For a store owner with several stores: a picker at the top of the app. Switching changes the scope of everything below it — dashboard, reports, inventory. The current store must be visible at all times, because a store owner who adjusts stock in the wrong store because they did not notice which one they were in has been failed by the interface.

### 6.4 Role Configuration (Main Owner)

A list of roles. Each role opens to a list of permissions with checkboxes, grouped by module, each with a plain-language description.

Permissions marked `isDangerous` are visually distinct. Granting a cashier the ability to approve their own voids should feel like a decision, not a checkbox among fifty.

**Design note:** the person configuring this is not a security engineer. They are a shop owner. The descriptions must say what the permission *lets someone do to the business* — "Bisa menyetujui pembatalan transaksi sendiri" — not what it does to the data model.

### 6.5 Device Management

A list of enrolled devices, when each last synced, who is on them. One action: revoke.

A device that has not synced in a long time is worth surfacing — it may be lost, it may be broken, or it may be a store that has been offline and has a week of unsynced operations sitting on it.

---

## 7. Edge Cases & Error States

- **Forgotten PIN.** Store owner or main owner resets it. Never recoverable. The reset is an audited operation.
- **PIN brute-force.** Local rate limiting with escalating delay. After a threshold, the device requires a full re-authentication rather than a PIN.
- **User deactivated while logged in on a device that is offline.** They keep working until the device syncs. There is no way around this — an offline device cannot be told anything. This is an accepted property of offline-first, and it means deactivation is *eventually* effective, not immediately. For a genuinely urgent revocation (an employee dismissed for theft), the device itself should be repossessed, which is a physical control, not a software one. Say this plainly to store owners rather than implying a power the system does not have.
- **Device lost while holding a week of unsynced operations.** Those operations are gone. This is a real risk of offline-first and the mitigation is sync frequency, not cleverness.
- **Device stolen.** Revoke. Its past operations remain valid (they were legitimately signed at the time); its future ones are rejected. Local data at rest is encrypted; a determined attacker with the device and time may still get at it, and the honest answer is that a stolen device is a breach, not an inconvenience.
- **Two devices, same user, both offline, both transacting.** Fine. Both attribute to the user. Operations merge on sync. The shift (PRD-006 §3.9) belongs to the user and covers both.
- **Permission revoked mid-session.** Takes effect on next sync. Cached privileged data invalidated. A report open on screen must re-check on its next fetch and drop newly-forbidden fields rather than continuing to serve them (PRD-005 §7).
- **A role is deleted while users hold it.** Either block deletion while in use, or reassign. Silently leaving users with a dangling role reference is how people end up with either no access or, worse, unchecked access.
- **The main owner deactivates themselves.** Block it. There must always be at least one active user with tenant administration rights, or the tenant is bricked.
- **Store owner assigned to zero stores.** Possible during setup. They see nothing. Not an error, but the UI should say why rather than showing an empty dashboard.

---

## 8. Security Notes

- **The threat model here is mostly insiders.** Not sophisticated external attackers — employees with legitimate device access and an incentive. This shapes the design: rate-limited PINs matter more than exotic cryptography; attribution matters more than perimeter.

- **Offline auth is a real weakening and should be acknowledged as one.** Verifying credentials locally means the credential material is on the device. A four-digit PIN, locally verified, is not strong. It is *appropriate* — it is protecting a shop terminal from a colleague, not a bank from a nation-state — but it should not be described as more than it is.

- **The signing key is the crown jewel.** A device's signing key is what makes its operations trustworthy. Compromise it and an attacker can forge history that the server will accept. Secure storage, revocation, and key rotation deserve real thought at implementation time (see PRD-009 TASK-GPS-006 notes).

- **Fail closed, everywhere.** An unrecognised permission denies. A missing tenant scope denies. An ambiguous state denies. The cost of a false denial is an annoyed employee; the cost of a false grant is a cashier who can void their own sales.

---

## 9. Open Questions

- **OQ-1001**: PIN length? Four digits is fast and weak; six is slower and meaningfully stronger. For a shop terminal, four is probably right, but it should be a conscious call.
- **OQ-1002**: Idle lock timeout? Too short and it irritates; too long and it defeats the purpose. Suggested: 5 minutes, configurable.
- **OQ-1003**: Should there be a "manager override" flow — a manager enters *their* PIN on a cashier's screen to approve a void or discount without a full user switch? This is common in retail POS and is genuinely useful. It is also a permission-elevation path and needs care: the operation is attributed to the *cashier*, with the manager recorded as approver.
- **OQ-1004**: How are the default repair-shop roles seeded for a new SaaS tenant, and how much do they differ by vertical?
- **OQ-1005**: For SaaS support access to a tenant's data — is that needed at all? If so, it must be explicit impersonation, consented and logged, never ambient.
- **OQ-1006**: What is the accountant's scope? Ocep specified an accountant mode (PRD-003 §3.8). Is the accountant an employee of the franchise, or an external professional who should see only the books and nothing else?

---

## 10. Claude Code Task Breakdown

### TASK-AUTH-001: Tenant & Data Isolation

**Context:** Build this first. Retrofitting tenant isolation is how data leaks between customers.

**Acceptance Criteria:**
- [ ] Tenant entity; every other entity carries a tenant reference
- [ ] **Isolation enforced at the data layer** — a query that omits the tenant filter must be impossible to express, or must fail loudly. Not "developers remember to filter."
- [ ] No cross-tenant access path exists anywhere in the codebase
- [ ] Tenant-level configuration: active modules, custom roles, tiers, flags

**Depends On:** Platform Core

**Relevant PRD Sections:** §3.7

**Notes for Implementation:**
- The mechanism matters less than the guarantee. Row-level security, a mandatory scoped query builder, schema-per-tenant — any of these can work. What must not happen is a codebase where correctness depends on every developer remembering a `WHERE tenant_id = ?`.

---

### TASK-AUTH-002: Users, Roles & Permission Registry

**Context:** The permission vocabulary, and the roles that bundle it.

**Acceptance Criteria:**
- [ ] User, Role, Permission entities per §5
- [ ] **Permission registry: every command in every module declares the permission it requires.** The registry is the authority, not a comment.
- [ ] Granular permissions (`inventory.view_cost_price`, not `can_use_inventory`)
- [ ] Roles configurable by the main owner; not hardcoded
- [ ] Default repair-shop roles seeded, editable
- [ ] A user may hold several roles; effective permissions are the union
- [ ] Role scoping to a store
- [ ] `isDangerous` flag on permissions that should be granted deliberately
- [ ] Plain-language descriptions written for a shop owner, not an engineer

**Depends On:** TASK-AUTH-001

**Relevant PRD Sections:** §3.4, §3.5

---

### TASK-AUTH-003: Permission Enforcement at the Command Layer

**Context:** The single most important task in this PRD. If this is done at the UI layer, the V2 agent walks straight through it and the fraud model collapses.

**Acceptance Criteria:**
- [ ] **Every command checks permissions before doing anything.** No command may execute unchecked.
- [ ] Checks are scoped: user + store + tenant
- [ ] **Fails closed** — unrecognised permission, missing scope, ambiguity all deny
- [ ] **Data-level gating:** `inventory.view_cost_price` means cost price is never sent to an unauthorised client, not that it is sent and hidden
- [ ] Works offline from cached definitions
- [ ] Permission change invalidates cached privileged data on next sync
- [ ] Denials logged
- [ ] Cheap enough to run on every command without developers being tempted to cache it

**Depends On:** TASK-AUTH-002

**Relevant PRD Sections:** §3.5, §8

**Notes for Implementation:**
- The temptation will be to check permissions in the API route handler and trust the command beneath it. Resist. The agent (PRD-004) will call commands directly, and a command that trusts its caller is a command the agent can misuse. The check belongs *in* the command.

---

### TASK-AUTH-004: Offline Authentication & PIN Switching

**Context:** A store with no network still has staff who need to log in, and a shared device still needs to know who is using it.

**Acceptance Criteria:**
- [ ] Initial enrolment authentication
- [ ] Subsequent PIN authentication, **fully offline**
- [ ] PINs salted-hashed, never recoverable
- [ ] **Local rate limiting with escalating delay**; full re-auth required after a threshold
- [ ] Several enrolled users per device, presented as a switcher **with photos**
- [ ] Switch under five seconds
- [ ] **User switch recorded as an operation**
- [ ] Idle lock to the switcher, **preserving in-progress work** (see §6.2)
- [ ] PIN reset by store owner or main owner; audited

**Depends On:** TASK-AUTH-002

**Relevant PRD Sections:** §2, §3.2, §6.1, §6.2

---

### TASK-AUTH-005: Device Enrolment, Keys & Revocation

**Context:** A device signs operations. That key is what makes the audit trail worth anything, and a lost device is a live threat.

**Acceptance Criteria:**
- [ ] Device enrolled to tenant and store
- [ ] Signing key generated and held in platform secure storage
- [ ] Device revocation
- [ ] **Revocation does not invalidate operations signed before it** — history stays verifiable
- [ ] Device list with last-sync time, visible to store owner and main owner
- [ ] Local data at rest encrypted
- [ ] Long-unsynced devices surfaced (may be lost, broken, or holding a week of unsynced work)

**Depends On:** TASK-AUTH-001, Platform Core (operation signing)

**Relevant PRD Sections:** §3.3, §8

---

### TASK-AUTH-006: Scope & Store Switching

**Context:** A store owner with several stores moves between them; nobody sees a store they are not assigned to.

**Acceptance Criteria:**
- [ ] Store switcher for multi-store users; no logout required
- [ ] **Active store always visible** — adjusting stock in the wrong store because you didn't notice which one you were in is an interface failure
- [ ] Aggregate view across a user's stores
- [ ] Accessing an unassigned store returns a **permission error, not an empty result**
- [ ] Main owner sees all stores in their tenant and no others

**Depends On:** TASK-AUTH-003

**Relevant PRD Sections:** §3.6, §6.3

---

### TASK-AUTH-007: Role Configuration UI

**Context:** A shop owner, not a security engineer, configures who can do what.

**Acceptance Criteria:**
- [ ] Role list; role editor with permissions grouped by module
- [ ] **Plain-language descriptions of what each permission lets someone do to the business**
- [ ] `isDangerous` permissions visually distinct — granting them should feel like a decision
- [ ] Role changes audited: who granted what, to whom, when
- [ ] Deleting a role in use is blocked or forces reassignment
- [ ] Cannot remove the last tenant administrator

**Depends On:** TASK-AUTH-002

**Relevant PRD Sections:** §6.4, §7

---

### TASK-AUTH-008: Audit Attribution Fields

**Context:** Small task, large consequence. These fields must exist from the first operation ever written, because an append-only log cannot be retroactively attributed.

**Acceptance Criteria:**
- [ ] Every operation carries: acting user, device, tenant, store, timestamp
- [ ] Every operation carries `source` (ui | agent | api | system), `agentInitiated`, `agentConversationId` — **present from day one**, defaulted, even though the agent does not exist yet (ARCH-001 §9.3)
- [ ] Permission denials logged
- [ ] Role and permission changes audited

**Depends On:** TASK-AUTH-001, Platform Core

**Relevant PRD Sections:** §3.8, FR-1044
