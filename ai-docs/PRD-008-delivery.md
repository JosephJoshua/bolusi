# PRD-008: Delivery

## 1. Overview

### Problem Statement

Stores sell wholesale to resellers and other shops, and those goods have to physically get there. A driver takes a load of accessories and spare parts out in the morning, drops them at several customers, collects cash from some of them, and comes back. Today nobody knows where he is, whether the goods arrived, whether the customer actually received what was recorded, or whether the cash that comes back matches the cash that was collected.

The driver is alone, unsupervised, holding both the goods and the money. This is the least observable role in the business and it needs the most evidence.

### Scope

**Delivery is for wholesale orders only — accessories and spare parts going to B2B customers.** Repaired phones are collected by their owners at the store (PRD-001 §3.6); they are not delivered. This was explicitly confirmed and should not drift.

### Goals

- Get a load of goods from the store to several customers with a record of what arrived where
- Capture proof of delivery that survives a dispute — signature and photograph, at the delivery location
- Track the driver during the run, and alert the store when something looks wrong
- Reconcile the cash the driver collected against the cash the driver returns, same day
- Work offline — the delivery route is exactly where connectivity fails

### Success Metrics

- 100% of deliveries have proof of delivery captured
- Cash collected on delivery reconciles same-day, every day
- Delivery disputes ("we never received it") resolvable from the record without argument
- Store owner knows where an in-progress delivery run is without phoning the driver

---

## 2. User Stories

### Store Side

- **US-701** [P0]: Sebagai staf toko, saya ingin membuat permintaan pengiriman untuk pesanan grosir, sehingga barang bisa diantar ke pelanggan.
  *(As store staff, I want to create a delivery request for a wholesale order, so goods can be sent to the customer.)*

- **US-702** [P0]: Sebagai staf toko, saya ingin menugaskan pengiriman ke driver tertentu, atau membiarkan driver mengambilnya sendiri, sehingga pembagian tugas fleksibel.
  *(As store staff, I want to assign a delivery to a specific driver, or let a driver pick it up themselves, so task allocation is flexible.)*

- **US-703** [P0]: Sebagai pemilik toko, saya ingin melihat status pengiriman yang sedang berjalan, sehingga saya tahu apa yang sudah sampai dan apa yang belum.
  *(As a store owner, I want to see the status of in-progress deliveries, so I know what has arrived and what hasn't.)*

- **US-704** [P1]: Sebagai pemilik toko, saya ingin diberi tahu jika driver berhenti terlalu lama di luar toko, sehingga saya bisa mengeceknya.
  *(As a store owner, I want to be alerted if a driver has been stationary too long outside the store, so I can check on them.)*

- **US-705** [P0]: Sebagai pemilik toko, saya ingin merekonsiliasi uang yang dibawa pulang driver dengan yang seharusnya ditagih, sehingga selisih terdeteksi hari itu juga.
  *(As a store owner, I want to reconcile the cash the driver brings back against what should have been collected, so discrepancies are caught the same day.)*

### Driver Side

- **US-706** [P0]: Sebagai driver, saya ingin melihat daftar pengiriman hari ini dengan alamat dan isi muatan, sehingga saya tahu apa yang harus saya antar ke mana.
  *(As a driver, I want to see today's deliveries with addresses and contents, so I know what to deliver where.)*

- **US-707** [P0]: Sebagai driver, saya ingin membuka navigasi ke alamat pelanggan dengan satu ketukan, sehingga saya tidak perlu mengetik alamat ulang.
  *(As a driver, I want to open navigation to the customer's address with one tap, so I don't have to retype the address.)*

- **US-708** [P0]: Sebagai driver, saya ingin mencatat bukti pengiriman (tanda tangan dan foto) di lokasi, sehingga tidak ada sengketa nanti.
  *(As a driver, I want to capture proof of delivery (signature and photo) at the location, so there's no dispute later.)*

- **US-709** [P0]: Sebagai driver, saya ingin mencatat uang yang saya terima dari pelanggan, sehingga tercatat dan saya tidak disalahkan atas selisih.
  *(As a driver, I want to record cash I receive from the customer, so it's recorded and I'm not blamed for a discrepancy.)*

- **US-710** [P0]: Sebagai driver, saya ingin menandai pengiriman gagal beserta alasannya, sehingga toko tahu barang kembali.
  *(As a driver, I want to mark a delivery as failed with a reason, so the store knows the goods are coming back.)*

- **US-711** [P1]: Sebagai driver, saya ingin melihat rute yang disarankan untuk pengiriman hari ini, sehingga saya tidak bolak-balik.
  *(As a driver, I want to see a suggested route for today's deliveries, so I don't backtrack.)*

---

## 3. Functional Requirements

### 3.1 Delivery Creation

- **FR-701** [Must]: A delivery shall be created from a wholesale order — a completed credit or paid sale destined for a customer address.
- **FR-702** [Must]: A delivery shall contain: customer, delivery address, the line items (product, quantity), the amount to collect on delivery (zero if already paid), and any notes.
- **FR-703** [Must]: Multiple deliveries may be grouped into a **run** — one driver, one trip, several stops.
- **FR-704** [Must]: A delivery may be assigned directly to a driver by store staff, **or** left unassigned for a driver to pick up themselves. Both flows are required.
- **FR-705** [Should]: A run may be created by grouping deliveries manually, or the system may suggest a grouping.

### 3.2 Addresses

- **FR-706** [Must]: A customer address shall be capturable with minimal typing. Entering a full Indonesian address by hand on a phone is slow and error-prone, and the person doing it is a cashier with a queue.
- **FR-707** [Must]: Address capture shall support: picking a point on a map, capturing the current GPS position (useful when the customer is standing there, or when the driver is at the door), and free text for the parts a coordinate cannot convey (building name, floor, landmark, "belakang masjid").
- **FR-708** [Must]: A saved customer address shall be reusable — a repeat wholesale customer's address is entered once, not every time.
- **FR-709** [Should]: The address shall carry both a coordinate (for navigation) and a human-readable description (for the driver, who will need to ask someone).
- **FR-710** [Should]: The driver shall be able to correct or refine a customer's saved address from the field, since the driver is the person who actually finds out where it is.

### 3.3 Run Assignment & Pickup

- **FR-711** [Must]: A driver shall see the runs assigned to them, and the unassigned deliveries available to pick up.
- **FR-712** [Must]: A driver picking up an unassigned delivery self-assigns it, and it becomes theirs.
- **FR-713** [Must]: Starting a run shall record: driver, timestamp, and the goods leaving the store.
- **FR-714** [Must]: Goods leaving on a run shall be reflected in inventory as in-transit — they have left the store's available stock but have not yet reached the customer. They are not written off until delivered.
- **FR-715** [Must]: A failed delivery returns goods to the store, and they return to available stock on receipt.

### 3.4 Navigation

- **FR-716** [Must]: The driver shall be able to open the delivery address in Google Maps or Waze with one tap. The system shall not build its own turn-by-turn navigation.
- **FR-717** [Should]: The system may suggest a stop order for a run (route optimization), but the driver is not bound to it. The driver knows the roads; the suggestion is advice.
- **FR-718** [Must]: Navigation handoff shall work with the address coordinate. If no coordinate exists, hand off the text address and accept that the mapping app will do its best.

### 3.5 Proof of Delivery

- **FR-719** [Must]: On delivery, the driver shall capture:
  - A photograph — of the goods with the recipient, or of the goods at the delivery point
  - A signature from the recipient, on screen
  - The recipient's name
  - Timestamp and GPS location, embedded automatically
- **FR-720** [Must]: The GPS location of the proof-of-delivery capture shall be recorded and compared against the customer's registered address. A large discrepancy shall be flagged.
- **FR-721** [Must]: Proof of delivery shall be capturable offline. This is the single most important offline requirement in the module — the delivery address is precisely where there is no signal.
- **FR-722** [Should]: The driver shall be able to record a partial delivery — the customer accepted some items and rejected others.
- **FR-723** [Must]: A delivery cannot be marked complete without proof of delivery.

### 3.6 Cash on Delivery

- **FR-724** [Must]: Where a delivery carries an amount to collect, the driver shall record what was actually collected: amount and method (cash, QRIS, transfer).
- **FR-725** [Must]: Partial collection shall be supported — the customer paid some of it. The remainder stays as a receivable (PRD-003 §3.3).
- **FR-726** [Must]: Collection shall be recordable offline.
- **FR-727** [Must]: Cash collected creates a **driver cash position** — the system knows how much cash the driver is carrying, in the same way it knows how much is in a cashier's drawer.
- **FR-728** [Must]: A payment collected on delivery shall generate the same journal entries as a payment collected at the counter (PRD-003 §3.2). The location of the payment does not change its accounting.

### 3.7 Failed Delivery

- **FR-729** [Must]: A driver shall be able to mark a delivery failed, with a reason (customer absent, wrong address, customer refused, other) and a free-text note.
- **FR-730** [Should]: A failed delivery should capture a photograph where possible — a locked shop front is evidence.
- **FR-731** [Must]: A failed delivery returns the goods to the store. The store manager decides: re-attempt, or cancel and restock.
- **FR-732** [Must]: Goods returning from a failed delivery shall be received back into stock explicitly, not automatically. Someone at the store confirms the goods physically came back.

### 3.8 Run Completion & Reconciliation

- **FR-733** [Must]: A driver shall close their run on return to the store.
- **FR-734** [Must]: Run closure shall reconcile:
  - **Goods:** delivered + returned = departed. Any gap is flagged.
  - **Cash:** the cash the driver hands over, against the cash the system says they collected.
- **FR-735** [Must]: The cash reconciliation shall follow the same shape as the cashier's end-of-shift reconciliation (PRD-003 §3.6): expected, counted, variance, logged.
- **FR-736** [Must]: Reconciliation shall happen same-day, on return. This was explicitly required and it is the primary control on the role.
- **FR-737** [Must]: A variance beyond a configurable threshold shall alert the store owner.
- **FR-738** [Must]: Handover of cash from driver to store shall be an explicit two-party act — the driver records handing it over, and a store user records receiving it. A single-sided record is not a handover; it is a claim.

### 3.9 Live Tracking

> The GPS mechanics are specified in PRD-009. This section covers only what delivery requires of them.

- **FR-739** [Must]: A driver's location shall be tracked while a run is active.
- **FR-740** [Must]: Tracking shall stop when the run is closed. The system does not track a driver who is not working. (See PRD-009 §7 — this is a privacy boundary, not a nicety.)
- **FR-741** [Must]: The store owner shall be alerted when an active driver has been stationary, away from the store, for longer than a configurable period (default 30 minutes).
- **FR-742** [Must]: The stationary alert is advisory. A driver may be stationary because they are eating lunch, waiting for a customer to find their keys, or broken down. The alert tells the store owner to check, not that something is wrong.
- **FR-743** [Should]: The store owner shall be able to see the current position of active runs on a map.
- **FR-744** [Must]: The driver shall be told, unambiguously, that they are tracked while a run is active. Covert tracking of an employee is not acceptable.

---

## 4. Non-Functional Requirements

- **NFR-701**: Every driver-side action — viewing the run, capturing proof of delivery, recording collection, marking failure, closing the run — must work fully offline. The driver is on a road in West Papua; assume no signal for the entire run.
- **NFR-702**: GPS tracking during a run must not exhaust the battery. A driver whose phone dies at stop three has no proof of delivery for stops four through eight. Sampling interval should be tuned for this, not for tracking fidelity.
- **NFR-703**: Media captured on a run (proof-of-delivery photos, signatures) queues for upload and must survive the device being offline for the whole day.
- **NFR-704**: The driver UI must be usable one-handed, quickly, possibly in the rain, possibly while a customer waits. Large targets, few steps, no typing where it can be avoided.
- **NFR-705**: Driver location data is sensitive. It is visible to the store owner and main owner, and to nobody else. It is retained only as long as it serves an operational purpose (see PRD-009 §7).
- **NFR-706**: Indonesian and English.

---

## 5. Data Entities (Conceptual)

### Delivery

- `id`
- `storeId`
- `saleId` — The wholesale order this fulfils
- `customerId`
- `address` — { coordinate: {lat, lng} | null, text, notes }
- `lines` — Array of { productId, sku, name, quantity }
- `amountToCollect` — Zero if already paid
- `runId` — The run this belongs to, if assigned
- `status` — pending | assigned | in_transit | delivered | partially_delivered | failed | returned
- `proofOfDelivery` — { photoRef, signatureRef, recipientName, capturedAt, location } | null
- `deliveredLines` — What was actually accepted (may differ from `lines` on partial delivery)
- `collection` — { amount, method, recordedAt } | null
- `failureReason`, `failureNote`, `failurePhotoRef`
- `createdAt`, `deliveredAt`

### DeliveryRun

- `id`
- `storeId`
- `driverId`
- `deliveryIds` — The stops
- `status` — planned | in_progress | closed
- `departedAt`, `closedAt`
- `goodsReconciliation` — { departed, delivered, returned, discrepancy }
- `cashReconciliation` — { expectedCollected, handedOver, variance, notes }
- `handoverReceivedBy` — The store user who received the cash

### CustomerAddress

- `id`
- `customerId`
- `coordinate` — { lat, lng } | null
- `text` — Human-readable address
- `notes` — Landmarks, floor, instructions
- `isDefault`
- `lastRefinedBy`, `lastRefinedAt` — Drivers correct these from the field

### DriverCashPosition (Projection)

- `driverId`, `runId`
- `expectedCash` — Sum of cash collections recorded on this run
- `handedOver` — Amount handed to the store
- `variance`

---

## 6. UI/UX Flows

### 6.1 Driver — Today

The driver's home screen is a list of stops, in order. Nothing else. No dashboard, no metrics, no navigation drawer full of things a driver will never use.

Each stop shows: customer name, a short address line, the number of items, and the amount to collect if any. Delivered stops collapse and grey out. The next stop is at the top, expanded.

One primary action per stop: **"Navigasi"** — which opens Maps or Waze. That's the action a driver takes ninety percent of the time, and it should require one tap from the screen they're already looking at.

**Design note:** the temptation is to build a rich driver app. Resist it. The driver is riding a motorbike, holding a phone in the rain, with a customer waiting. Every element on this screen that isn't the next stop or the way to get there is a cost.

### 6.2 Driver — Arriving

Tapping the stop opens it. What's in the load, what to collect, the customer's phone number (one tap to call — the driver will need to, because the address will be wrong).

Two actions: **"Terkirim"** (Delivered) and **"Gagal"** (Failed).

### 6.3 Driver — Proof of Delivery

Tapping "Terkirim" runs a short sequence, each step one screen:

1. **What was accepted?** Defaults to everything. The driver only touches this if the customer rejected something.
2. **Photo.** Camera opens. Take it.
3. **Signature.** Recipient signs on the screen. Type their name.
4. **Collection**, if there's an amount to collect. Amount and method. Defaults to the full amount in cash, because that's the common case.

Done. Back to the list. Next stop.

This must be completable in under a minute while standing at a doorway. It is the core loop of the driver's day and it happens six or eight times.

### 6.4 Driver — Failure

Reason from a short list. A note if they want. A photo if there's something to photograph. Back to the list.

The goods stay in the load and come back to the store.

### 6.5 Driver — Closing the Run

Back at the store. The screen shows:

- **Goods:** what went out, what was delivered, what's coming back. If those don't add up, it says so.
- **Cash:** what the system says was collected. The driver counts what they have and enters it.
- **Handover:** a store user confirms receipt.

The variance is shown plainly. A driver who is short says why. A store owner is alerted if it's beyond threshold.

**Design note:** this screen is the whole control on the role, and it should not feel like an accusation. Most drivers most days are honest and the numbers will match. The tone should be routine — a checklist, not an interrogation. The system's job is to make it *normal* to reconcile, so that the day it doesn't match is conspicuous.

### 6.6 Store — Delivery Board

Pending deliveries awaiting assignment. Active runs with their current position and progress. Completed runs awaiting reconciliation.

Tapping an active run shows the driver's position and which stops are done.

### 6.7 Store — Address Capture

When creating a delivery for a customer with no saved address:

- If the customer is standing at the counter: "Use their location" isn't available, so — map picker or text.
- If it's a repeat customer: the saved address is already there. Nothing to do.
- The driver will fix it from the field the first time they go, and the correction sticks.

**Design note on addresses:** Indonesian addresses in a city like Jayapura or Sorong are frequently not machine-resolvable. A coordinate plus "rumah cat hijau, sebelah warung Bu Ani" is more useful to a driver than a formally correct address string that Maps drops in the wrong kampung. Build for that reality: coordinate for the machine, prose for the human, and let the driver — the only person who actually finds the place — correct both.

---

## 7. Edge Cases & Error States

- **Address is wrong.** Common, and expected. The driver calls the customer, finds the place, and corrects the saved address from the field. This is a feature, not an error path.
- **No coordinate for the address.** Hand the text to Maps and hope. Let the driver capture the real coordinate on arrival, which fixes it for next time.
- **Customer absent.** Failed delivery, reason recorded, photo of the closed shop, goods come back. Store manager decides re-attempt or cancel.
- **Customer accepts some items, rejects others.** Partial delivery. Accepted items are delivered; rejected items come back and return to stock on receipt at the store.
- **Customer pays less than the amount due.** Partial collection. The remainder becomes a receivable against that customer. The driver is not responsible for the shortfall — but the *record* of what they collected is what they will be reconciled against, so it must be recorded accurately at the door, not reconstructed later.
- **Driver's phone dies mid-run.** The worst case. Proof of delivery captured before the phone died is queued locally and syncs when charged. Deliveries made after it died have no proof. There is no clean recovery — the store reconciles goods and cash on return and records the gap. **This is the argument for NFR-702**: battery life is not a nicety, it is the integrity of the day's records.
- **Driver is offline the entire run.** Expected. Everything queues. Nothing in the driver flow may require a round trip.
- **Driver goes stationary for an hour.** Alert fires. Store owner calls. Usually it's lunch or a breakdown. Occasionally it isn't. The alert does not assert which.
- **GPS shows the driver somewhere implausible.** Either a bad fix or a spoofed one. Flag; don't act. A single bad fix is noise, a pattern is signal.
- **Cash variance at run close.** Logged, alerted if large. Note that a driver who collected honestly but was robbed has the same variance as a driver who stole. The system records the fact; the human handles the situation.
- **Driver closes the run without handing over cash.** The handover is two-sided (FR-738) — the run does not fully close until a store user confirms receipt. A driver-only claim of handover is not a handover.
- **Goods discrepancy at run close.** Delivered + returned ≠ departed. Something is missing. Flag loudly. This is a small number of high-value items and the gap will be obvious.

---

## 8. Fraud Prevention Measures

The driver is alone with the goods and the money. Of every role in this business, this one has the most opportunity and the least supervision, and the controls should reflect that without treating every driver as a thief.

| Pattern | Control |
|---|---|
| Driver keeps goods, claims delivery | Proof of delivery: photo + signature + recipient name, with GPS. Faking all of it, at the right coordinate, at the right time, is hard. |
| Driver claims delivery at a location that isn't the customer | POD capture location compared against the customer's registered address; discrepancy flagged (FR-720) |
| Driver collects cash, reports less | Same-day cash reconciliation against recorded collections; two-sided handover (FR-738); variance trend per driver over time |
| Driver collects cash, claims customer didn't pay | The receivable stays open against that customer. The customer will eventually be chased for a debt they already paid — and will say so. This is caught by the customer, not the system, which is why receivable aging matters (PRD-003 §3.3). |
| Driver marks delivery failed, keeps goods | Goods must be physically received back at the store (FR-732), not automatically restocked. Failed-delivery rate per driver is reported. |
| Driver detours for personal errands | Stationary alert; route deviation visible on the tracking map. Note this is a productivity concern, not theft, and should be treated proportionately. |
| Driver colludes with customer (records less delivered than given) | Goods reconciliation at run close; the customer's own stock records would eventually diverge, but realistically this is caught by inventory shrinkage patterns over time (PRD-005 §8) |

**On the limits of the controls:** a driver who is determined to steal, and who is willing to be caught eventually, can steal once. The controls make it *visible*, quickly, and make a pattern impossible to sustain. That is the realistic goal. Designing for a driver who cannot possibly steal would mean a system so heavy that no driver would use it, and the store would go back to paper — where the driver can steal freely and nobody would ever know.

**On the driver's protection:** these controls protect the honest driver as much as they catch the dishonest one. A driver who delivered correctly and collected correctly has a photograph, a signature, and a GPS coordinate proving it. When a customer claims non-delivery, or when cash goes missing somewhere between the driver and the safe, the record is the driver's defence. This should be said explicitly to drivers during onboarding, because a control that is only ever framed as surveillance breeds resentment, and a control that is framed as mutual protection is one people actually cooperate with.

---

## 9. Interactions With Other Modules

| Concern | Owned by |
|---|---|
| The wholesale order being delivered | POS (PRD-006) |
| Stock leaving, in-transit, returning | Inventory (PRD-002) |
| Payment collection, journal entries, receivables | Finance (PRD-003) |
| Cash reconciliation mechanics | Finance (PRD-003 §3.6) |
| Customer records and addresses | CRM |
| GPS tracking mechanics, geofencing, alerts | GPS & Anti-Fraud (PRD-009) |
| Driver performance and fraud reporting | Reporting (PRD-005) |

Delivery owns: the delivery, the run, proof of delivery, and the run reconciliation.

---

## 10. Open Questions

- **OQ-701**: Should route optimization be built, or is the driver's own knowledge of the roads better? A suggested stop order is cheap; genuine optimization (traffic, time windows) is not, and in a small city may add nothing.
- **OQ-702**: What is the stationary-alert threshold? 30 minutes was suggested. Is that right for a city where a customer might genuinely take that long to find their cash?
- **OQ-703**: What is the acceptable cash variance threshold for a driver before it alerts?
- **OQ-704**: Can a driver run deliveries for more than one store in a day? (Relevant for a store owner with several nearby stores.)
- **OQ-705**: Should a driver be able to accept a *new* order from a customer at the door ("since you're here, bring me 20 more cases next week")? This is a real thing that happens, and currently there is nowhere to put it.
- **OQ-706**: How long should driver location history be retained? See PRD-009 §7 — this is a privacy question with a legal dimension, not just a storage one.

---

## 11. Claude Code Task Breakdown

### TASK-DEL-001: Delivery & Run Data Model

**Context:** Core entities. Deliveries group into runs; runs are the unit of reconciliation.

**Acceptance Criteria:**
- [ ] Delivery, DeliveryRun, CustomerAddress entities per §5
- [ ] Operations: `delivery.created`, `delivery.assigned`, `run.started`, `delivery.completed`, `delivery.failed`, `run.closed`
- [ ] Status transitions validated
- [ ] Reversal patterns documented (ARCH-001 §9.2)
- [ ] Delivery linked to its originating sale

**Depends On:** Platform Core, POS (sale), CRM (customer)

**Relevant PRD Sections:** §3.1, §5

---

### TASK-DEL-002: Address Capture & Refinement

**Context:** Indonesian addresses are frequently not machine-resolvable. Build for coordinate-plus-prose, and let the driver fix it from the field.

**Acceptance Criteria:**
- [ ] Capture by map pin, by current GPS position, or by text
- [ ] Coordinate and human-readable text and notes stored together; none is mandatory alone
- [ ] Saved per customer, reusable
- [ ] Default address per customer
- [ ] **Driver can correct a saved address from the field**, and the correction persists
- [ ] Minimal typing throughout

**Depends On:** TASK-DEL-001, CRM

**Relevant PRD Sections:** §3.2, §6.7

---

### TASK-DEL-003: Delivery Creation & Assignment (Store Side)

**Context:** Store staff turn a wholesale order into a delivery, and get it to a driver.

**Acceptance Criteria:**
- [ ] Create delivery from a completed wholesale sale
- [ ] Group deliveries into a run
- [ ] Assign a run to a driver, **or** leave deliveries unassigned for driver self-pickup — both flows required
- [ ] Delivery board: pending, active runs, awaiting reconciliation
- [ ] Amount-to-collect derived from the sale (zero if already paid)

**Depends On:** TASK-DEL-001, POS

**Relevant PRD Sections:** §3.1, §3.3, §6.6

---

### TASK-DEL-004: Driver Run View

**Context:** The driver's entire app, essentially. A list of stops and a way to navigate to them. Nothing more.

**Acceptance Criteria:**
- [ ] Ordered list of stops; next stop expanded at top; completed stops collapsed
- [ ] Per stop: customer, address, item count, amount to collect
- [ ] **One-tap navigation handoff to Google Maps / Waze**, using coordinate if present, text otherwise
- [ ] One-tap call to customer
- [ ] Self-assign an unassigned delivery
- [ ] Optional suggested stop order (route optimization — see OQ-701)
- [ ] **Entire view works offline**
- [ ] Usable one-handed, quickly, in poor conditions

**Depends On:** TASK-DEL-001, TASK-DEL-003

**Relevant PRD Sections:** §3.3, §3.4, §6.1, §6.2, NFR-704

---

### TASK-DEL-005: Proof of Delivery

**Context:** The evidence that a delivery happened. This is the module's core artifact and its offline requirement is absolute.

**Acceptance Criteria:**
- [ ] Sequence: accepted items → photo → signature → recipient name → collection
- [ ] Defaults to full acceptance and full cash collection (the common case), editable
- [ ] Photo captured live in-app
- [ ] Signature captured on screen
- [ ] Timestamp and GPS embedded automatically
- [ ] **POD capture location compared against customer's registered address; discrepancy flagged**
- [ ] Partial delivery supported
- [ ] **Delivery cannot complete without POD**
- [ ] **Works fully offline; queues for sync**
- [ ] Completable in under a minute at a doorway

**Depends On:** TASK-DEL-004, Platform Core (media capture, offline queue)

**Relevant PRD Sections:** §3.5, §6.3, NFR-701, NFR-703

---

### TASK-DEL-006: Cash Collection on Delivery

**Context:** The driver takes money. The system must know how much, before the driver gets back.

**Acceptance Criteria:**
- [ ] Record amount collected and method (cash, QRIS, transfer)
- [ ] Partial collection supported; remainder becomes a receivable
- [ ] Works offline
- [ ] Generates the same journal entries as a counter payment (PRD-003 §3.2)
- [ ] Maintains a driver cash position projection for the run

**Depends On:** TASK-DEL-005, TASK-FIN-003, TASK-FIN-004

**Relevant PRD Sections:** §3.6

---

### TASK-DEL-007: Failed Delivery

**Context:** The goods come back. Someone at the store has to confirm they actually did.

**Acceptance Criteria:**
- [ ] Reason from a short list, plus free text
- [ ] Optional photo
- [ ] Goods stay with the driver and return to the store
- [ ] **Goods explicitly received back into stock at the store — not auto-restocked**
- [ ] Store manager decides re-attempt or cancel
- [ ] Failed-delivery rate per driver exposed to reporting

**Depends On:** TASK-DEL-005, Inventory

**Relevant PRD Sections:** §3.7

---

### TASK-DEL-008: Run Closure & Reconciliation

**Context:** The control on the role. Goods out must equal goods delivered plus goods returned; cash collected must equal cash handed over.

**Acceptance Criteria:**
- [ ] Goods reconciliation: departed = delivered + returned; discrepancy flagged loudly
- [ ] Cash reconciliation: expected collected vs. counted, variance shown, following the PRD-003 §3.6 pattern
- [ ] **Two-sided handover: driver records handing over, store user records receiving.** A run does not fully close on the driver's word alone.
- [ ] Variance beyond threshold alerts the store owner
- [ ] Same-day closure enforced or prompted
- [ ] Tone is routine, not accusatory (see §6.5 design note)
- [ ] Variance trend per driver exposed to reporting

**Depends On:** TASK-DEL-006, TASK-DEL-007, TASK-FIN-006

**Relevant PRD Sections:** §3.8, §6.5, §8

---

### TASK-DEL-009: Live Run Tracking (Delivery Side)

**Context:** The delivery module's consumption of the GPS service. Mechanics live in PRD-009.

**Acceptance Criteria:**
- [ ] Tracking starts when a run starts and **stops when the run closes** — never outside an active run
- [ ] Driver is told unambiguously that they are tracked during a run
- [ ] Store owner sees active run positions on a map
- [ ] Stationary alert: driver away from store, not moving beyond threshold → store owner notified
- [ ] **Alert is advisory in wording, not accusatory**
- [ ] Battery-conscious sampling (NFR-702) — a dead phone means no proof of delivery

**Depends On:** TASK-DEL-004, PRD-009 (GPS service)

**Relevant PRD Sections:** §3.9, NFR-702, NFR-705
