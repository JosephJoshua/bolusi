# PRD-009: GPS & Anti-Fraud

## 1. Overview

### What this module is

A **shared service**, not a user-facing feature. Nobody opens the "GPS module." It provides location capture, geofencing, and alerting to the modules that need them — attendance (PRD-007), delivery (PRD-008), and evidence capture in repair (PRD-001).

### What this module is not

**This is not where fraud detection lives.** The analytical fraud detection — the pattern-finding that catches a cashier skimming, a technician padding parts, an owner manufacturing attendance — lives in **Reporting (PRD-005 §8, §3.10)**. That is deliberate. Fraud is found by comparing people and periods against each other over time, which is a reporting problem, not a GPS problem.

This PRD covers the narrow, concrete anti-fraud mechanisms that depend on *location and evidence*:

- Location capture and its integrity
- Geofencing and the alerts built on it
- Evidence metadata (timestamp, GPS) embedded in photos and videos
- Tamper resistance for the operation log

It is a small module. It was scoped as "GPS & Anti-Fraud" early on, when anti-fraud was expected to be a large behavioural-analysis system. It isn't — when the actual fraud vectors were enumerated with Ocep, they turned out to be either analytical (reporting) or evidentiary (this module, plus per-module controls). The name is kept for continuity; the scope is honest.

### Goals

- Provide reliable, honest location capture across the app
- Provide geofence evaluation as a service
- Embed tamper-evident metadata in all captured evidence
- Deliver the specific location-based alerts the business asked for
- Make the operation log tamper-evident, so the audit trail can be trusted
- Do all of this without turning the product into a surveillance tool

### On the last point

Every mechanism here is a form of watching employees. That is legitimate — the business is losing money to fraud and has a right to protect itself. But a system that watches more than it needs to, or that watches people who aren't working, or that presents every anomaly as an accusation, will be resented, worked around, and eventually abandoned in favour of the paper it replaced.

The design principle throughout: **capture what is needed to establish what happened, alert only where a human should look, and never track a person who is not on shift.**

---

## 2. Functional Requirements

### 2.1 Location Capture Service

- **FR-801** [Must]: A shared location service shall provide the current position on request, returning: coordinate, accuracy radius in metres, timestamp, and the provider used.
- **FR-802** [Must]: Location capture shall never block the calling flow indefinitely. It shall return the best available fix within a short timeout, or return null.
- **FR-803** [Must]: A null location shall never prevent an action from completing. An employee who cannot get a GPS fix inside a concrete building still clocked in; a driver in a valley still delivered.
- **FR-804** [Must]: Accuracy shall always be recorded alongside the coordinate. A fix accurate to 2000 metres and a fix accurate to 5 metres are not the same fact, and storing them identically destroys the ability to reason about either.
- **FR-805** [Must]: Location capture shall work offline. GPS is a satellite fix, not a network call; the only thing connectivity affects is assisted-GPS speed.
- **FR-806** [Should]: The service shall attempt to detect mock-location providers where the platform permits, and flag a location as `suspectedMocked` when detected. It shall not block the action.

### 2.2 Continuous Tracking (Delivery Runs Only)

- **FR-807** [Must]: Continuous location tracking shall be active **only** during an active delivery run.
- **FR-808** [Must]: Tracking shall cease when the run closes. There shall be no code path that tracks a user who is not on an active run.
- **FR-809** [Must]: The driver shall be informed, clearly and in-app, that they are being tracked while a run is active, and when it stops.
- **FR-810** [Must]: Sampling interval shall be configurable and shall default to a value that prioritises battery life over tracking fidelity. See PRD-008 NFR-702 — a driver whose phone dies loses proof of delivery for the rest of the run, which is a worse outcome than a coarse track.
- **FR-811** [Must]: Track points shall be buffered locally and synced when connectivity returns. A run through a dead zone is not an untracked run; it is a run whose track arrives late.

### 2.3 Geofencing

- **FR-812** [Must]: A geofence shall be defined as a coordinate and a radius.
- **FR-813** [Must]: Each store shall have a geofence, with a configurable radius (PRD-007 §3.3).
- **FR-814** [Must]: The service shall evaluate whether a given location falls inside a given geofence, accounting for the location's accuracy radius. A fix with 500m accuracy 200m outside a 100m geofence is not evidence of anything.
- **FR-815** [Must]: Geofence evaluation shall be a pure function of the location and the fence, computable offline.

### 2.4 Evidence Metadata

- **FR-816** [Must]: All media captured in the app — repair intake photos, ownership videos, QC photos, pickup photos, attendance selfies, proof-of-delivery photos and signatures — shall have embedded: capture timestamp, GPS location with accuracy, capturing user, and device identifier.
- **FR-817** [Must]: This metadata shall be captured at the moment of capture and shall be immutable thereafter.
- **FR-818** [Must]: Media shall only be capturable live through the app camera. Selecting from the device gallery shall not be possible anywhere evidence is required.
- **FR-819** [Must]: A media reference, once attached to an operation, shall not be replaceable. Correcting a photo means a new operation with a new photo and a reason, not a substitution.

### 2.5 Alerts

The business asked for a small, specific set. Do not invent more.

- **FR-820** [Must]: **Stationary driver.** An active driver, outside the store geofence, whose position has not meaningfully changed for longer than a configurable threshold (default 30 minutes), shall trigger an alert to the store owner.
- **FR-821** [Must]: **Off-site clock-in.** An attendance clock-in outside the store geofence shall be flagged and the store owner notified (PRD-007 FR-611).
- **FR-822** [Must]: **Delivery location mismatch.** A proof-of-delivery captured far from the customer's registered address shall be flagged (PRD-008 FR-720).
- **FR-823** [Must]: All alerts shall be advisory. The wording shall describe what was observed, not what it means. "Driver Yosep tidak bergerak selama 45 menit di Abepura" — not "Driver Yosep mencurigakan."
- **FR-824** [Must]: Every alert shall link to the underlying evidence.
- **FR-825** [Should]: Alert thresholds shall be configurable per store, and each alert type individually mutable.
- **FR-826** [Must]: Alerts shall account for location accuracy. An alert fired on a 2km-accuracy fix is noise, and noise trains people to ignore alerts — which is worse than having no alerts, because it degrades the ones that matter.

### 2.6 Operation Log Integrity

> The mechanism is specified in ARCH-001 §2.2. This section states what anti-fraud requires of it.

- **FR-827** [Must]: Every operation shall be cryptographically signed by the originating device and chained to its predecessor by hash.
- **FR-828** [Must]: The server shall validate signatures and chain continuity on sync, and reject operations that fail.
- **FR-829** [Must]: A break in a device's hash chain shall be detectable and shall be surfaced — it means operations were deleted, reordered, or injected.
- **FR-830** [Must]: Device clock manipulation shall be detectable: an operation whose claimed timestamp is inconsistent with its position in the chain and with its sync time shall be flagged.
- **FR-831** [Must]: No operation shall ever be deleted or edited. Corrections are new operations. This is the foundation on which every other control rests — an audit trail that can be edited is not an audit trail.

---

## 3. What This Module Does Not Do

Stated explicitly, because scope creep here is likely and expensive:

- **It does not do behavioural analysis.** Ocep was asked about this and said "not sure about this yet." Nothing should be built on an undefined requirement. The analytical fraud detection that *is* defined lives in PRD-005 §3.10.
- **It does not track employees outside active work.** No background location. No tracking of cashiers or technicians at all — they are at the store, and their clock-in already establishes that.
- **It does not block actions on location grounds.** Every location-based control flags and informs; none prevents. GPS is too unreliable, and an employee blocked from clocking in because of a bad satellite fix is a real cost paid to prevent a hypothetical fraud.
- **It does not attempt to defeat a determined GPS spoofer.** Mock-location detection is best-effort. The stronger control against a spoofed clock-in is the selfie, and against a spoofed delivery is the recipient's signature — both of which require being physically present in a way a coordinate does not.
- **It does not do facial recognition.** The attendance selfie is for a human to glance at. Automated face matching is a substantially different product with substantially different privacy and accuracy problems, and it was never asked for.

---

## 4. Non-Functional Requirements

- **NFR-801**: Location capture must not degrade battery to the point of shortening a driver's working day. This is a hard constraint, not a preference.
- **NFR-802**: All location capture works offline.
- **NFR-803**: Location data is sensitive personal data. Access is restricted: an employee sees their own; a store owner sees their store's staff during work; the main owner sees the network's. No lateral visibility between employees.
- **NFR-804**: Track data retention shall be bounded. Location history serves an operational purpose for a limited window (dispute resolution, reconciliation). Retaining a year of an employee's movements serves no operational purpose and creates a liability. See §7.
- **NFR-805**: Alerting must be low-noise. An alert stream that is mostly false positives is worse than no alerts.

---

## 5. Data Entities (Conceptual)

### LocationFix

Not a standalone entity — an embedded value on other records.

- `lat`, `lng`
- `accuracyMeters`
- `capturedAt`
- `provider` — gps | network | fused
- `suspectedMocked` — Boolean

### TrackPoint

- `id`
- `runId` — Only exists in the context of a delivery run
- `driverId`
- `location` — LocationFix
- `recordedAt`
- `syncedAt`

### Geofence

- `id`
- `scopeType` — store
- `scopeId`
- `centre` — { lat, lng }
- `radiusMeters`

### LocationAlert

- `id`
- `type` — stationary_driver | offsite_clockin | delivery_location_mismatch
- `storeId`
- `subjectUserId` — Who the alert concerns
- `observedAt`
- `location` — LocationFix
- `detail` — Type-specific supporting data
- `evidenceRef` — Link to the record that triggered it
- `status` — unread | read | dismissed
- `notifiedUserIds`

---

## 6. Edge Cases & Error States

- **No GPS fix.** Record null, flag, proceed. Never block.
- **Very poor accuracy.** Record the accuracy honestly. Suppress geofence-based alerts when accuracy exceeds the fence radius — the fix cannot distinguish inside from outside, and an alert on it is a coin flip presented as a finding.
- **Location permission denied.** The action proceeds. The absence of location is itself recorded, and a *pattern* of a user denying location permission is a signal worth surfacing to the store owner — but a single instance is not.
- **Mock location detected.** Flag, don't block. Surface the pattern.
- **Store geofence set wrongly.** Every clock-in at that store flags as off-site. This looks like network-wide fraud and is a config error. Alerts must be aggregable so that "every employee at Toko Sorong is off-site" reads as a broken geofence rather than as mass deception (PRD-007 §7).
- **Driver stationary for a legitimate reason.** Lunch. Breakdown. A customer who cannot find their money. The alert says what was observed and nothing more.
- **Device clock is wrong.** Not necessarily malicious — cheap Android devices drift, and a device that has been offline for days may have a badly wrong clock. Detect the inconsistency, flag it, and do not assume intent. A clock that is wrong by hours on a device that has been offline for three days is a battery-pull, not a conspiracy.
- **Operation chain break.** Serious. Surfaced immediately. But note that the most likely cause is a bug or a corrupted local database, not tampering — investigate before accusing.
- **Employee working outside the geofence legitimately.** A technician doing a house call, a store owner working from home. If this is common, the geofence model is wrong for that role, and forcing it produces alert fatigue. Roles that legitimately work off-site should not be geofenced at all.

---

## 7. Privacy & Retention

This section exists because a location-tracking system built without thinking about this becomes a liability, and because Indonesia has a personal data protection law (UU PDP) that applies to employee data.

- **Track only during work.** Continuous tracking exists only for active delivery runs. There is no background location. A driver who has closed their run is not tracked, full stop, and this must be true in code and not merely in policy.
- **Tell people.** Drivers are told they are tracked during runs, in the app, unambiguously. Employees are told their clock-in captures location and a photo. Covert monitoring of employees is both wrong and, under UU PDP, legally exposed.
- **Bound retention.** Track points, attendance selfies, and location fixes serve a purpose for a defined window — reconciling a run, resolving a delivery dispute, investigating an attendance question. That window is months, not years. Retention should be configurable per tenant with a sane default, and old data should actually be deleted rather than merely hidden.
  - **Exception:** evidence attached to a *transaction* — repair intake photos, proof of delivery — is part of the business record and follows the transaction's retention, not the tracking retention. A photo proving what condition a phone was in when it arrived may be needed years later if the customer sues.
- **Restrict access.** An employee's location and photograph are visible to their store owner and the main owner. They are not visible to other employees, and there is no reason for them to be.
- **Give employees their own record.** An employee can see their own attendance history and their own tracked runs. This is both a fairness point and a practical one — a driver disputing a reconciliation needs to be able to see the same evidence the owner is looking at.

**Open question for Ocep:** what retention window? Suggested default: 90 days for track points and location fixes; transaction-attached evidence follows the transaction. This is OQ-802.

---

## 8. Open Questions

- **OQ-801**: What geofence radius is right for these stores? A standalone shop might want 100m; a store in a crowded market building where GPS bounces off concrete might need 300m or more. This is likely per-store, and the first weeks of live data will answer it better than a guess now.
- **OQ-802**: Retention window for track points and location fixes? (Suggested: 90 days.)
- **OQ-803**: Ocep said "not sure yet" about behavioural analysis. Is there a specific behaviour he had in mind that isn't covered by the reporting anomaly detection (PRD-005 §3.10)? If not, this stays out of scope.
- **OQ-804**: Should technicians or cashiers ever be location-tracked? Current design says no — they are at the store and their clock-in establishes it. Confirm.
- **OQ-805**: Are there roles that legitimately work off-site (house calls, market runs) that should be exempt from geofencing entirely?

---

## 9. Claude Code Task Breakdown

### TASK-GPS-001: Location Capture Service

**Context:** The shared service every other module calls. Its most important property is that it fails gracefully — a bad fix or no fix must never block the business.

**Acceptance Criteria:**
- [ ] Returns coordinate, **accuracy radius**, timestamp, provider
- [ ] Short timeout; returns best available or null; **never blocks the calling flow**
- [ ] **Null location never prevents an action from completing**
- [ ] Accuracy always recorded — never store a coordinate without it
- [ ] Works offline
- [ ] Mock-location detection where the platform permits; flags, does not block
- [ ] Available to both desktop and mobile clients (desktop may have no GPS at all — handle it as null, not as an error)

**Depends On:** Platform Core

**Relevant PRD Sections:** §2.1

---

### TASK-GPS-002: Geofence Service

**Context:** Pure evaluation of whether a location is inside a fence, with honest handling of accuracy.

**Acceptance Criteria:**
- [ ] Geofence entity: centre and radius, per store
- [ ] Configurable radius per store
- [ ] Pure evaluation function; computable offline
- [ ] **Accounts for the location's accuracy radius** — a fix too imprecise to distinguish inside from outside returns "indeterminate", not a false verdict
- [ ] Store geofence settable by capturing the current position at the store

**Depends On:** TASK-GPS-001

**Relevant PRD Sections:** §2.3

---

### TASK-GPS-003: Evidence Metadata Embedding

**Context:** Every photo and video in the system carries where, when, who, and on what device. This is what makes the evidence worth having.

**Acceptance Criteria:**
- [ ] Timestamp, location (with accuracy), user, device embedded on every media capture
- [ ] Metadata captured at capture time and **immutable thereafter**
- [ ] **Gallery selection blocked** everywhere evidence is required — live camera only
- [ ] Media reference, once attached to an operation, **cannot be replaced**
- [ ] Applies uniformly across: repair intake photos, ownership video, QC photos, pickup photos, attendance selfies, proof-of-delivery photos, signatures

**Depends On:** TASK-GPS-001, Platform Core (media)

**Relevant PRD Sections:** §2.4

---

### TASK-GPS-004: Continuous Tracking (Delivery Runs)

**Context:** The only continuous tracking in the product. Its hardest constraint is battery, and its hardest boundary is that it must not exist outside an active run.

**Acceptance Criteria:**
- [ ] Tracking active **only** during an active delivery run
- [ ] **No code path tracks a user outside an active run**
- [ ] Driver informed in-app that tracking is active, and when it stops
- [ ] Configurable sampling interval, defaulting to battery-conservative
- [ ] Track points buffered locally; sync when connectivity returns
- [ ] Battery impact measured and within NFR-801

**Depends On:** TASK-GPS-001, PRD-008 (run lifecycle)

**Relevant PRD Sections:** §2.2, §7, NFR-801

---

### TASK-GPS-005: Location Alerts

**Context:** Three alerts. Not four. The value is in their being trusted, which means they must be quiet.

**Acceptance Criteria:**
- [ ] **Stationary driver:** active run, outside store geofence, position unchanged beyond threshold → store owner notified
- [ ] **Off-site clock-in:** attendance outside store geofence → flagged, store owner notified
- [ ] **Delivery location mismatch:** POD captured far from customer's registered address → flagged
- [ ] **Alerts suppressed when location accuracy cannot support them** (FR-826)
- [ ] **Alert wording is observational, never accusatory** — describes what was seen, not what it means
- [ ] Every alert links to its evidence
- [ ] Thresholds configurable per store; alert types individually mutable
- [ ] Alerts aggregable, so a store-wide pattern reads as a config error rather than mass fraud

**Depends On:** TASK-GPS-002, TASK-GPS-004, PRD-007, PRD-008

**Relevant PRD Sections:** §2.5, §6

---

### TASK-GPS-006: Operation Log Integrity

**Context:** The tamper-evidence underpinning every other control. If the log can be quietly edited, nothing above it means anything.

**Acceptance Criteria:**
- [ ] Every operation signed by the originating device
- [ ] Hash chain linking each operation to its predecessor
- [ ] Server validates signature and chain continuity on sync; rejects failures
- [ ] Chain breaks detected and surfaced
- [ ] Device clock inconsistency detected and flagged — **without assuming malice** (cheap devices drift; long-offline devices drift badly)
- [ ] **No deletion or edit path exists for any operation, anywhere in the codebase**

**Depends On:** Platform Core (this is arguably part of it — see ARCH-001 §2.2)

**Relevant PRD Sections:** §2.6

**Notes for Implementation:**
- This is foundational and should be built with the operation log itself, not bolted on afterwards. Retrofitting a hash chain onto an existing log means either rewriting history (which defeats the point) or having a discontinuity at the boundary (which is a permanent asterisk on the audit trail).
- Key management for device signing keys is the hard part and deserves care: how a key is provisioned when a device is enrolled, what happens when a device is lost, and how a revoked device's historical operations remain verifiable.

---

### TASK-GPS-007: Privacy Controls & Retention

**Context:** Not a feature. A constraint on every feature above, and a legal obligation under UU PDP.

**Acceptance Criteria:**
- [ ] Configurable retention window for track points and location fixes; default per OQ-802
- [ ] Retained data actually deleted at expiry, not merely hidden
- [ ] **Transaction-attached evidence exempt from tracking retention** — it follows the transaction's lifecycle
- [ ] Access control: employee sees own; store owner sees their store's; main owner sees network. **No lateral visibility between employees.**
- [ ] Employee can view their own attendance history and their own tracked runs
- [ ] In-app disclosure to drivers that runs are tracked, and to employees that clock-in captures location and photo

**Depends On:** All other TASK-GPS tasks, Auth

**Relevant PRD Sections:** §7, NFR-803, NFR-804
