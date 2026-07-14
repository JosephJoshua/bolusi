# PRD-007: HR — Attendance & Payroll

## 1. Overview

### Problem Statement

Stores need to know who showed up, when, and where. Attendance today is informal — a store owner knows their staff and notices absence — but this does not scale to a franchise, does not survive a dispute, and gives the main owner no visibility. Payroll is computed by hand.

### Scope Warning

**This PRD covers two problems of very different sizes, and they should not be built together.**

**Attendance** is a small, well-understood feature: clock in, clock out, with a location and a photo. It is a few weeks of work and it delivers immediate value.

**Payroll** is not. Indonesian payroll compliance is a large regulatory surface with mandatory social security contributions, withholding tax, statutory bonuses, region-specific minimum wages, and monthly filing deadlines with penalties for error. It is the reason a domestic HRIS industry exists (Talenta, SunFish, Kinerjio, and others). Building it correctly is plausibly comparable in effort to the repair module, and getting it wrong exposes the business to fines.

**Recommendation: build attendance in V1. Do not build payroll in V1.** See §9 for the full assessment and the alternatives. This is a scope decision for Ocep, not one Claude Code should make.

The remainder of this PRD specifies attendance fully and payroll only to the depth needed to make the scope decision.

### Goals (Attendance)

- Record who clocked in and out, when, where, and with photographic evidence
- Make fake attendance (clocking in from home, a colleague clocking in for you) difficult
- Give store owners a simple view of who is present and who is late
- Give the main owner attendance visibility across the network
- Work offline — clock-in cannot depend on connectivity

### Success Metrics

- Attendance recorded for 100% of shifts worked
- Buddy-punching and off-site clock-ins detectable from the record
- Clock-in takes under 10 seconds
- Store owner can see current presence at a glance

---

## 2. User Stories

### Attendance

- **US-601** [P0]: Sebagai karyawan, saya ingin absen masuk dan pulang dengan cepat, sehingga saya tidak membuang waktu di awal dan akhir shift.
  *(As an employee, I want to clock in and out quickly, so I don't waste time at the start and end of my shift.)*

- **US-602** [P0]: Sebagai pemilik toko, saya ingin absensi tercatat dengan lokasi dan foto, sehingga saya yakin karyawan benar-benar hadir di toko.
  *(As a store owner, I want attendance recorded with location and photo, so I'm confident the employee was actually at the store.)*

- **US-603** [P0]: Sebagai pemilik toko, saya ingin melihat siapa yang hadir hari ini dan siapa yang terlambat, sehingga saya bisa mengelola shift.
  *(As a store owner, I want to see who is present today and who is late, so I can manage shifts.)*

- **US-604** [P1]: Sebagai pemilik toko, saya ingin melihat rekap kehadiran per karyawan per periode, sehingga saya punya dasar untuk penggajian dan evaluasi.
  *(As a store owner, I want to see an attendance summary per employee per period, so I have a basis for payroll and evaluation.)*

- **US-605** [P1]: Sebagai karyawan, saya ingin mengajukan izin atau cuti, sehingga ketidakhadiran saya tercatat sebagai sah, bukan mangkir.
  *(As an employee, I want to request leave, so my absence is recorded as authorized rather than as absenteeism.)*

- **US-606** [P1]: Sebagai pemilik toko, saya ingin menyetujui atau menolak pengajuan izin, sehingga saya mengendalikan jadwal.
  *(As a store owner, I want to approve or reject leave requests, so I control the schedule.)*

- **US-607** [P1]: Sebagai pemilik toko, saya ingin mengoreksi absensi yang salah (misalnya karyawan lupa absen pulang), sehingga catatan tetap akurat.
  *(As a store owner, I want to correct erroneous attendance (e.g., an employee forgot to clock out), so records stay accurate.)*

### Employee Records

- **US-608** [P0]: Sebagai pemilik toko, saya ingin mengelola data karyawan (nama, kontak, jabatan, toko, tanggal masuk), sehingga saya punya catatan kepegawaian.
  *(As a store owner, I want to manage employee data (name, contact, role, store, start date), so I have personnel records.)*

- **US-609** [P1]: Sebagai pemilik utama, saya ingin melihat daftar seluruh karyawan di jaringan, sehingga saya tahu siapa bekerja di mana.
  *(As the main owner, I want to see all employees across the network, so I know who works where.)*

---

## 3. Functional Requirements — Attendance

### 3.1 Employee Records

- **FR-601** [Must]: An Employee record shall exist for each person working at a store, with: name, contact number, role, assigned store(s), start date, status (active/inactive).
- **FR-602** [Must]: An Employee is distinct from a User account. A person has one employee record and one user account, linked. (Historically the system permitted shared generic logins; individual accounts are now the design — see ARCH-001 §4.1 — but the entities remain distinct because an employee may exist before a login is issued, and a login may be deactivated while the employee record persists for historical attendance.)
- **FR-603** [Must]: Employee records are created by the store owner or main owner. Employees do not self-register.
- **FR-604** [Should]: An employee may be assigned to more than one store.

### 3.2 Clock In / Clock Out

- **FR-605** [Must]: An employee shall clock in at the start of a shift and clock out at the end.
- **FR-606** [Must]: Clock-in shall capture: timestamp, GPS location with accuracy radius, and a selfie taken in-app.
- **FR-607** [Must]: The selfie shall be captured live through the app camera. Selecting an existing photo from the gallery shall not be possible.
- **FR-608** [Must]: Clock-out shall capture the same: timestamp, location, selfie.
- **FR-609** [Must]: Clock-in shall work offline. The record is queued and synced later. Attendance cannot depend on connectivity — a store with no signal still has staff who showed up.
- **FR-610** [Must]: The system shall record the distance between the clock-in location and the store's registered location.
- **FR-611** [Must]: A clock-in outside the store's geofence radius shall be permitted but flagged, and the store owner notified. It shall not be blocked — GPS is unreliable indoors, and a blocked clock-in punishes an employee for a hardware failure.
- **FR-612** [Should]: The geofence radius shall be configurable per store, since a store in a dense market building needs a different tolerance than a standalone shop.
- **FR-613** [Must]: If GPS is unavailable entirely, clock-in shall still succeed, recorded with no location and flagged as such.

### 3.3 Store Location

- **FR-614** [Must]: Each store shall have a registered GPS location, set by the main owner or store owner.
- **FR-615** [Should]: The store location may be set by standing at the store and capturing the current position, rather than by entering coordinates.

### 3.4 Lateness & Schedule

- **FR-616** [Should]: Each store shall have configurable expected working hours (open time, close time), optionally per day of week.
- **FR-617** [Should]: A clock-in after the expected start time shall be marked late, with the lateness duration recorded.
- **FR-618** [Could]: Per-employee schedules (rather than per-store) shall be supported for stores running shifts.
- **FR-619** [Must]: Lateness is recorded, not penalized. The system does not compute deductions. Whether lateness has consequences is a management decision, not a software one.

### 3.5 Presence View

- **FR-620** [Must]: The store owner shall see, for today: who has clocked in, at what time, whether they were late, and who has not yet arrived.
- **FR-621** [Must]: Each attendance record shall be tappable to view the selfie and the location.
- **FR-622** [Should]: The main owner shall see presence across all stores.

### 3.6 Attendance History & Correction

- **FR-623** [Must]: Attendance history shall be viewable per employee, per store, over a selectable period.
- **FR-624** [Must]: Summary per employee per period: days present, days absent, days late, total hours.
- **FR-625** [Must]: The store owner shall be able to correct an attendance record (e.g., a missing clock-out).
- **FR-626** [Must]: A correction shall never overwrite the original. The original record stands; the correction is a separate, linked record with a reason and the correcting user. (Attendance records are operations, and operations are append-only — see ARCH-001 §2.2.)
- **FR-627** [Must]: Corrected records shall be visibly marked as corrected in all views.
- **FR-628** [Must]: Correction volume per store owner is reportable. A store owner who frequently "corrects" attendance is either running a badly-configured store or manufacturing hours.

### 3.7 Leave

- **FR-629** [Should]: An employee shall be able to submit a leave request with: type (sick, personal, other), date range, reason.
- **FR-630** [Should]: The store owner shall approve or reject leave requests.
- **FR-631** [Should]: Approved leave shall mark the affected days as authorized absence rather than absenteeism in attendance summaries.
- **FR-632** [Won't]: The system shall not track leave balances or entitlements in V1. Indonesian leave entitlement rules are part of the payroll compliance surface (§9) and are out of scope until that decision is made.

### 3.8 Missing Clock-Out

- **FR-633** [Must]: A shift with a clock-in but no clock-out past a configurable threshold shall be flagged for the store owner.
- **FR-634** [Should]: The employee shall be prompted on next app open if they have an unclosed shift.
- **FR-635** [Must]: The system shall not auto-close a shift by inventing a clock-out time. It flags it and requires a human correction, because an invented time is a false record.

---

## 4. Non-Functional Requirements

- **NFR-601**: Clock-in completes in under 10 seconds including selfie capture.
- **NFR-602**: Clock-in works fully offline including camera and GPS capture. The record queues for sync.
- **NFR-603**: Selfies are compressed for a 2GB-RAM device and a slow connection. Face must remain identifiable; resolution beyond that is waste.
- **NFR-604**: GPS capture must not block clock-in on a slow fix. Capture the best available position within a short timeout and record its accuracy; a low-accuracy fix with an honest accuracy radius is more useful than a delayed clock-in.
- **NFR-605**: Attendance data is sensitive personal data — location and photographs of a person. It must be permission-gated: an employee sees their own record; a store owner sees their store's; the main owner sees the network's. No employee sees another employee's selfies or locations.
- **NFR-606**: Indonesian and English.

---

## 5. Data Entities (Conceptual)

### Employee

- `id`
- `tenantId`
- `userId` — Linked user account (nullable — an employee may exist before a login is issued)
- `name`, `contactNumber`
- `role` — Reference to the role definition (Auth module)
- `storeIds` — One or more
- `startDate`, `endDate`
- `status` — active | inactive

### AttendanceRecord

- `id`
- `employeeId`, `storeId`
- `type` — clock_in | clock_out
- `timestamp` — When the employee acted
- `location` — { lat, lng, accuracyMeters } | null
- `distanceFromStoreMeters` — Computed at capture
- `outsideGeofence` — Boolean
- `selfieRef` — Media reference
- `isLate` — Boolean, and `latenessMinutes` (for clock_in)
- `deviceId`
- `correctionOf` — Reference to the record this corrects, if any
- `correctionReason`, `correctedBy` — If this is a correction
- `createdAt`

### StoreSchedule

- `storeId`
- `expectedOpenTime`, `expectedCloseTime` — Optionally per weekday
- `geofenceRadiusMeters`
- `lateThresholdMinutes` — Grace period before "late"

### LeaveRequest

- `id`
- `employeeId`, `storeId`
- `type` — sick | personal | other
- `startDate`, `endDate`
- `reason`
- `status` — pending | approved | rejected
- `decidedBy`, `decidedAt`, `decisionNote`
- `submittedAt`

---

## 6. UI/UX Flows

### 6.1 Clock In

The single most-repeated interaction for a shop-floor employee, and it should be one screen and one tap.

On opening the app, if the employee has not clocked in and the store is within expected hours, the clock-in prompt is the first thing they see. One large button: "Absen Masuk."

Tapping it opens the camera in selfie mode. It takes the photo, captures GPS in the background, and records. Done. No form, no confirmation, no dropdown.

If GPS places them outside the geofence, the record still succeeds, and they see a neutral note: "Lokasi kamu agak jauh dari toko" — not an accusation, not a block. The store owner sees the flag; the employee is not interrogated by a machine.

### 6.2 Clock Out

Same interaction, inverted. The clock-out prompt appears when they have an open shift.

### 6.3 Presence (Store Owner)

A single list for today. Each row: employee name, clock-in time, late marker if applicable, and a small thumbnail of the selfie. Employees who have not arrived sit at the bottom, greyed.

Tapping a row shows the full selfie and a map pin of where they clocked in.

**Design note:** the selfie thumbnail on the list is deliberate. The entire fraud-prevention value of the selfie is that someone glances at it. If it takes a tap to see, nobody looks, and the feature becomes theatre. It has to be visible without effort.

### 6.4 Attendance History

Per employee, per period. Days present, late, absent. A calendar or list view. Rows tappable to the individual record.

### 6.5 Correction

A store owner opens an attendance record and corrects it. The correction requires a reason. The original stays visible, struck through, with the correction below it. Both are permanently in the record.

### 6.6 Leave

Employee: pick dates, pick type, write a reason, submit.

Store owner: a pending list, approve or reject with an optional note.

---

## 7. Edge Cases & Error States

- **Employee forgets to clock out.** Flagged after a threshold. Prompted on next open. Store owner corrects. Never auto-closed with a fabricated time.
- **Employee clocks in twice.** The second is rejected with a clear message, or treated as a correction — but a shift has one clock-in.
- **Phone has no GPS fix indoors.** Common in a concrete market building. Record with no location, flag it, do not block. If this happens constantly at a store, the geofence tolerance or the store's registered position is wrong, and the pattern will show it.
- **Employee works at two stores in one day.** Two shifts, two clock-ins, two clock-outs, at different stores. The data model supports it; the UI must not assume one shift per day.
- **Employee's phone is dead / broken.** They cannot clock in. The store owner records it as a correction with a reason. This is a legitimate use of correction, which is exactly why correction volume must be reported rather than merely permitted — the same mechanism that handles a dead phone can manufacture a full day's attendance.
- **Selfie is unrecognizable (dark, blurred, thumb over lens).** Record succeeds. The photo is evidence, not a gate. A store owner reviewing a wall of unusable selfies will draw their own conclusion.
- **Clock-in synced days late.** The timestamp is when the employee acted, not when it synced. This must be preserved — a record that arrives late is not a record that happened late.
- **Two devices, same employee.** The employee clocks in on one and out on the other. Fine. The shift belongs to the employee, not the device.
- **Store's registered location is wrong.** Every clock-in is flagged as outside the geofence. This looks like mass fraud and is actually a config error. The presence view should make a store-wide pattern of geofence flags visually obvious, so it reads as a config problem rather than as everybody cheating.

---

## 8. Fraud Prevention Measures

Attendance fraud is small-value and high-frequency, and it corrodes trust.

- **Buddy punching** — one employee clocks in for another. The selfie is the countermeasure, and it only works if someone looks at it, which is why it appears as a thumbnail in the presence list rather than behind a tap.
- **Clocking in from home** — GPS distance from the store, recorded on every clock-in, flagged when outside the geofence.
- **GPS spoofing** — a mock-location app makes GPS worthless. Detection of mock-location providers should be attempted where the platform permits it, and a spoofed location flagged. This is an arms race and should not be over-invested in; the selfie is the stronger signal, because faking a selfie at the right place and time is genuinely harder than faking a coordinate.
- **Manufactured attendance via correction** — the store owner "corrects" a no-show into a full day. The countermeasure is not to restrict corrections (they are necessary) but to report them: correction volume per store owner, visible to the main owner. This is the fraud vector most likely to matter at scale, because it is committed by the person the system otherwise trusts.
- **Timestamp tampering** — device clock manipulation. Operations are signed and hash-chained (ARCH-001 §2.2); a record whose device timestamp is wildly inconsistent with its sync time and its position in the chain is detectable.

**Note on proportionality:** attendance fraud costs a store a few hundred thousand rupiah. Cash theft at POS costs more. The controls here should be light enough that honest employees are not treated as suspects for the sake of a small loss — a system that makes an employee feel surveilled every morning has a cost too, and it is paid in the willingness of good staff to stay.

---

## 9. Payroll — Scope Assessment

**This section is a recommendation, not a specification.** Payroll is not specified here because it should not be built in V1, and specifying it would imply otherwise.

### What Indonesian payroll actually requires

A compliant payroll system for Indonesian employees must handle, at minimum:

**Mandatory social security (BPJS), split employer/employee, with caps:**
- **BPJS Kesehatan** (health): total 5% of salary — 4% employer, 1% employee — calculated against a salary cap of Rp 12,000,000 per month.
- **BPJS Ketenagakerjaan** (employment) across several programs with separate rates:
  - **JHT** (old-age savings): 2% employee, ~3.7% employer
  - **JP** (pension): 1% employee, 2% employer, against a separate wage ceiling that is indexed annually (~Rp 9.56M for 2026)
  - **JKK** (work accident): employer only, 0.24%–1.74% depending on the risk classification of the work
  - **JKM** (death benefit): employer only
- Employee-side deductions total roughly 4% of monthly salary; employer-side contributions run roughly 7–8% on top of it.

**Withholding tax (PPh 21):** computed monthly using the *Tarif Efektif Rata-rata* (effective average rate) method under PMK 168/2023, then reconciled annually against progressive rates. Each employee must receive an annual Form 1721. Employers and employees must hold NPWP.

**Statutory bonus (THR):** a religious holiday allowance equal to one month's salary, mandatory, paid before the employee's major religious holiday. Its tax treatment is a common source of error.

**Regional minimum wage:** salaries must meet or exceed the local minimum, which is revised annually and varies by province and city.

**Overtime:** calculated by statutory formula.

**Filing deadlines with penalties:** BPJS Kesehatan by the 10th of the following month, BPJS Ketenagakerjaan by the 15th. Late payment attracts interest and administrative sanctions. PPh 21 is reported monthly through CoreTax.

**All-in cost:** an Indonesian employee typically costs 115–118% of stated gross salary once these are included.

### Why this should not be in V1

1. **It is a compliance product, not a feature.** The rates, ceilings, and methods change — PMK 168/2023 changed the tax method; the JP ceiling is re-indexed annually; minimum wages are revised every year. A payroll module is not something you build once; it is something you maintain forever, and it breaks loudly and expensively when you don't.

2. **The failure mode is fines, not bugs.** A repair ticket with a wrong status annoys someone. A payroll run with a wrong BPJS calculation creates a liability with 2%-per-month interest, and the exposure compounds across every employee and every month it goes unnoticed.

3. **It is not the problem you are solving.** The repair shops' pain is repair tracking, inventory, cash, and fraud. Payroll is a pain, but it is a *generic* pain, and it is one that established Indonesian HRIS vendors already solve.

4. **The effort is comparable to the repair module.** Contributions with multiple ceilings, risk-classified rates, a tax method that changes, a statutory bonus with its own tax treatment, region-varying minimum wage, and monthly filing. That is a quarter of engineering work at minimum, and it competes directly with the six-month deadline for everything else.

5. **It is a SaaS liability.** For the family business, a mistake is an internal problem. For a hundred SaaS tenants, a systematic payroll bug is a hundred businesses with tax exposure, and the vendor's problem.

### The alternatives, in order of preference

**A. Attendance only, no payroll (recommended for V1).**
The system records attendance accurately and exports a clean summary — days worked, hours, lateness, authorized leave — that the business feeds into whatever they use today. This delivers the operational value (knowing who worked) without the compliance surface. It is a few weeks of work.

**B. Attendance plus a simple, explicitly non-compliant wage calculation.**
For stores paying a flat monthly wage with no formal employment (which is likely the reality for many small West Papuan repair shops), a simple "days worked × daily rate" calculation is genuinely useful and carries no compliance claim. This must be labelled unambiguously as *not* a payroll system and must not compute BPJS or PPh 21 at all — a half-compliant calculation is worse than none, because it implies a correctness it does not have.

**C. Integrate an existing Indonesian payroll provider.**
Export attendance to, or integrate with, an established HRIS. The compliance burden sits with the specialist. This is the right long-term answer for the SaaS product.

**D. Build full payroll.**
Only if payroll turns out to be a primary reason customers would buy the SaaS — and that is a question to answer with customers, not in a PRD. If the answer is yes, it deserves its own PRD, its own timeline, and probably a specialist adviser.

### Open questions for Ocep

- **OQ-601**: Are the stores' employees formally employed (with BPJS registration, NPWP, formal contracts), or is this informal cash employment? This single answer determines whether the payroll problem is a compliance problem or an arithmetic problem.
- **OQ-602**: How is payroll done today? By hand? By an accountant? By an existing HRIS?
- **OQ-603**: Would MSMEs buy the SaaS *for* payroll, or is payroll a checkbox they'd expect but not choose on?
- **OQ-604**: Which alternative above — A, B, C, or D?

**Caveat:** the figures above were verified in mid-2026 and Indonesian payroll regulation changes annually. Nothing here should be relied on as advice; a specialist should confirm before anything is built.

---

## 10. Claude Code Task Breakdown

> Attendance only. Payroll tasks are deliberately absent pending the §9 scope decision.

### TASK-HR-001: Employee Records

**Context:** The personnel record, distinct from but linked to the user account.

**Acceptance Criteria:**
- [ ] Employee entity per §5, with multi-store assignment
- [ ] Link to user account, nullable
- [ ] Created by store owner or main owner only; no self-registration
- [ ] Active/inactive status; inactive employees retain their attendance history
- [ ] Main owner sees network-wide employee list; store owner sees their store(s)

**Depends On:** Auth module

**Relevant PRD Sections:** §3.1

---

### TASK-HR-002: Store Location & Schedule Configuration

**Context:** The geofence and the expected hours that lateness is measured against.

**Acceptance Criteria:**
- [ ] Store GPS location, settable by capturing current position rather than typing coordinates
- [ ] Configurable geofence radius per store
- [ ] Expected open/close times, optionally per weekday
- [ ] Configurable late-threshold grace period

**Depends On:** TASK-HR-001

**Relevant PRD Sections:** §3.3, §3.4

---

### TASK-HR-003: Clock In / Clock Out

**Context:** The core attendance interaction. One tap, one selfie, done — and it must work with no signal.

**Acceptance Criteria:**
- [ ] Clock-in captures timestamp, GPS (with accuracy radius), live selfie
- [ ] Selfie must be captured in-app; gallery selection is not possible
- [ ] Distance from store computed and stored; outside-geofence flagged
- [ ] Outside-geofence clock-in is permitted, never blocked
- [ ] GPS unavailable → clock-in still succeeds, recorded with null location and flagged
- [ ] GPS acquisition does not block on a slow fix; short timeout, record best available with its accuracy
- [ ] Works fully offline; queues for sync
- [ ] Timestamp is when the employee acted, preserved through late sync
- [ ] Duplicate clock-in rejected with a clear message
- [ ] Completes in under 10 seconds
- [ ] Lateness computed against store schedule and recorded

**Depends On:** TASK-HR-001, TASK-HR-002, Platform Core (media capture, offline queue)

**Relevant PRD Sections:** §3.2, §6.1, §6.2, NFR-601–604

---

### TASK-HR-004: Presence View

**Context:** The store owner's daily glance at who is here.

**Acceptance Criteria:**
- [ ] Today's list: present employees with clock-in time and late marker; absent employees greyed at the bottom
- [ ] **Selfie thumbnail visible in the list row** — not behind a tap (see §6.3 design note)
- [ ] Tap a row for the full selfie and a map pin of the clock-in location
- [ ] Geofence flags visually obvious, and a store-wide pattern of them reads as a config problem
- [ ] Main owner can view presence across all stores

**Depends On:** TASK-HR-003

**Relevant PRD Sections:** §3.5, §6.3

---

### TASK-HR-005: Attendance History & Summary

**Context:** The record over time, and the summary that feeds whatever the business uses for pay.

**Acceptance Criteria:**
- [ ] History per employee, per store, over a selectable period
- [ ] Summary: days present, absent, late, total hours, authorized leave
- [ ] Multi-store-in-one-day handled correctly (do not assume one shift per day)
- [ ] Records tappable to detail
- [ ] Exportable summary (this is the handoff to whatever payroll process exists today — see §9 alternative A)

**Depends On:** TASK-HR-003

**Relevant PRD Sections:** §3.6, §9

---

### TASK-HR-006: Attendance Correction

**Context:** Necessary, and simultaneously the most dangerous feature in this module — the same mechanism that fixes a dead phone can manufacture a week of attendance.

**Acceptance Criteria:**
- [ ] Store owner can correct a record
- [ ] Reason mandatory
- [ ] Correction never overwrites; original preserved and visible, correction linked
- [ ] Corrected records visibly marked as such in every view
- [ ] Missing clock-out flagged after threshold; employee prompted on next open
- [ ] **System never auto-closes a shift with an invented time**
- [ ] Correction volume per store owner surfaced to reporting (PRD-005)

**Depends On:** TASK-HR-003

**Relevant PRD Sections:** §3.6, §3.8, §8

---

### TASK-HR-007: Leave Requests

**Context:** Distinguishing authorized absence from absenteeism.

**Acceptance Criteria:**
- [ ] Employee submits: type, date range, reason
- [ ] Store owner approves or rejects with optional note
- [ ] Approved leave marks affected days as authorized in summaries
- [ ] **No leave balance or entitlement tracking** — out of scope pending §9

**Depends On:** TASK-HR-001

**Relevant PRD Sections:** §3.7

---

### TASK-HR-008: Attendance Fraud Signals

**Context:** Feed the reporting module the signals that make attendance fraud visible.

**Acceptance Criteria:**
- [ ] Outside-geofence clock-in rate per employee
- [ ] Correction volume per store owner
- [ ] Mock-location detection where the platform permits, flagged (best-effort; do not over-invest — see §8)
- [ ] Missing-clock-out rate per employee
- [ ] Signals exposed to PRD-005 reporting, not surfaced as accusations in the HR UI

**Depends On:** TASK-HR-003, TASK-HR-006, Reporting module

**Relevant PRD Sections:** §8
