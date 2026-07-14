# PRD-006: Point of Sale (POS)

## 1. Overview

### Problem Statement

Stores sell accessories and spare parts alongside their repair business — cases, chargers, cables, screen protectors, loose components — to walk-in retail customers and to wholesale buyers (resellers and other shops). Today this runs on a separate POS system that doesn't know about the repair business, doesn't know the customer, doesn't feed inventory, and doesn't feed the books. Every sale is re-entered somewhere or simply lost.

The POS module is where money enters the business most frequently, which makes it both the highest-volume screen in the product and the single largest fraud surface. It has to be fast enough for a queue and tight enough to be trustworthy.

### Goals

- Sell products quickly, with barcode scanning and search that tolerates imprecise input
- Price correctly and automatically by customer tier, quantity, and negotiated discount, without the cashier doing arithmetic
- Support split payments across cash, QRIS, EDC, and bank transfer
- Support credit sales (hutang) to B2B customers, feeding receivables
- Consume inventory and generate accounting entries as an automatic consequence of the sale, invisibly
- Print a receipt on a thermal printer
- Generate a shareable B2B catalog link that a wholesale customer can browse and order from
- Work fully offline

### Non-Goals

- **Repair payments do not go through POS.** Repair intake, pickup, and payment are handled in the repair module (PRD-001). The two flows share the payment component (PRD-003 §3.5) but are separate screens. A cashier taking payment for a repaired phone is in the repair pickup flow, not here.
- **No tax invoice (faktur pajak) generation.** See §11. This is not a V1 concern and does not belong in POS.
- **No vouchers, store credit, or loyalty points.** Explicitly out of scope per Ocep.

### Success Metrics

- A single-item cash sale completes in under 20 seconds from scan to printed receipt
- Zero manual price lookups — the correct tier price appears without the cashier searching for it
- 100% of sales generate correct inventory movements and journal entries
- Cash variance at shift end trends toward zero across stores

---

## 2. User Stories

### Selling

- **US-501** [P0]: Sebagai kasir, saya ingin memindai barcode produk untuk menambahkannya ke keranjang, sehingga transaksi cepat.
  *(As a cashier, I want to scan a product barcode to add it to the cart, so the transaction is fast.)*

- **US-502** [P0]: Sebagai kasir, saya ingin mencari produk dengan mengetik sebagian nama, sehingga saya tetap bisa menjual produk tanpa barcode.
  *(As a cashier, I want to search for a product by typing part of its name, so I can still sell products without a barcode.)*

- **US-503** [P0]: Sebagai kasir, saya ingin memilih pelanggan agar harga sesuai tier-nya otomatis, sehingga saya tidak perlu menghitung atau mengingat harga grosir.
  *(As a cashier, I want to select a customer so the price automatically matches their tier, so I don't have to calculate or remember wholesale prices.)*

- **US-504** [P0]: Sebagai kasir, saya ingin melihat total belanja dan rincian harga per item, sehingga saya bisa menjelaskan ke pelanggan.
  *(As a cashier, I want to see the total and per-item price breakdown, so I can explain it to the customer.)*

- **US-505** [P1]: Sebagai kasir, saya ingin memberi diskon pada transaksi (dengan alasan), sehingga saya bisa menangani negosiasi harga.
  *(As a cashier, I want to apply a discount to a transaction (with a reason), so I can handle price negotiation.)*

### Paying

- **US-506** [P0]: Sebagai kasir, saya ingin menerima pembayaran tunai dan sistem menghitung kembalian, sehingga saya tidak salah hitung.
  *(As a cashier, I want to accept cash payment and have the system calculate change, so I don't miscalculate.)*

- **US-507** [P0]: Sebagai kasir, saya ingin menerima pembayaran gabungan (misalnya sebagian tunai, sebagian QRIS), sehingga pelanggan bisa bayar sesuai kemampuannya.
  *(As a cashier, I want to accept split payments (e.g., part cash, part QRIS), so customers can pay as they're able.)*

- **US-508** [P0]: Sebagai kasir, saya ingin mencatat penjualan kredit ke pelanggan B2B, sehingga barang bisa keluar sekarang dan dibayar nanti.
  *(As a cashier, I want to record a credit sale to a B2B customer, so goods can leave now and be paid later.)*

### Receipt

- **US-509** [P0]: Sebagai kasir, saya ingin mencetak struk untuk pelanggan, sehingga mereka punya bukti pembelian.
  *(As a cashier, I want to print a receipt for the customer, so they have proof of purchase.)*

### Wholesale

- **US-510** [P1]: Sebagai kasir, saya ingin membuat link katalog untuk pelanggan B2B tertentu, sehingga mereka bisa melihat harga mereka dan memesan tanpa datang ke toko.
  *(As a cashier, I want to generate a catalog link for a specific B2B customer, so they can see their prices and order without visiting the store.)*

- **US-511** [P1]: Sebagai kasir, saya ingin mengonfirmasi pesanan yang masuk dari katalog sebelum diproses, sehingga saya tetap mengendalikan apa yang keluar dari toko.
  *(As a cashier, I want to confirm orders that arrive from the catalog before processing, so I retain control over what leaves the store.)*

### Corrections

- **US-512** [P0]: Sebagai kasir, saya ingin membatalkan transaksi yang salah (dengan persetujuan manajer), sehingga kesalahan bisa diperbaiki tanpa merusak catatan.
  *(As a cashier, I want to void an incorrect transaction (with manager approval), so mistakes can be corrected without corrupting records.)*

### Shift

- **US-513** [P0]: Sebagai kasir, saya ingin membuka dan menutup shift saya, sehingga kas saya bisa direkonsiliasi dan pertanggungjawaban jelas.
  *(As a cashier, I want to open and close my shift, so my cash can be reconciled and accountability is clear.)*

---

## 3. Functional Requirements

### 3.1 Cart Construction

- **FR-501** [Must]: A cashier shall be able to add a product to the cart by scanning its barcode. Both manufacturer barcodes and system-generated barcodes shall resolve.
- **FR-502** [Must]: A cashier shall be able to add a product by searching. Search shall match against product name, SKU, and barcode, and shall tolerate partial and misspelled input.
- **FR-503** [Must]: Scanning a product already in the cart shall increment its quantity rather than adding a duplicate line.
- **FR-504** [Must]: A cashier shall be able to adjust the quantity of any line, and remove a line.
- **FR-505** [Must]: The cart shall show, per line: product name, unit price, quantity, line total. And in aggregate: subtotal, discount, total.
- **FR-506** [Should]: The cart shall warn — but not block — when a line's quantity exceeds available stock. Overselling is accepted (see ARCH-001); the cashier is told, and decides.
- **FR-507** [Should]: A cart shall be retrievable if the app is closed mid-transaction (held locally until completed or explicitly discarded).

### 3.2 Customer & Pricing

- **FR-508** [Must]: A sale may be anonymous (walk-in retail) or attached to a customer.
- **FR-509** [Must]: When a customer is attached, all cart pricing shall recalculate to that customer's tier price.
- **FR-510** [Must]: Pricing shall apply the layered calculation defined in PRD-002 §3.2: tier price, then volume discount by quantity, then any negotiated customer-specific discount.
- **FR-511** [Must]: The cashier shall never need to compute a price. The correct price appears as a consequence of selecting the customer and the quantity.
- **FR-512** [Should]: The cart shall show, per line, why a price is what it is (e.g., "Harga reseller · diskon volume 10%") so the cashier can explain it to the customer.
- **FR-513** [Must]: Cost price shall never be displayed in the POS surface, regardless of the user's permissions. The customer can see this screen.

### 3.3 Manual Discount

- **FR-514** [Should]: A cashier shall be able to apply a manual discount to a line or to the whole transaction.
- **FR-515** [Must]: A manual discount shall require a reason. The reason is recorded with the sale.
- **FR-516** [Should]: Discounts above a configurable threshold shall require manager approval.
- **FR-517** [Must]: Manual discount volume per cashier is reported (see PRD-005 §8) — this is a known fraud vector and must be visible.

### 3.4 Payment

- **FR-518** [Must]: POS shall use the shared payment component (PRD-003 §3.5, TASK-FIN-003). Payment behavior is defined there and is not redefined here.
- **FR-519** [Must]: Supported methods: cash, QRIS (manual and automatic modes), EDC, bank transfer.
- **FR-520** [Must]: Split payment across multiple methods shall be supported.
- **FR-521** [Must]: For cash, the cashier enters the amount tendered and the system displays change owed.
- **FR-522** [Must]: A sale may be completed as a credit sale (hutang) when attached to a customer. This creates a receivable (PRD-003 §3.3) rather than requiring payment now.
- **FR-523** [Must]: Credit sales require an attached customer. An anonymous sale cannot be a credit sale.
- **FR-524** [Won't]: No credit limits. A customer may accrue receivables without a ceiling (per Ocep).
- **FR-525** [Must]: A sale may be partially paid now and partially on credit. The unpaid remainder becomes a receivable.

### 3.5 Sale Completion

- **FR-526** [Must]: Completing a sale shall, as a single logical act:
  - Record the sale
  - Decrement inventory for each line (PRD-002 §3.3)
  - Record the payment(s) (PRD-003 §3.5)
  - Generate the journal entries (PRD-003 §3.2), including revenue and COGS
  - Create a receivable if any portion is on credit
  - Print the receipt
- **FR-527** [Must]: All of the above shall work offline. Nothing in the sale path may depend on connectivity.
- **FR-528** [Must]: A completed sale is terminal. It may be voided or returned, but never edited.

### 3.6 Receipt

- **FR-529** [Must]: A receipt shall print on a thermal printer on sale completion.
- **FR-530** [Must]: The receipt shall contain: store name and contact, date and time, sale number, line items (name, qty, unit price, line total), subtotal, discount, total, payment method(s) and amounts, change given, cashier identifier.
- **FR-531** [Should]: If any portion was on credit, the receipt shall state the outstanding balance.
- **FR-532** [Should]: The receipt shall carry the sale number in a scannable form (barcode or QR) to make returns and lookups fast.
- **FR-533** [Should]: Reprint of a past receipt shall be possible, and shall be marked as a reprint.
- **FR-534** [Must]: The receipt has no mandated legal format for non-PKP stores. See §11. Do not build tax-invoice fields into the receipt.

### 3.7 Void

- **FR-535** [Must]: A completed sale may be voided.
- **FR-536** [Must]: A void requires manager approval.
- **FR-537** [Must]: A void requires a reason.
- **FR-538** [Must]: A void shall reverse the sale's effects: restore inventory, reverse the journal entries, reverse or refund the payment, and close any receivable created.
- **FR-539** [Must]: A void never deletes the original sale. The original remains in the record, marked voided, with a reversing entry (see PRD-003 §7).
- **FR-540** [Must]: Void rate per cashier is reported (PRD-005 §8) — voiding a real sale and pocketing the cash is a primary fraud pattern.

### 3.8 Returns

> Customer returns are specified in PRD-002 §3.10. POS is the surface where they are initiated.

- **FR-541** [Must]: A cashier shall be able to initiate a return against a prior sale, located by sale number (scanned or typed) or by customer.
- **FR-542** [Must]: The cashier selects which lines and quantities are being returned.
- **FR-543** [Must]: Returns require manager approval (per PRD-002 FR-143).
- **FR-544** [Must]: An approved return restores inventory and issues a refund. Refund may be to cash or to the original payment method (per Ocep: either is acceptable).
- **FR-545** [Should]: A return against a credit sale that is not yet paid shall reduce the receivable rather than issuing a cash refund.

### 3.9 Shifts

- **FR-546** [Must]: A cashier shall open a shift before transacting, and close it when done.
- **FR-547** [Must]: Opening a shift shall record the opening cash float.
- **FR-548** [Must]: Closing a shift shall run the cash reconciliation defined in PRD-003 §3.6.
- **FR-549** [Must]: Every sale shall be attributed to the shift and the user who made it.
- **FR-550** [Should]: A shift left open past a configurable duration shall prompt the cashier and notify the store owner.
- **FR-551** [Must]: Multiple users may transact on the same device. Each sale is attributed to the logged-in user (PIN quick-switch — see ARCH-001 §4.1), not to the device.

### 3.10 B2B Catalog

- **FR-552** [Should]: A store user shall be able to generate a catalog link for a specific customer, or an anonymous one.
- **FR-553** [Must]: The link is public — anyone holding it can open it. It carries no authentication.
- **FR-554** [Must]: A link generated for a specific customer shall display that customer's tier prices. An anonymous link shall display retail prices.
- **FR-555** [Must]: Each link is generated per transaction and is not a permanent storefront.
- **FR-556** [Must]: Links shall expire after a configurable period.
- **FR-557** [Should]: The catalog shall let the visitor select products and quantities and submit an order.
- **FR-558** [Must]: A submitted order is a request, not a sale. It arrives in the store as a pending order requiring confirmation.
- **FR-559** [Must]: Store confirmation of a catalog order opens it as a normal cart in POS, which the cashier completes through the standard flow.
- **FR-560** [Should]: The catalog shall show stock availability, or at minimum not show products with zero stock.
- **FR-561** [Must]: The catalog shall never expose cost price, other customers' tiers, or any store-internal data.

---

## 4. Non-Functional Requirements

- **NFR-501**: Scan-to-cart latency under 500ms. This is the most repeated interaction in the product and it is felt.
- **NFR-502**: A single-item cash sale completes in under 20 seconds end to end, including receipt printing.
- **NFR-503**: The entire sale path works offline, including barcode resolution, pricing, payment recording, and receipt printing.
- **NFR-504**: Product search must remain responsive with a catalog of tens of thousands of items on a 2GB-RAM device. Search runs against a local index.
- **NFR-505**: The POS screen is visible to customers. It must not display cost prices, margins, other customers' data, or internal notes.
- **NFR-506**: The POS screen must be operable one-handed on a phone, and with a barcode scanner on a desktop terminal.
- **NFR-507**: Indonesian and English.

---

## 5. Data Entities (Conceptual)

### Sale

- `id`
- `storeId`
- `saleNumber` — Human-readable, per-store sequential
- `shiftId` — Which shift this belongs to
- `userId` — Who rang it up
- `customerId` — Null for anonymous walk-in
- `lines` — Array of SaleLine
- `subtotal`
- `discount` — { amount, reason, approvedBy? }
- `total`
- `payments` — References to PaymentRecord (PRD-003)
- `creditAmount` — Portion left unpaid, becomes a receivable
- `receivableId` — If a credit sale
- `status` — completed | voided
- `voidReason`, `voidApprovedBy`, `voidedAt`
- `sourceOrderId` — If this sale originated from a B2B catalog order
- `createdAt`

### SaleLine

- `productId`, `sku`, `name` — Name is denormalized; the receipt must reflect what was sold at the time, even if the product is later renamed
- `quantity`
- `unitPrice` — The price actually charged
- `priceBasis` — How the price was derived: { tier, volumeDiscountApplied, negotiatedDiscountApplied, manualDiscount }
- `lineTotal`
- `costAtSale` — Cost price at time of sale, captured for COGS. Never displayed in POS.

### Shift

- `id`
- `storeId`
- `userId`
- `openingFloat` — Cash in drawer at open
- `openedAt`, `closedAt`
- `status` — open | closed
- `reconciliationId` — Reference to the CashReconciliation (PRD-003)

### CatalogLink

- `id`
- `storeId`
- `token` — The public, unguessable component of the URL
- `customerId` — Null for anonymous
- `createdBy`
- `expiresAt`
- `status` — active | expired | consumed
- `createdAt`

### CatalogOrder

- `id`
- `catalogLinkId`
- `storeId`
- `customerId` — May be null if the link was anonymous; the store attaches a customer on confirmation
- `lines` — Array of { productId, sku, quantity }
- `contactNote` — Free text the visitor may leave
- `status` — pending | confirmed | rejected | fulfilled
- `saleId` — Set once confirmed and completed as a sale
- `submittedAt`

---

## 6. UI/UX Flows

### 6.1 The Sale Screen

This is the highest-traffic screen in the product and it should be the least cluttered. The whole screen serves one question: *what is being bought, and what is owed?*

Layout, on mobile:

- **Top:** customer selector. Defaults to "Umum" (anonymous). One tap to attach a customer. When a customer is attached, their tier is shown next to their name, because that's what changes the numbers.
- **Middle:** the cart. One row per line. Name, quantity stepper, line total. Tapping a row expands it to show why the price is what it is and to allow a line-level discount.
- **Persistent:** the total, always visible, never scrolled off.
- **Bottom:** two actions. A scan button (large, primary — this is what gets pressed hundreds of times a day) and a search field.
- **Bottom-right:** "Bayar" (Pay). Disabled while the cart is empty.

**On the scan button being primary:** the search field is the fallback, not the default. Most products have barcodes, most sales are scanned, and the scan action should be reachable without looking. Search is for the product whose barcode is rubbed off, which is common enough to need but rare enough not to lead with.

### 6.2 Payment

Tapping "Bayar" opens the shared payment component (PRD-003 §6.6). It shows the amount due and lets the cashier add payments until the remainder is zero — or until they choose to leave a remainder on credit, which is only offered when a customer is attached.

Cash is the first option, because cash is the most common. The amount-tendered field should accept common denominations as one-tap shortcuts (Rp 50rb, Rp 100rb, "uang pas") rather than requiring the cashier to type.

### 6.3 Completion

On completion: the receipt prints, and the screen returns to an empty cart, ready for the next customer. Change owed is displayed large and stays on screen until dismissed, because that's the number the cashier is about to count out of the drawer and it should not require scrolling to see.

No confirmation dialog. The sale is done; a dialog here just adds a tap to the most repeated flow in the product. Errors are handled by void, not by a modal that slows down every correct sale to guard against the rare wrong one.

### 6.4 Return

Entered from the sale history or by scanning a receipt's sale-number code. Select the lines coming back, submit for manager approval, refund on approval.

### 6.5 Shift Open / Close

Open: enter the opening float. One number, one screen.

Close: hands off to the cash reconciliation flow (PRD-003 §6.4). The cashier counts the drawer, enters the figure, and sees the variance. This is the moment the day's accountability is settled and it should feel routine rather than accusatory — a variance of a few thousand rupiah is normal and should be presented as such.

### 6.6 B2B Catalog (Customer-Facing)

A plain, fast web page. No login. It shows the products, the prices this customer gets, and a way to say "I want these." It is not a storefront and should not pretend to be one — no marketing, no imagery beyond product photos, no account creation.

The visitor picks quantities and submits. They see a confirmation that the store will be in touch. Nothing is committed on their side, and nothing leaves the store until a human at the store confirms it.

### 6.7 B2B Catalog (Store-Facing)

Generating a link: pick a customer (or anonymous), set an expiry, get a link. The link is shared via whatever channel the store already uses — most likely WhatsApp.

Incoming orders appear as a pending list. Confirming one opens it as a pre-filled cart in POS, which the cashier then completes normally. Rejecting one closes it with a note.

---

## 7. Edge Cases & Error States

- **Product has no barcode.** Search by name. The store may generate and print a barcode later (PRD-002 §3.11) but the sale must not be blocked.
- **Barcode resolves to nothing.** The product may not exist in this store's catalog, or may be from a store whose catalog was copied but modified. Offer to search, or to add the product on the fly (permission-gated).
- **Two products share a barcode.** Prompt the cashier to disambiguate. Log it — this is a catalog error someone needs to fix.
- **Insufficient stock.** Warn, do not block. Stock may be physically present but not yet recorded, and the customer is standing there. The system's job is to inform, not to refuse.
- **Customer attached after items are already in the cart.** Recalculate all lines to the new tier. Show the change clearly — the total will move, and the cashier must not be surprised by it in front of the customer.
- **Customer detached mid-cart.** Recalculate to retail.
- **Split payment doesn't reach the total, no customer attached.** The sale cannot complete. Either a customer is attached and the remainder becomes credit, or the payment must be completed.
- **QRIS in automatic mode, but the device is offline.** Fall back to manual QRIS confirmation (PRD-003 FR-221). The sale must not be blocked by a payment gateway being unreachable.
- **Printer unavailable at completion.** The sale still completes. Receipt printing is queued and retryable; the sale does not depend on it. Offer to retry or to skip.
- **App closes mid-cart.** The cart is held locally and restored on reopen.
- **Shift not opened.** Prompt to open one. Do not silently transact outside a shift — an unattributed sale is an accountability hole.
- **Two devices, same cashier, same shift.** The shift is per user per store, not per device. Sales from both devices attribute to the same shift, and the reconciliation covers all of them.
- **Void of a sale whose receivable is partially paid.** The void must reverse the payments received as well. This is messy and should require manager approval with the situation shown explicitly, not hidden behind a generic "void" button.
- **Catalog link shared beyond its intended customer.** The link is public and carries that customer's prices. This is an accepted risk of an unauthenticated link. Mitigations: short expiry, per-transaction generation, and the fact that an order is only a request — nothing ships without store confirmation.
- **Catalog order arrives for a product that has since sold out.** The store confirms with an adjusted quantity, or rejects. The order is a request; the store's confirmation is the truth.

---

## 8. Fraud Prevention Measures

POS is where cash touches the business, and it deserves specific attention rather than generic controls.

- **Every sale is attributed to a user, not a device.** PIN quick-switch means the audit trail names a person. A shared "Kasir" login destroys this, which is why individual accounts are the design (ARCH-001 §4.1).
- **Voids are the primary cash-theft vector.** Ring up a real sale, take the customer's cash, void the sale, keep the money. Countermeasures: voids require manager approval, require a reason, never delete the original record, and void rate per cashier is reported (PRD-005 §8).
- **Discounts are the secondary vector.** Discount a friend's purchase, or discount and pocket the difference. Countermeasures: discounts require a reason, large discounts require approval, and discount volume per cashier is reported.
- **Unrecorded cash sales.** The hardest to catch, because nothing is written down. The signal is indirect: a cashier whose payment mix drifts away from cash relative to peers, or a store whose cash share falls without explanation. This is why payment method mix is a reported metric (PRD-005 FR-438).
- **Cash reconciliation is the daily check.** A cashier consistently short by a small amount is a pattern; a cashier occasionally short by a large amount is an error. The reports must show the trend, not just the day (PRD-003 §3.6, PRD-005 FR-439).
- **Cost price is never shown in POS.** Not because the cashier can't be trusted with it, but because the customer is looking at the screen.
- **Overselling is permitted, and that is a deliberate accepted risk** (ARCH-001). It means stock can go negative, which is itself a signal worth reporting — a product that regularly goes negative is either badly counted or being removed without record.

---

## 9. Interactions With Other Modules

POS is thin. Most of what happens in a sale is other modules doing their work. This is deliberate and should be preserved in implementation — POS should not reimplement pricing, payment, or accounting.

| Concern | Owned by |
|---|---|
| Product data, stock levels, pricing calculation | Inventory (PRD-002) |
| Payment methods, split payment, QRIS | Finance (PRD-003 §3.5) |
| Journal entries, COGS, revenue recognition | Finance (PRD-003 §3.2) |
| Receivables from credit sales | Finance (PRD-003 §3.3) |
| Cash reconciliation at shift close | Finance (PRD-003 §3.6) |
| Customer records and tiers | CRM |
| Customer return approval and stock restoration | Inventory (PRD-002 §3.10) |
| Cashier performance and fraud reporting | Reporting (PRD-005) |

What POS owns: the cart, the sale record, the shift, the receipt, and the B2B catalog.

---

## 10. Open Questions

- **OQ-501**: Should a cashier be able to create a product on the fly when a barcode doesn't resolve, or must that go through inventory management? On-the-fly creation is faster but pollutes the catalog. Suggested: permission-gated, off by default.
- **OQ-502**: What is the discount threshold above which manager approval is required? Absolute or percentage? Percentage is more robust across price ranges.
- **OQ-503**: Should the opening float be entered by the cashier or set by the store owner? Cashier-entered is simpler; owner-set is harder to game.
- **OQ-504**: How long should a catalog link live by default? Suggested: 7 days.
- **OQ-505**: Should the B2B catalog show live stock, or just hide out-of-stock items? Showing live stock reveals inventory levels to a customer who may be a competitor.
- **OQ-506**: Sale numbering — per store, or globally unique across the tenant? Per store is more readable; global is easier to trace in support.
- **OQ-507**: Is any store currently registered as PKP? If none are and none are near Rp 4.8B revenue, PPN and e-Faktur can be dropped from V1 entirely rather than merely disabled.

---

## 11. Note on Indonesian Tax & Receipt Requirements

**This section exists to correct an assumption made earlier in planning.** It was initially assumed that POS receipts carry legal format requirements. Research indicates this is not the case for these stores.

**Findings:**

- The obligation to charge PPN attaches to being a **PKP (Pengusaha Kena Pajak)**. The threshold is **Rp 4.8 billion annual revenue**. Below it, a business is not required to register and does not collect PPN. A phone repair store in West Papua is very unlikely to reach this.
- A non-PKP business issues an ordinary sales receipt (**struk**), which has **no mandated legal format**. It can contain whatever is operationally useful.
- If a store *is* PKP, tax invoices must be issued through DJP's **e-Faktur** system (integrated with Coretax as of 2026), which requires an electronic certificate, DJP-issued serial numbers, and server-side validation that returns a QR code. This is a government system integration and is **online-only by nature** — an invoice is not valid until DJP validates it, which conflicts directly with this system's offline-first design.
- PKP retailers benefit from a simplification (**Faktur Pajak Digunggung**): they need not record each buyer's identity on each receipt, and report in aggregate instead.
- Separately, MSME income tax is a **0.5% final rate on gross revenue**, with the first **Rp 500 million** of annual revenue exempt for individual taxpayers. This is computed from revenue totals the system already tracks — it is a reporting output, not a POS feature.

**Implications for the build:**

1. **V1 POS has no tax compliance work.** Design the receipt for operational usefulness.
2. **PPN remains optional and disabled by default** (PRD-003 §3.9).
3. **e-Faktur integration is a separate, later, SaaS-tier feature.** It does not belong in POS, it does not belong in V1, and it cannot be made offline-first. It should be scoped as its own module if and when a tenant needs it.
4. **Confirm PKP status with the business owners** before writing any of it off permanently.

**Caveat:** Indonesian tax regulation moved in 2025 and again in 2026 (PMK 131/2024, PP 20/2026). This should be re-verified before any tenant relies on it, and the system should not present itself as giving tax advice.

---

## 12. Claude Code Task Breakdown

### TASK-POS-001: Sale & Shift Data Model

**Context:** Core entities and operations for POS. Sales are append-only; voids are reversing operations, never deletions.

**Acceptance Criteria:**
- [ ] Sale, SaleLine, Shift types per §5
- [ ] Operations: `sale.completed`, `sale.voided`, `shift.opened`, `shift.closed`
- [ ] Sale projection
- [ ] Per-store sequential sale numbering that survives offline operation (no central counter)
- [ ] `costAtSale` captured on every line for COGS, never exposed to the POS surface
- [ ] Product name denormalized onto the line so historical receipts remain accurate after renames
- [ ] Reversal pattern documented for each operation (per ARCH-001 §9.2)

**Depends On:** Platform Core, Inventory (products), CRM (customers)

**Relevant PRD Sections:** §3.5, §3.7, §5

**Notes for Implementation:**
- Sale numbering offline is the subtle part. A per-store sequence can't be centrally allocated when devices are partitioned. Consider a per-device prefix or a monotonic local sequence reconciled at sync — but the number must be human-readable and stable once issued, because it's printed on the customer's receipt.

---

### TASK-POS-002: Cart & Pricing

**Context:** The cart, and its integration with the pricing engine. POS does not compute prices — it calls PRD-002's pricing engine and displays the result.

**Acceptance Criteria:**
- [ ] Add by barcode scan (manufacturer and generated barcodes)
- [ ] Add by search (name, SKU, barcode; tolerant of partial and misspelled input)
- [ ] Re-scan increments quantity rather than duplicating a line
- [ ] Quantity adjust and line removal
- [ ] Attach/detach customer, recalculating all lines to the new tier
- [ ] Price basis shown per line (tier, volume discount, negotiated discount)
- [ ] Manual discount with mandatory reason; approval required above threshold
- [ ] Insufficient-stock warning that does not block
- [ ] Cart persists locally across app restarts
- [ ] Search responsive against a large catalog on a 2GB device

**Depends On:** TASK-POS-001, Inventory (TASK-INV-012 pricing engine, TASK-INV-011 barcode)

**Relevant PRD Sections:** §3.1, §3.2, §3.3, §6.1

---

### TASK-POS-003: Sale Completion

**Context:** The act that turns a cart into a sale, and fans out to inventory, payments, and accounting. This must be atomic from the user's perspective and must work offline.

**Acceptance Criteria:**
- [ ] Invokes the shared payment component (TASK-FIN-003)
- [ ] Split payment across methods
- [ ] Credit sale path: remainder becomes a receivable; requires an attached customer
- [ ] Emits stock movement operations for every line
- [ ] Triggers journal entry generation (revenue and COGS)
- [ ] Creates the receivable when a balance remains
- [ ] Triggers receipt printing
- [ ] Entire path works offline
- [ ] Sale is terminal once completed — no edit path exists

**Depends On:** TASK-POS-002, TASK-FIN-003, TASK-FIN-002, TASK-INV-002

**Relevant PRD Sections:** §3.4, §3.5

---

### TASK-POS-004: Receipt

**Context:** Thermal receipt printing. No tax fields — see §11.

**Acceptance Criteria:**
- [ ] Thermal format with all fields in FR-530
- [ ] Outstanding balance shown for credit sales
- [ ] Sale number in scannable form
- [ ] Reprint, marked as reprint
- [ ] Prints from local data, offline
- [ ] Print failure does not block or roll back the sale; printing is queued and retryable

**Depends On:** TASK-POS-003, Repair module's printer integration (TASK-REP-010) — share the printer layer, don't build a second one

**Relevant PRD Sections:** §3.6, §11

---

### TASK-POS-005: Void

**Context:** Reversing a completed sale. A primary fraud vector, so the controls matter as much as the mechanics.

**Acceptance Criteria:**
- [ ] Manager approval required
- [ ] Reason required
- [ ] Restores inventory
- [ ] Reverses journal entries (reversing entries, not deletions)
- [ ] Reverses or refunds payments
- [ ] Closes any receivable created by the sale
- [ ] Handles the partially-paid-receivable case explicitly, showing the situation before confirming
- [ ] Original sale record preserved, marked voided
- [ ] Void events feed per-cashier void rate reporting

**Depends On:** TASK-POS-003, TASK-FIN-002

**Relevant PRD Sections:** §3.7, §7, §8

---

### TASK-POS-006: Returns (POS Surface)

**Context:** The POS-side entry point for customer returns. The approval and stock logic live in Inventory (PRD-002 §3.10).

**Acceptance Criteria:**
- [ ] Locate original sale by scanning the receipt code, typing the sale number, or by customer
- [ ] Select lines and quantities to return
- [ ] Submit for manager approval
- [ ] On approval: stock restored, refund issued
- [ ] Return against an unpaid credit sale reduces the receivable instead of refunding cash
- [ ] Return linked to the original sale

**Depends On:** TASK-POS-003, TASK-INV-009

**Relevant PRD Sections:** §3.8

---

### TASK-POS-007: Shift Management

**Context:** Opening and closing a cashier's shift, and the accountability boundary it creates.

**Acceptance Criteria:**
- [ ] Open shift with opening float
- [ ] Block (or prompt) transacting without an open shift
- [ ] Every sale attributed to shift + user
- [ ] Shift is per user per store, not per device — sales from multiple devices roll into one shift
- [ ] Close shift hands off to cash reconciliation (TASK-FIN-006)
- [ ] Long-open shift prompts the cashier and notifies the store owner

**Depends On:** TASK-POS-001, TASK-FIN-006, Auth (PIN quick-switch)

**Relevant PRD Sections:** §3.9

---

### TASK-POS-008: B2B Catalog — Link Generation & Order Intake (Store Side)

**Context:** The store-facing half of the catalog feature.

**Acceptance Criteria:**
- [ ] Generate a link for a specific customer or anonymously
- [ ] Configurable expiry, default per OQ-504
- [ ] Unguessable token
- [ ] Pending order list
- [ ] Confirm an order → opens as a pre-filled cart in POS
- [ ] Reject an order with a note
- [ ] Order is never a sale until completed through the normal POS flow

**Depends On:** TASK-POS-002, CRM

**Relevant PRD Sections:** §3.10, §6.7

---

### TASK-POS-009: B2B Catalog — Customer-Facing Page

**Context:** The public, unauthenticated page a wholesale customer opens. Requires connectivity by nature — it is a web page, not part of the offline app.

**Acceptance Criteria:**
- [ ] Public, no login
- [ ] Shows the linked customer's tier prices; retail prices for anonymous links
- [ ] Never exposes cost price, other tiers, or internal data
- [ ] Product selection with quantities
- [ ] Submit order; visitor sees confirmation that the store will follow up
- [ ] Hides out-of-stock products (pending OQ-505)
- [ ] Expired link shows a clear message, not an error
- [ ] Fast on a poor mobile connection — this is West Papua, and the customer is on 3G

**Depends On:** TASK-POS-008

**Relevant PRD Sections:** §3.10, §6.6
