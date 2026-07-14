# PRD-001: Repair Lifecycle

## 1. Overview

### Problem Statement

Phone repair franchise stores in West Papua, Indonesia currently manage repair workflows via WhatsApp and manual tracking. This leads to lost repair tickets, unverifiable device conditions at intake, pricing disputes with customers, no audit trail for parts consumption, and zero visibility for the franchise owner across stores.

### Goals

- Provide a complete digital workflow from customer walk-in to device pickup
- Capture tamper-proof evidence of device condition at intake (photos, video)
- Support the common "one-sitting" flow where intake, diagnosis, and quoting happen in a single interaction
- Enable transparent, auditable pricing with a log-based price model
- Support configurable warranty terms per repair
- Auto-flag abandoned devices
- Integrate with GSMArena for device identification
- Work fully offline with eventual sync to cloud

### Success Metrics

- 100% of repairs have digital evidence captured at intake
- Average intake-to-receipt time under 10 minutes for one-sitting flow
- Zero pricing disputes attributable to missing documentation
- All stores visible in owner's reporting dashboard within 24 hours of sync

---

## 2. User Stories

### Intake & Diagnosis

- **US-001** [P0]: Sebagai kasir, saya ingin mendaftarkan perangkat pelanggan untuk servis dengan mengambil foto 6-sudut dan info perangkat, sehingga kondisi perangkat terdokumentasi sebelum diperbaiki.
  *(As a cashier, I want to register a customer's device for repair with 6-angle photos and device info, so that the device condition is documented before repair.)*

- **US-002** [P0]: Sebagai kasir/teknisi, saya ingin langsung mendiagnosis perangkat dan memberikan estimasi harga dalam satu alur, sehingga pelanggan bisa langsung mendapatkan struk estimasi tanpa harus menunggu.
  *(As a cashier/technician, I want to immediately diagnose the device and give a price estimate in one flow, so the customer can get a receipt without waiting.)*

- **US-003** [P1]: Sebagai kasir, saya ingin mencari model perangkat melalui IMEI atau nama model dan mendapatkan spesifikasi otomatis dari GSMArena, sehingga identifikasi perangkat lebih cepat dan akurat.
  *(As a cashier, I want to search for a device model via IMEI or model name and get auto-populated specs from GSMArena, so device identification is faster and more accurate.)*

- **US-004** [P0]: Sebagai kasir, saya ingin mengambil video kepemilikan untuk jenis kerusakan tertentu (misalnya unlock HP), sehingga kami memiliki bukti bahwa pelanggan adalah pemilik sah.
  *(As a cashier, I want to capture an ownership video for certain damage types (e.g., phone unlock), so we have proof the customer is the rightful owner.)*

### Pricing

- **US-005** [P0]: Sebagai kasir/teknisi, saya ingin memberikan estimasi harga yang terdiri dari item-item terpisah (suku cadang + jasa), sehingga pelanggan bisa melihat rincian biaya.
  *(As a cashier/technician, I want to give a price estimate consisting of separate line items (parts + labor), so the customer can see a cost breakdown.)*

- **US-006** [P0]: Sebagai teknisi, saya ingin menambah atau mengurangi item harga selama perbaikan (misalnya ditemukan kerusakan baru) dengan alasan, sehingga perubahan harga tercatat dan bisa dikonfirmasi ke pelanggan.
  *(As a technician, I want to add or subtract price items during repair (e.g., new damage found) with a reason, so price changes are logged and can be confirmed with the customer.)*

### Repair Execution

- **US-007** [P0]: Sebagai teknisi, saya ingin mengambil tiket perbaikan dari antrian dan menandainya sebagai sedang dikerjakan, sehingga toko tahu siapa yang menangani setiap perbaikan.
  *(As a technician, I want to pick up a repair ticket from the queue and mark it as in-progress, so the store knows who is handling each repair.)*

- **US-008** [P0]: Sebagai teknisi, saya ingin mencatat suku cadang yang saya gunakan dalam perbaikan, sehingga inventaris otomatis berkurang dan biaya tercatat.
  *(As a technician, I want to record parts I use in a repair, so inventory is automatically decremented and costs are recorded.)*

- **US-009** [P1]: Sebagai teknisi, saya ingin menandai perbaikan yang memerlukan suku cadang yang belum tersedia, sehingga bagian purchasing bisa melakukan pengadaan.
  *(As a technician, I want to flag a repair that needs parts not yet available, so purchasing can procure them.)*

### Quality Check & Pickup

- **US-010** [P0]: Sebagai teknisi/manajer, saya ingin melakukan quality check sebelum perangkat dikembalikan ke pelanggan, sehingga kami memastikan perbaikan berhasil.
  *(As a technician/manager, I want to do a quality check before the device is returned, so we ensure the repair was successful.)*

- **US-011** [P0]: Sebagai kasir, saya ingin memproses penyerahan perangkat ke pelanggan dengan foto dan tanda tangan, sehingga ada bukti bahwa pelanggan telah menerima perangkat.
  *(As a cashier, I want to process device handover with a photo and signature, so there is proof the customer received the device.)*

- **US-012** [P0]: Sebagai kasir, saya ingin menerima pembayaran sisa saat pickup, sehingga transaksi selesai.
  *(As a cashier, I want to receive remaining payment at pickup, so the transaction is complete.)*

### Warranty

- **US-013** [P1]: Sebagai kasir, saya ingin mendaftarkan klaim garansi yang terkait dengan perbaikan sebelumnya, sehingga perbaikan ulang tercatat dan biayanya disesuaikan (gratis/diskon).
  *(As a cashier, I want to register a warranty claim linked to a previous repair, so the re-repair is recorded and cost-adjusted (free/discounted).)*

- **US-014** [P1]: Sebagai manajer toko, saya ingin menentukan apakah klaim garansi valid, sehingga kami tidak menanggung biaya perbaikan yang bukan tanggung jawab kami.
  *(As a store manager, I want to determine if a warranty claim is valid, so we don't bear costs for repairs that aren't our responsibility.)*

### Monitoring

- **US-015** [P0]: Sebagai pemilik toko, saya ingin melihat semua tiket perbaikan di toko saya beserta statusnya, sehingga saya bisa memantau operasional.
  *(As a store owner, I want to see all repair tickets in my store with their statuses, so I can monitor operations.)*

- **US-016** [P1]: Sebagai pemilik utama, saya ingin melihat tiket perbaikan dari semua toko, sehingga saya bisa memantau performa seluruh jaringan.
  *(As the main owner, I want to see repair tickets from all stores, so I can monitor the performance of the entire network.)*

### Printing

- **US-017** [P0]: Sebagai kasir, saya ingin mencetak struk perbaikan (untuk toko dan pelanggan) yang berisi info pelanggan, info perangkat, checklist kondisi, estimasi harga, tanggal estimasi selesai, dan syarat garansi.
  *(As a cashier, I want to print a repair receipt (store + customer copy) containing customer info, device info, condition checklist, price estimate, estimated completion date, and warranty terms.)*

---

## 3. Functional Requirements

### 3.1 Repair Intake

- **FR-001** [Must]: System shall support creating a repair ticket through a single combined form covering customer info, device info, condition assessment, evidence capture, diagnosis, and initial quote.
- **FR-002** [Must]: System shall require 6-angle photos for ALL repairs. The 6 angles shall be defined globally by the main owner.
- **FR-003** [Must]: System shall support configurable evidence requirements per damage type. For example, ownership video may be required for "phone unlock" but not for "screen replacement." Damage types are managed globally by the main owner.
- **FR-004** [Must]: System shall allow the cashier to search for a device by model name or IMEI, and auto-populate device specifications (model, brand, screen size, release year, etc.) from GSMArena.
- **FR-005** [Must]: System shall capture a condition checklist at intake. The checklist items (e.g., "screen scratches," "power button works," "speaker works") shall be managed globally by the main owner.
- **FR-006** [Must]: System shall record peripherals handed in with the device (e.g., charger, case, SIM card).
- **FR-007** [Must]: System shall allow entry of customer information (name, phone number) or selection of an existing customer.
- **FR-008** [Should]: System shall fall back to manual device info entry if GSMArena lookup fails or device is not found.
- **FR-009** [Should]: System shall embed timestamp and GPS location metadata in all captured photos and videos.

### 3.2 Pricing Model

- **FR-010** [Must]: Repair pricing shall be an append-only log of price entries. Each entry has: type (parts/labor/discount/adjustment), description, amount (+/−), and reason.
- **FR-011** [Must]: The total repair price shall always be the sum of all price log entries.
- **FR-012** [Must]: Initial price entries are created during the one-sitting intake flow.
- **FR-013** [Must]: Subsequent price entries (mid-repair additions, discoveries, discounts) can be added at any point before pickup. Each addition after the initial quote shall be flagged as requiring customer confirmation.
- **FR-014** [Must]: Each price log entry shall record who created it, when, and the reason.
- **FR-015** [Should]: Price increases that require customer confirmation shall be trackable — the cashier records whether the customer accepted or the store owner decided.

### 3.3 Repair Queue & Assignment

- **FR-016** [Must]: Technicians shall be able to view a queue of unassigned repair tickets at their store and self-assign tickets to themselves.
- **FR-017** [Must]: System shall track which technician is assigned to each repair and when they started.
- **FR-018** [Should]: A repair ticket can be reassigned to a different technician (e.g., if the original technician is unavailable).

### 3.4 Repair Execution

- **FR-019** [Must]: Technicians shall be able to record parts consumed during repair. Each part consumption shall reference a SKU from inventory and a quantity.
- **FR-020** [Must]: Parts consumption shall automatically decrement store inventory (via integration with the Inventory module).
- **FR-021** [Must]: Technicians shall be able to update the repair status through defined states (see §5 Data Entities for state machine).
- **FR-022** [Must]: When new issues are discovered mid-repair, the technician shall be able to add new price entries to the price log with a reason.
- **FR-023** [Should]: Technicians shall be able to flag a repair as "waiting for parts" when required parts are out of stock, which triggers a notification or flag visible to the purchasing role.

### 3.5 Quality Check

- **FR-024** [Must]: Before a repair can be marked as "ready for pickup," a quality check must be completed. The QC checklist shall be configurable globally by the main owner.
- **FR-025** [Should]: QC shall include capturing "after" photos to compare with "before" (intake) photos.
- **FR-026** [Should]: If QC fails, the repair shall be sent back to "in repair" status with notes on what failed.

### 3.6 Pickup & Handover

- **FR-027** [Must]: At pickup, the cashier shall capture a photo of the customer receiving the device.
- **FR-028** [Must]: At pickup, the customer shall provide a signature (digital, on-screen).
- **FR-029** [Must]: At pickup, the cashier shall process any remaining payment. If the customer made a partial payment (down payment) earlier, the system shall show the remaining balance.
- **FR-030** [Must]: Payment processing at pickup shall support multiple payment methods and split payments (integration with POS/Finance modules).
- **FR-031** [Must]: After pickup, the repair ticket status becomes "completed" and cannot be modified except via warranty claims.

### 3.7 Warranty

- **FR-032** [Must]: Each repair shall have a configurable warranty period (in days). Default warranty days are set by the main owner but can be overridden per repair.
- **FR-033** [Must]: A warranty claim shall create a new repair ticket linked to the original repair.
- **FR-034** [Must]: Warranty repairs shall follow the same flow as regular repairs but with price adjustments (free or discounted). The store manager determines whether a warranty claim is valid.
- **FR-035** [Should]: System shall alert/indicate when a repair is still within warranty period.

### 3.8 Abandoned Devices

- **FR-036** [Must]: System shall automatically flag repair tickets as "potentially abandoned" after a configurable number of days (set by main owner) past the "ready for pickup" date.
- **FR-037** [Must]: Abandoned flags shall be visible to the store owner.
- **FR-038** [Won't]: System shall NOT automatically dispose of or take ownership of abandoned devices. Flagging only.

### 3.9 Printing

- **FR-039** [Must]: System shall generate and print a repair order receipt at the end of the one-sitting intake flow. The receipt shall include: customer info, device info, condition checklist summary, list of peripherals, initial price estimate (breakdown), estimated completion date, warranty terms, store info.
- **FR-040** [Must]: Repair order receipts shall be printable on both thermal printers and standard printers (A4/A5).
- **FR-041** [Must]: Both a store copy and a customer copy shall be generated.
- **FR-042** [Should]: Receipts shall include a QR code or ticket number for easy lookup.

### 3.10 Notifications

- **FR-043** [Should]: When a repair is marked "ready for pickup," the system shall generate a WhatsApp notification link for the cashier to send to the customer. If a free automated approach is available, use it.
- **FR-044** [Should]: When a mid-repair price increase is logged, the system shall generate a WhatsApp message link for the cashier to inform the customer.

---

## 4. Non-Functional Requirements

- **NFR-001**: All repair data (ticket, evidence, price log) must be fully functional offline. Data syncs to cloud when connectivity is available.
- **NFR-002**: Photo and video capture must work without network connectivity. Media is queued for upload and synced in the background.
- **NFR-003**: The one-sitting intake form must be completable in under 10 minutes for a typical repair.
- **NFR-004**: The app must run on low-end Android devices (2GB RAM, 32GB storage). Photo compression and video duration limits should be enforced.
- **NFR-005**: All operations must be recorded as signed, append-only operations for audit integrity (see Architecture Context doc).
- **NFR-006**: UI must be in Indonesian (Bahasa Indonesia) with English toggle.
- **NFR-007**: Built-in onboarding flow for first-time users (role-specific: cashier sees intake + pickup flow, technician sees repair queue + parts consumption).

---

## 5. Data Entities (Conceptual)

### RepairTicket

- `id` — Unique identifier
- `storeId` — Which store this repair belongs to
- `customerId` — Reference to Customer entity
- `status` — Current state (see state machine below)
- `device` — Device information object:
  - `brand`, `model`, `imei`, `serialNumber`
  - `gsmarenaRef` — Reference to GSMArena data (if looked up)
  - `deviceType` — (phone, tablet, laptop, other)
- `conditionChecklist` — Key-value map of checklist items and their states
- `peripherals` — List of items handed in with device (strings)
- `damageType` — Reference to the configured damage type
- `evidenceRefs` — Object containing:
  - `sixAnglePhotos` — Array of media references (required)
  - `ownershipVideo` — Media reference (conditional based on damage type)
  - `additionalPhotos` — Array of media references (optional)
- `priceLog` — Array of PriceEntry (see below)
- `assignedTechnicianId` — Reference to User/Employee
- `warrantyDays` — Number of days for warranty on this repair
- `estimatedCompletionDate` — Date
- `qcChecklist` — Key-value map of QC items and results
- `afterPhotos` — Array of media references
- `pickup` — Pickup object:
  - `customerPhotoRef`, `signatureRef`, `pickedUpAt`, `handedOverBy`
- `linkedWarrantyClaimOf` — If this is a warranty repair, reference to original RepairTicket
- `abandonedFlaggedAt` — Timestamp when auto-flagged, if applicable
- `createdAt`, `updatedAt`, `completedAt`

### PriceEntry

- `id` — Unique identifier
- `repairTicketId` — Parent repair
- `type` — "parts" | "labor" | "discount" | "adjustment"
- `description` — What this charge is for
- `amount` — Signed number (+/−)
- `reason` — Why this was added/changed
- `requiresCustomerConfirmation` — Boolean (true for post-initial-quote entries)
- `customerConfirmationStatus` — "pending" | "accepted" | "store_decided"
- `createdBy` — User who created this entry
- `createdAt` — Timestamp

### Repair State Machine

```
                ┌──────────────────────────────┐
                │                              │
                ▼                              │
  [intake_complete] ──→ [waiting_parts] ──→ [in_repair] ──→ [qc] ──→ [ready] ──→ [completed]
        │                     ▲                  │              │          │
        │                     │                  │              │          │
        │                     └──────────────────┘              │          │
        │                    (parts arrived)              (qc failed,     │
        │                                                 back to         │
        │                                                 repair)         │
        │                                                                 │
        └──────────→ [cancelled] ←────────────────────────────────────────┘
                   (can cancel from most states;
                    device returned to customer)
```

State descriptions:
- **intake_complete**: Intake, diagnosis, and initial quote done. Awaiting technician pickup.
- **waiting_parts**: Technician has identified that required parts are unavailable.
- **in_repair**: Technician is actively working on the device.
- **qc**: Repair work done, awaiting quality check.
- **ready**: QC passed, ready for customer pickup.
- **completed**: Customer has picked up the device. Terminal state.
- **cancelled**: Repair cancelled, device returned. Terminal state.

### DamageType (Admin-Managed)

- `id`, `name` (e.g., "Screen Replacement", "Phone Unlock", "Battery Replacement")
- `requiresOwnershipVideo` — Boolean
- `additionalEvidenceRequirements` — List of additional evidence needed
- Managed globally by the main owner

### ConditionChecklistTemplate (Admin-Managed)

- `id`, `name`, `items` — List of checklist items (e.g., "Screen scratches", "Power button", "Speaker")
- Managed globally by the main owner

### QCChecklistTemplate (Admin-Managed)

- `id`, `name`, `items` — List of QC checklist items
- Managed globally by the main owner

---

## 6. UI/UX Flows

### 6.1 One-Sitting Intake Flow (Primary Flow)

This is a single multi-step form. All steps are completed before the ticket is saved.

**Step 1: Customer**
- Search existing customer by phone number or name
- Or create new customer (name + phone number, minimal fields)
- Big buttons, search-first design

**Step 2: Device**
- Search device model by name → GSMArena auto-populate
- Or enter IMEI → GSMArena lookup
- Fallback: manual entry (brand, model, type)
- Fields: brand, model, IMEI (optional), serial number (optional), device type
- Auto-filled specs shown for confirmation

**Step 3: Damage & Evidence**
- Select damage type from admin-managed list
- Capture 6-angle photos (guided camera UI showing which angle is next)
- Capture ownership video (if required by selected damage type)
- Capture additional damage photos (optional)
- All photos taken in-app with timestamp/GPS overlay

**Step 4: Condition Checklist**
- Display checklist items from template
- Each item is a simple toggle (OK / Not OK / N/A)
- Record peripherals handed in (add from common list or free text)

**Step 5: Diagnosis & Quote**
- Free-text diagnosis description
- Add price entries:
  - Parts (select from inventory or free text + amount)
  - Labor (free text + amount)
- Set estimated completion date (date picker with "today + X days" shortcut)
- Set warranty period (defaults from global config, editable)

**Step 6: Review & Confirm**
- Summary of everything entered
- Customer can view and confirm
- Option for down payment (any amount, including zero)
- Save → creates repair ticket → prints receipt
- Two copies: store + customer

**Design principles:**
- Each step fills the full screen (wizard style)
- Large touch targets for low-tech users
- Back button to revisit previous steps
- Progress indicator at top
- Indonesian language with clear, simple labels
- Can complete the entire flow in under 10 minutes

### 6.2 Repair Queue (Technician View)

- List of repair tickets with status "intake_complete" at the current store
- Each card shows: ticket number, device model, damage type, created time
- Tap to view details → "Ambil" (Take) button to self-assign
- After assignment, ticket appears in "My Repairs" section
- Filter by status: all unassigned, my repairs, waiting parts

### 6.3 Repair Detail (Technician Working View)

- Device info + condition photos at top (swipeable gallery)
- Diagnosis notes
- Price log (running total visible)
- "Add Part" button → search inventory, select SKU, enter quantity
- "Add Price Entry" button → for discoveries/adjustments
- Status action buttons based on current state (e.g., "Send to QC", "Mark Waiting Parts")
- Timeline/history of all actions on this ticket

### 6.4 Pickup Flow (Cashier View)

- Search/scan ticket number
- Show: device info, price summary (all price entries, total, amount paid, remaining)
- Process remaining payment (links to payment flow)
- Capture customer photo
- Capture signature
- Confirm handover → status becomes "completed"
- Print final receipt

### 6.5 Warranty Claim Flow

- Search original repair by ticket number or customer
- System checks if within warranty period → shows warning if expired
- Store manager approves/rejects claim
- If approved: creates new repair ticket linked to original
- Price entries pre-filled with adjustments (e.g., "Warranty - Free" with −100% discount)

---

## 7. Edge Cases & Error States

- **Customer abandoned device**: Auto-flagged after configurable days. No automated action — store owner notified, device remains in store.
- **Initial repair attempt fails / new issues found**: Technician adds new price entries with reason. Customer confirmation tracked via cashier action (not customer input, since customer's phone is being repaired).
- **Customer declines mid-repair price increase**: Store owner decides case-by-case — options are: revert to original scope, cancel repair, or negotiate. The system should support all three via status transitions and price log adjustments.
- **Customer wants device back without repair**: Cancel repair flow — device returned, any payment refunded (tracked in price log as negative entry + in finance module).
- **Device cannot be repaired (DOA)**: Technician marks repair as "cannot repair" → flows to ready/pickup with zero or diagnostic-fee-only charge.
- **GSMArena lookup fails**: Cashier falls back to manual device info entry. System does not block.
- **Photos/video fail to capture**: System requires 6-angle photos — if camera hardware fails, this is a device issue outside our scope. System should show clear error messages.
- **Offline during intake**: Entire flow works offline. Ticket saved locally, synced when online. Media queued for background upload.
- **Warranty claim on expired warranty**: System warns but allows store manager override.
- **Multiple repairs on same device**: Each is a separate ticket. System shows repair history for a device (by IMEI or customer).

---

## 8. Fraud Prevention Measures

- **Evidence integrity**: All photos and videos include embedded timestamp and GPS metadata. Media references are immutable — cannot be replaced after ticket creation.
- **Price log immutability**: Price entries are append-only. Entries cannot be edited or deleted, only offset with new entries (e.g., add a "Correction: −Rp 50,000" entry).
- **Condition checklist as dispute protection**: The signed condition checklist at intake protects against customers claiming the store caused pre-existing damage.
- **Pickup photo + signature**: Proof of device return prevents "I never got my phone back" disputes.
- **Audit trail**: Every state transition, price change, part consumption, and assignment is recorded with user, timestamp, and device ID.
- **Ownership video**: Required for high-risk damage types (e.g., phone unlock) to protect against stolen device servicing.

---

## 9. Open Questions

- **OQ-001**: What specific 6-angle photo positions should be the default? (front, back, left, right, top, bottom?) — Confirm with main owner.
- **OQ-002**: Should the system support multi-device repairs in a single ticket (e.g., customer brings phone + tablet), or should each device always be a separate ticket?
- **OQ-003**: For the "cannot repair" scenario, should there be a separate diagnostic fee, or is it up to the store to decide per case?
- **OQ-004**: What is the GSMArena integration method? API, scraping, or a local device database?
- **OQ-005**: Maximum video duration for ownership video? (Suggested: 30 seconds.)
- **OQ-006**: Photo compression level vs. quality — what's the acceptable tradeoff for 2GB RAM devices?

---

## 10. Claude Code Task Breakdown

### TASK-REP-001: Repair Ticket Data Model & Operations

**Context:** Define the core data structures and operation types for repair tickets, price entries, and related entities.

**Acceptance Criteria:**
- [ ] RepairTicket type defined with all fields from §5
- [ ] PriceEntry type defined
- [ ] All repair operation types defined (repair.created, repair.status_changed, repair.price_entry_added, repair.part_consumed, repair.technician_assigned, repair.qc_completed, repair.picked_up, repair.warranty_claimed, repair.abandoned_flagged)
- [ ] Repair projection defined (rebuilds ticket state from operations)
- [ ] State machine transitions validated in commands

**Depends On:** Platform Core (operation store, projection system)

**Relevant PRD Sections:** §3.1–3.8, §5

---

### TASK-REP-002: Admin-Managed Configuration Entities

**Context:** The main owner configures damage types, condition checklist templates, QC checklist templates, default warranty days, and abandoned device threshold globally.

**Acceptance Criteria:**
- [ ] DamageType CRUD with `requiresOwnershipVideo` and evidence requirements
- [ ] ConditionChecklistTemplate CRUD
- [ ] QCChecklistTemplate CRUD
- [ ] Global settings: default warranty days, abandoned device days, 6-angle photo positions
- [ ] Only main owner role can manage these configurations

**Depends On:** TASK-REP-001, Auth module

**Relevant PRD Sections:** §3.1 (FR-002, FR-003), §3.5 (FR-024), §5

---

### TASK-REP-003: One-Sitting Intake Form (UI)

**Context:** Build the multi-step intake form (customer → device → damage/evidence → condition → diagnosis/quote → review/confirm). This is the primary flow for the repair module.

**Acceptance Criteria:**
- [ ] 6-step wizard with progress indicator
- [ ] Customer search/create in Step 1
- [ ] Device search with GSMArena integration in Step 2 (with manual fallback)
- [ ] Damage type selection + guided photo/video capture in Step 3
- [ ] Condition checklist toggle UI in Step 4
- [ ] Price entry builder (parts + labor) in Step 5
- [ ] Full summary + down payment option + save in Step 6
- [ ] Entire flow works offline
- [ ] Generates receipt on save
- [ ] Completable in under 10 minutes

**Depends On:** TASK-REP-001, TASK-REP-002, TASK-REP-009 (GSMArena), Inventory module (for parts lookup in Step 5)

**Relevant PRD Sections:** §3.1, §3.2, §6.1

---

### TASK-REP-004: Repair Queue & Self-Assignment (UI)

**Context:** Technicians view unassigned repairs at their store and self-assign.

**Acceptance Criteria:**
- [ ] List view of unassigned tickets (status: intake_complete)
- [ ] Ticket card shows: ticket #, device model, damage type, time since creation
- [ ] "Take" button to self-assign
- [ ] "My Repairs" tab showing assigned tickets
- [ ] Filter by status

**Depends On:** TASK-REP-001

**Relevant PRD Sections:** §3.3, §6.2

---

### TASK-REP-005: Repair Working View (Technician UI)

**Context:** The technician's main screen for working on an assigned repair. View device info, add parts, update price, change status.

**Acceptance Criteria:**
- [ ] Device info header with swipeable intake photo gallery
- [ ] Price log display with running total
- [ ] "Add Part" flow: search inventory → select SKU → enter quantity → creates price entry + inventory consumption operation
- [ ] "Add Price Entry" flow: type, description, amount, reason
- [ ] Status transition buttons based on current state
- [ ] Timeline view of all ticket history
- [ ] "Flag waiting for parts" action

**Depends On:** TASK-REP-001, Inventory module (parts search + consumption)

**Relevant PRD Sections:** §3.4, §6.3

---

### TASK-REP-006: Quality Check Flow (UI)

**Context:** QC step before a repair can be marked "ready."

**Acceptance Criteria:**
- [ ] QC checklist loaded from global template
- [ ] Toggle each item pass/fail
- [ ] Capture "after" photos
- [ ] Side-by-side comparison with intake photos
- [ ] Pass → status to "ready"; Fail → status back to "in_repair" with notes

**Depends On:** TASK-REP-001, TASK-REP-002

**Relevant PRD Sections:** §3.5, FR-024–FR-026

---

### TASK-REP-007: Pickup & Handover Flow (UI)

**Context:** Cashier processes device return to customer with payment, photo, and signature.

**Acceptance Criteria:**
- [ ] Search/lookup repair ticket
- [ ] Price summary: all entries, total, paid, remaining
- [ ] Payment processing for remaining balance (integration point with Finance/POS module)
- [ ] Customer photo capture
- [ ] Digital signature capture
- [ ] Confirm handover → terminal "completed" status
- [ ] Receipt generation

**Depends On:** TASK-REP-001, Finance module (payment processing)

**Relevant PRD Sections:** §3.6, §6.4

---

### TASK-REP-008: Warranty Claim Flow (UI)

**Context:** Register a warranty claim linked to a previous repair.

**Acceptance Criteria:**
- [ ] Search original repair by ticket # or customer
- [ ] Warranty period check with visual indicator (in warranty / expired)
- [ ] Store manager approval step
- [ ] Creates new repair ticket linked to original
- [ ] Pre-fills price entries with warranty discount/free adjustments

**Depends On:** TASK-REP-001

**Relevant PRD Sections:** §3.7, §6.5

---

### TASK-REP-009: GSMArena Device Lookup Integration

**Context:** Auto-populate device specs during intake by searching GSMArena.

**Acceptance Criteria:**
- [ ] Search by model name (fuzzy match)
- [ ] Search by IMEI (extract TAC → model lookup)
- [ ] Return: brand, model, screen size, release year, device type
- [ ] Graceful fallback when lookup fails
- [ ] Works offline using a cached/local device database for common models

**Depends On:** None (can be built independently)

**Relevant PRD Sections:** §3.1 (FR-004), §6.1 Step 2

**Notes for Implementation:**
- GSMArena does not have an official API. Options: scrape and cache, use a third-party device database (e.g., IMEI.info API, FONOapi), or build/license a local database.
- For offline support, consider shipping a bundled database of the most common device models.

---

### TASK-REP-010: Receipt Generation & Printing

**Context:** Generate and print repair order receipts (thermal + standard printer support).

**Acceptance Criteria:**
- [ ] Receipt template with: customer info, device info, condition checklist summary, peripherals, price breakdown, estimated completion date, warranty terms, ticket number/QR code, store info
- [ ] Thermal printer output (narrow format)
- [ ] Standard printer output (A4/A5 format)
- [ ] Store copy + customer copy
- [ ] Direct printer integration (Bluetooth, USB, network discovery)
- [ ] Works offline (prints from local data)

**Depends On:** TASK-REP-001

**Relevant PRD Sections:** §3.9, FR-039–FR-042

---

### TASK-REP-011: Abandoned Device Auto-Flagging

**Context:** Background process that flags repairs in "ready" status past a configurable threshold.

**Acceptance Criteria:**
- [ ] Configurable threshold (days since "ready" status)
- [ ] Automatic flagging (sets `abandonedFlaggedAt` timestamp)
- [ ] Visible indicator on repair ticket list for store owner
- [ ] Notification to store owner when a device is flagged

**Depends On:** TASK-REP-001

**Relevant PRD Sections:** §3.8, FR-036–FR-038

---

### TASK-REP-012: Repair List & Monitoring (Store Owner / Main Owner Views)

**Context:** Overview screens for store owners (their store(s)) and main owner (all stores).

**Acceptance Criteria:**
- [ ] Filterable repair list: by status, date range, technician, damage type
- [ ] Store owner sees their store(s) only
- [ ] Main owner sees all stores with store filter
- [ ] Summary stats: total active, avg time per status, overdue count
- [ ] Tap to view repair detail

**Depends On:** TASK-REP-001

**Relevant PRD Sections:** US-015, US-016

---

### TASK-REP-013: WhatsApp Notification Links

**Context:** Generate WhatsApp message links for customer communication.

**Acceptance Criteria:**
- [ ] "Notify customer: ready for pickup" → generates wa.me link with pre-filled message containing ticket #, device model, store address
- [ ] "Notify customer: price change" → generates wa.me link with pre-filled message containing ticket #, new total, reason for change
- [ ] Links open WhatsApp on the device when tapped
- [ ] Research free automated WhatsApp notification options; implement if feasible

**Depends On:** TASK-REP-001

**Relevant PRD Sections:** §3.10, FR-043–FR-044

---

### TASK-REP-014: Role-Specific Onboarding Flow

**Context:** Built-in guided tour for first-time users of the repair module.

**Acceptance Criteria:**
- [ ] Cashier onboarding: walks through intake form, pickup flow
- [ ] Technician onboarding: walks through repair queue, working view, parts consumption
- [ ] Store manager onboarding: walks through repair list, warranty claims
- [ ] Shows on first login per role, can be re-triggered from settings
- [ ] Tooltips + highlighted areas, not just text

**Depends On:** All other TASK-REP-* tasks (onboarding references completed UI)

**Relevant PRD Sections:** NFR-007
