# PRD-003: Financial Accounting

> **Earlier product proposal — discussion reference, not approved implementation scope.**
> Preserved from `ai-docs/PRD-003-financial-accounting.md` at `06b063b`, with the generated
> task breakdown removed. Read [product direction](../product-direction.md) and
> [current repair scope](../product-scope.md) first. Later owner decisions override
> this text. Historical “Must”, “V1”, deadlines, technical designs, metrics and
> open questions are proposals to revalidate, not instructions to execute or
> claims about implemented behavior. Read only the relevant sections when scoping
> this feature; see the [reference guide](README.md) for known superseded ideas.

## 1. Overview

### Problem Statement

Franchise stores handle cash, digital payments, credit transactions (hutang), and supplier obligations with no unified accounting system. The franchise owner cannot see financial performance across stores. Store owners have zero accounting knowledge and cannot be expected to learn double-entry bookkeeping. Yet the system must produce accurate financial reports, support tax compliance, and maintain a professional-grade ledger for accountants.

### Goals

- Implement full accrual double-entry accounting that is completely invisible to non-accountant users
- Automatically generate journal entries for every business transaction (sales, purchases, payments, adjustments) without user intervention
- Provide simple, intuitive financial views for store owners (revenue, expenses, profit — never debits/credits)
- Provide a professional "accountant mode" that exposes the full general ledger, chart of accounts, and journal entries
- Support accounts receivable (piutang — B2B customers buying on credit)
- Support accounts payable (hutang — amounts owed to suppliers)
- Track supplier payment terms and alert on upcoming/overdue payments
- Support multiple payment methods with split payment capability
- Support cash reconciliation at end of shift
- Support optional Indonesian tax compliance (PPn, tax invoices)
- Work fully offline

### Success Metrics

- 100% of business transactions auto-generate correct journal entries (no manual accounting)
- Store owners can understand their financial position within 30 seconds of opening the dashboard
- Zero discrepancies between the ledger and the individual module records (sales, inventory, etc.)
- Cash reconciliation variance detectable within minutes of shift end
- Accountant can produce standard financial statements (P&L, balance sheet) from the system

---

## 2. User Stories

### Invisible Accounting (Auto-Generated)

- **US-201** [P0]: Sebagai sistem, saya ingin otomatis mencatat jurnal akuntansi setiap kali ada transaksi bisnis (penjualan, pembelian, pembayaran, penyesuaian), sehingga buku besar selalu akurat tanpa input manual.
  _(As the system, I want to automatically record accounting journals whenever a business transaction occurs (sale, purchase, payment, adjustment), so the ledger is always accurate without manual input.)_

- **US-202** [P0]: Sebagai pemilik toko, saya ingin melihat ringkasan keuangan (pendapatan, pengeluaran, laba) tanpa perlu memahami debit/kredit, sehingga saya bisa mengelola bisnis.
  _(As a store owner, I want to see a financial summary (revenue, expenses, profit) without needing to understand debit/credit, so I can manage the business.)_

### Accounts Receivable (Piutang)

- **US-203** [P0]: Sebagai kasir, saya ingin mencatat penjualan kredit ke pelanggan B2B (hutang pelanggan), sehingga piutang tercatat.
  _(As a cashier, I want to record a credit sale to a B2B customer (customer debt), so the receivable is recorded.)_

- **US-204** [P0]: Sebagai kasir, saya ingin menerima pembayaran piutang dari pelanggan, sehingga saldo piutang berkurang.
  _(As a cashier, I want to receive a receivable payment from a customer, so the receivable balance decreases.)_

- **US-205** [P1]: Sebagai pemilik toko, saya ingin melihat daftar piutang yang belum dibayar beserta umurnya, sehingga saya bisa menagih yang sudah jatuh tempo.
  _(As a store owner, I want to see a list of unpaid receivables with their aging, so I can follow up on overdue ones.)_

### Accounts Payable (Hutang ke Supplier)

- **US-206** [P0]: Sebagai sistem, saya ingin otomatis mencatat hutang ke supplier saat purchase order diterima, sehingga kewajiban tercatat.
  _(As the system, I want to automatically record payable to supplier when a purchase order is received, so the obligation is recorded.)_

- **US-207** [P0]: Sebagai pemilik toko, saya ingin mencatat pembayaran ke supplier, sehingga saldo hutang berkurang.
  _(As a store owner, I want to record a payment to supplier, so the payable balance decreases.)_

- **US-208** [P1]: Sebagai pemilik toko, saya ingin diingatkan tentang hutang yang akan jatuh tempo, sehingga saya tidak terlambat bayar.
  _(As a store owner, I want to be reminded about payables nearing due date, so I don't pay late.)_

### Payments

- **US-209** [P0]: Sebagai kasir, saya ingin menerima pembayaran dengan berbagai metode (tunai, QRIS, EDC, transfer bank) dan mendukung split payment, sehingga pelanggan bisa bayar sesuai preferensi mereka.
  _(As a cashier, I want to accept payments via multiple methods (cash, QRIS, EDC, bank transfer) and support split payment, so customers can pay according to their preference.)_

- **US-210** [P0]: Sebagai kasir, saya ingin QRIS bisa diproses secara manual (tandai sebagai diterima) ATAU otomatis (generate QR, detect pembayaran), sehingga toko bisa memilih cara yang paling sesuai.
  _(As a cashier, I want QRIS to work manually (mark as received) OR automatically (generate QR, detect payment), so the store can choose the most suitable method.)_

### Cash Management

- **US-211** [P0]: Sebagai kasir, saya ingin melakukan rekonsiliasi kas di akhir shift (menghitung uang tunai dan membandingkan dengan catatan sistem), sehingga selisih terdeteksi.
  _(As a cashier, I want to do cash reconciliation at end of shift (count cash and compare with system records), so discrepancies are detected.)_

- **US-212** [P1]: Sebagai pemilik toko, saya ingin melihat riwayat rekonsiliasi kas dan selisihnya, sehingga saya bisa memantau integritas kasir.
  _(As a store owner, I want to see cash reconciliation history and variances, so I can monitor cashier integrity.)_

### Accountant Mode

- **US-213** [P1]: Sebagai akuntan, saya ingin mengakses buku besar, chart of accounts, dan jurnal entry, sehingga saya bisa melakukan audit dan membuat laporan keuangan.
  _(As an accountant, I want to access the general ledger, chart of accounts, and journal entries, so I can perform audits and generate financial statements.)_

- **US-214** [P1]: Sebagai akuntan, saya ingin membuat laporan laba rugi dan neraca untuk setiap toko dan keseluruhan jaringan, sehingga performa keuangan terukur.
  _(As an accountant, I want to generate P&L and balance sheet reports per store and network-wide, so financial performance is measurable.)_

### Tax

- **US-215** [P2]: Sebagai pemilik toko, saya ingin sistem mendukung perhitungan PPn (opsional) dan penomoran faktur pajak, sehingga toko yang perlu bisa comply.
  _(As a store owner, I want the system to support VAT (PPn) calculation (optional) and tax invoice numbering, so stores that need to can comply.)_

---

## 3. Functional Requirements

### 3.1 Chart of Accounts

- **FR-201** [Must]: System shall maintain a default chart of accounts suitable for Indonesian MSMEs. Accounts shall include at minimum:
  - Assets: Cash, Bank, Accounts Receivable, Inventory
  - Liabilities: Accounts Payable
  - Revenue: Sales Revenue, Service Revenue (Repairs)
  - Expenses: Cost of Goods Sold, Operating Expenses
  - Equity: Owner's Equity
- **FR-202** [Must]: The chart of accounts shall be pre-configured on store creation. No manual setup required.
- **FR-203** [Should]: Accountant mode shall allow adding custom accounts (sub-accounts under the defaults).
- **FR-204** [Should]: Each store shall have its own chart of accounts instance (for independent P&L).

### 3.2 Automatic Journal Entry Generation

- **FR-205** [Must]: The system shall automatically generate double-entry journal entries for every business transaction. The user shall never manually create journal entries during normal operations.
- **FR-206** [Must]: Transaction-to-journal mappings shall include (at minimum):

| Business Transaction                 | Debit                     | Credit                      |
| ------------------------------------ | ------------------------- | --------------------------- |
| POS sale (cash)                      | Cash                      | Sales Revenue               |
| POS sale (QRIS/EDC/transfer)         | Bank                      | Sales Revenue               |
| POS sale (credit/hutang)             | Accounts Receivable       | Sales Revenue               |
| POS sale (split: cash + QRIS)        | Cash + Bank               | Sales Revenue               |
| Repair payment received (cash)       | Cash                      | Service Revenue             |
| Repair payment received (partial/DP) | Cash                      | Unearned Revenue            |
| Repair completed (DP applied)        | Unearned Revenue          | Service Revenue             |
| Goods received from supplier (PO)    | Inventory                 | Accounts Payable            |
| Parts consumed in repair             | Cost of Goods Sold        | Inventory                   |
| Product sold (COGS)                  | Cost of Goods Sold        | Inventory                   |
| Supplier payment made                | Accounts Payable          | Cash/Bank                   |
| Customer receivable payment received | Cash/Bank                 | Accounts Receivable         |
| Customer return/refund               | Sales Revenue + Inventory | Cash/Bank + COGS            |
| Stock adjustment (loss)              | Loss/Shrinkage Expense    | Inventory                   |
| Stock adjustment (found)             | Inventory                 | Gain/Adjustment Income      |
| Supplier return (refund)             | Cash/AP                   | Inventory                   |
| Supplier return (replacement)        | Inventory                 | Inventory (on-hold cleared) |

- **FR-207** [Must]: Each journal entry shall reference the originating operation (repair ticket, sale, PO, etc.) for traceability.
- **FR-208** [Must]: The ledger must always balance (total debits = total credits). Any imbalance shall be flagged as a system error.

### 3.3 Accounts Receivable (Piutang)

- **FR-209** [Must]: When a B2B sale is made on credit (hutang), an AR record shall be created with: customer, amount, reference (sale ID), due date (optional).
- **FR-210** [Must]: Partial payments against AR shall be supported. Each payment reduces the outstanding balance.
- **FR-211** [Must]: AR list view shall show: customer, original amount, paid amount, remaining, age (days since creation), status (open/partial/paid/overdue).
- **FR-212** [Should]: System shall automatically mark AR as "overdue" when past due date.
- **FR-213** [Won't]: No credit limits for now. B2B customers can hutang without limit.

### 3.4 Accounts Payable (Hutang ke Supplier)

- **FR-214** [Must]: When goods are received against a PO, an AP record shall be automatically created with: supplier, amount, PO reference, payment terms, due date.
- **FR-215** [Must]: Partial payments against AP shall be supported.
- **FR-216** [Must]: AP list view shall show: supplier, original amount, paid amount, remaining, due date, days until due, status.
- **FR-217** [Should]: System shall display alerts for AP records approaching or past due date.
- **FR-218** [Should]: Supplier return refunds shall reduce/close the corresponding AP record.

### 3.5 Payment Processing

- **FR-219** [Must]: System shall support the following payment methods: Cash, QRIS, EDC (debit/credit card), Bank Transfer. Additional methods may be added.
- **FR-220** [Must]: Split payments across multiple methods shall be supported (e.g., Rp 100,000 cash + Rp 150,000 QRIS).
- **FR-221** [Must]: QRIS shall support two modes:
  - Manual: Cashier selects QRIS, customer scans store's static QR, cashier manually confirms payment received.
  - Automatic: System generates a dynamic QR code for the exact amount, detects payment via gateway integration.
- **FR-222** [Must]: Each payment shall be recorded as a separate operation with: method, amount, reference (transaction ID for digital payments), timestamp.
- **FR-223** [Should]: Payment receipts shall be separate from repair order receipts (a payment receipt documents the payment, a repair receipt documents the repair).

### 3.6 Cash Reconciliation

- **FR-224** [Must]: At end of shift, cashier initiates a cash reconciliation.
- **FR-225** [Must]: System shall show: expected cash in drawer (based on all cash transactions during shift).
- **FR-226** [Must]: Cashier enters the physically counted cash amount.
- **FR-227** [Must]: System displays the variance (counted − expected).
- **FR-228** [Must]: Variance shall be logged as an operation (with cashier, timestamp, variance amount).
- **FR-229** [Should]: Significant variances (above a configurable threshold) shall alert the store owner.
- **FR-230** [Should]: Reconciliation history shall be viewable by store owner with trend analysis.

### 3.7 Simple Financial Views (Non-Accountant Users)

- **FR-231** [Must]: Store owner dashboard shall show, in plain language:
  - Revenue today / this week / this month
  - Expenses today / this week / this month
  - Profit (revenue − expenses)
  - Outstanding receivables (total piutang)
  - Outstanding payables (total hutang supplier)
  - Cash in drawer (current estimate)
- **FR-232** [Must]: These views shall NEVER use accounting terminology (no "debit," "credit," "journal," "ledger").
- **FR-233** [Must]: Store owner shall be able to view financial data for their own store(s) only. Store owners with multiple stores shall see aggregated views with drill-down.
- **FR-234** [Must]: Main owner shall be able to view financial data across all stores with per-store breakdown.

### 3.8 Accountant Mode

- **FR-235** [Must]: A toggleable "Accountant Mode" shall expose:
  - Full chart of accounts
  - General ledger (all journal entries, filterable by date range, account, store)
  - Trial balance
  - Profit & Loss statement (per store and consolidated)
  - Balance sheet (per store and consolidated)
- **FR-236** [Must]: Accountant mode shall be accessible only to users with "accountant" permission.
- **FR-237** [Should]: Journal entries shall be viewable with their originating transaction reference (click to navigate to the source repair, sale, PO, etc.).
- **FR-238** [Should]: Accountant shall be able to create manual journal entries for adjustments not covered by automatic rules (e.g., depreciation, year-end adjustments).

### 3.9 Tax Support (Optional)

- **FR-239** [Could]: System shall support optional PPn (Value Added Tax) calculation on sales.
- **FR-240** [Could]: System shall support sequential tax invoice numbering per store.
- **FR-241** [Could]: Tax features shall be enableable per store (not all stores may need it).
- **FR-242** [Could]: Research specific Indonesian tax requirements (PPn rate, PPh, reporting formats) for implementation accuracy.

---

## 4. Non-Functional Requirements

- **NFR-201**: All financial operations must work fully offline. Journal entries are generated locally and synced.
- **NFR-202**: The ledger must be eventually consistent across devices after sync. Within a single device, it must always balance.
- **NFR-203**: Financial data (especially cost prices, margins, revenue) must be strictly permission-gated.
- **NFR-204**: Simple financial views must load in under 3 seconds on low-end devices (projections, not real-time calculation from full ledger).
- **NFR-205**: The system must not expose any accounting terminology (debit/credit, journal entry, chart of accounts) to non-accountant users under any circumstances.
- **NFR-206**: All financial amounts shall be stored in the smallest currency unit (IDR has no sub-units, so integer Rupiah) to avoid floating-point issues.

---

## 5. Data Entities (Conceptual)

### Account (Chart of Accounts)

- `id` — Unique identifier
- `storeId` — Which store (each store has its own CoA instance)
- `code` — Account code (e.g., "1000", "1100", "4000")
- `name` — Account name (e.g., "Kas", "Piutang Usaha", "Pendapatan Penjualan")
- `type` — asset | liability | equity | revenue | expense
- `parentId` — For sub-accounts (optional)
- `isSystem` — Boolean (system-generated accounts cannot be deleted)
- `isActive` — Boolean

### JournalEntry

- `id` — Unique identifier
- `storeId`
- `date` — Transaction date
- `description` — Human-readable description (auto-generated from transaction)
- `lines` — Array of JournalLine:
  - `accountId` — Reference to Account
  - `debit` — Amount (0 if credit)
  - `credit` — Amount (0 if debit)
- `sourceOperationType` — e.g., "sale.completed", "repair.picked_up", "purchase_order.received"
- `sourceOperationId` — Reference to the originating operation
- `createdAt`

### AccountReceivable

- `id` — Unique identifier
- `storeId`
- `customerId` — Reference to Customer
- `referenceType` — "sale" | "repair"
- `referenceId` — Sale or Repair ID
- `originalAmount` — Initial amount owed
- `paidAmount` — Total paid so far
- `remainingAmount` — originalAmount − paidAmount
- `dueDate` — Optional due date
- `status` — open | partial | paid | overdue | written_off
- `payments` — Array of { id, amount, method, paidAt, receivedBy }
- `createdAt`

### AccountPayable

- `id` — Unique identifier
- `storeId`
- `supplierId` — Reference to Supplier
- `purchaseOrderId` — Reference to PO
- `originalAmount`
- `paidAmount`
- `remainingAmount`
- `paymentTerms` — e.g., "net_30", "net_60", "cod"
- `dueDate`
- `status` — open | partial | paid | overdue
- `payments` — Array of { id, amount, method, paidAt, reference }
- `createdAt`

### PaymentRecord

- `id` — Unique identifier
- `storeId`
- `type` — "incoming" (customer pays us) | "outgoing" (we pay supplier)
- `method` — cash | qris | edc | bank_transfer
- `amount`
- `reference` — Transaction ID for digital payments
- `relatedEntityType` — "sale" | "repair" | "ar" | "ap"
- `relatedEntityId`
- `userId` — Who processed this payment
- `timestamp`

### CashReconciliation

- `id` — Unique identifier
- `storeId`
- `userId` — Cashier who performed reconciliation
- `shiftDate` — Date of the shift
- `expectedCash` — System-calculated expected cash
- `countedCash` — Physically counted amount
- `variance` — countedCash − expectedCash
- `notes` — Optional notes from cashier
- `timestamp`

---

## 6. UI/UX Flows

### 6.1 Store Owner Financial Dashboard (Simple View)

**This is the DEFAULT financial view. No accounting terminology.**

```
┌──────────────────────────────────────────┐
│  Keuangan Hari Ini          [📅 filter]  │
│                                          │
│  💰 Pemasukan      Rp 5.250.000         │
│  💸 Pengeluaran    Rp 2.100.000         │
│  📈 Keuntungan     Rp 3.150.000         │
│                                          │
│  ─────────────────────────────────────── │
│                                          │
│  Piutang Belum Dibayar    Rp 12.500.000 │
│    ├ 3 pelanggan jatuh tempo             │
│                                          │
│  Hutang ke Supplier       Rp 8.300.000  │
│    ├ 1 akan jatuh tempo minggu ini       │
│                                          │
│  Kas di Laci (estimasi)   Rp 1.850.000  │
│                                          │
└──────────────────────────────────────────┘
```

- Tap any number to drill down (e.g., tap piutang → see AR list)
- Period filter: today / this week / this month / custom range
- For store owners with multiple stores: aggregated view + per-store tabs

### 6.2 AR (Piutang) List

- Table: Customer | Total Hutang | Sudah Bayar | Sisa | Umur | Status
- Filter by: status (belum lunas, jatuh tempo), customer
- Tap row → payment history + "Terima Pembayaran" (Receive Payment) button
- Receive payment flow: enter amount → select method → confirm

### 6.3 AP (Hutang Supplier) List

- Table: Supplier | Total Hutang | Sudah Bayar | Sisa | Jatuh Tempo | Status
- Filter by: status, supplier, due date range
- Alert badges on approaching/overdue items
- Tap row → payment history + "Bayar" (Pay) button
- Pay flow: enter amount → select method → reference number → confirm

### 6.4 Cash Reconciliation Flow

**End-of-shift flow:**

1. Cashier selects "Rekonsiliasi Kas" (Cash Reconciliation)
2. System shows: "Kas yang seharusnya di laci: Rp 1.850.000" (Expected cash)
3. Cashier counts physical cash and enters amount: "Kas yang dihitung: Rp ______"
4. System shows variance:
   - Green ✓ if within threshold (e.g., ± Rp 5,000)
   - Yellow ⚠ if moderate variance
   - Red ✗ if significant variance
5. Cashier can add notes
6. Submit → logged as operation
7. If significant variance → store owner notified

### 6.5 Accountant Mode

- Toggle in settings (only visible to users with accountant permission)
- Reveals additional navigation items:
  - **Buku Besar** (General Ledger): All journal entries, filterable
  - **Daftar Akun** (Chart of Accounts): Full CoA with balances
  - **Neraca Saldo** (Trial Balance)
  - **Laba Rugi** (P&L Statement): per period, per store
  - **Neraca** (Balance Sheet): per store or consolidated
- Each journal entry shows: date, description, debit/credit lines, source link
- Can create manual journal entries (for adjustments only)

### 6.6 Payment Processing (Shared Component)

Used by POS sales, repair payments, and AR collection:

1. Show amount due
2. "Tambah Pembayaran" (Add Payment) → select method:
   - **Tunai (Cash)**: Enter amount tendered → show change
   - **QRIS**: Manual mode (confirm received) OR auto mode (generate QR → wait for confirmation)
   - **EDC**: Enter reference number → confirm
   - **Transfer Bank**: Enter reference number → confirm
3. For split payments: repeat "Add Payment" with different methods
4. Running total: Amount Due − Paid So Far = Remaining
5. When remaining = 0 → "Selesai" (Complete) button enabled

---

## 7. Edge Cases & Error States

- **Split payment doesn't add up:** If total payments < amount due, remaining balance becomes AR (if B2B) or must be completed (if retail POS).
- **Overpayment:** If cash tendered exceeds amount, system calculates change. For digital payments, overpayment should not be possible (exact amount entered).
- **Cash reconciliation with multiple cashiers:** If multiple people use the same shift, reconciliation is per-shift (not per-person). If using PIN-based switching, reconciliation could be per-person in the future.
- **Offline journal entries:** Generated locally, synced later. If two devices generate entries for the same logical time, they're separate entries (no conflict — append-only).
- **Supplier return refund vs. replacement:** Refund reduces AP; replacement adds stock. Both must generate correct journal entries.
- **Void/cancelled sale after journal entry:** System generates a reversing journal entry, never deletes the original.
- **Stock adjustment creates accounting entry:** Loss adjustments debit a shrinkage/loss expense account; found adjustments credit a gain account.
- **Tax on/off per store:** Stores with tax enabled include PPn in journal entries; stores without it don't. This must not break consolidated reports.

---

## 8. Fraud Prevention Measures

- **Immutable journal entries:** Journal entries are never edited or deleted. Corrections are done via reversing entries.
- **Cash reconciliation trail:** Every shift-end reconciliation is logged with expected vs. counted. Store owner can see trends (consistent shortages flag dishonest cashier).
- **Payment method tracking:** All non-cash payments have reference numbers that can be verified against bank/payment provider records.
- **Void audit trail:** Voided sales generate reversing entries with the reason and approver. Cannot void without manager approval.
- **COGS tracking:** Cost of goods sold is tracked for every sale and repair, preventing unrecorded inventory removal.

---

## 9. Open Questions

- **OQ-201**: What is the standard PPn rate in Indonesia? (Currently 11%, research if changed.) What are the specific tax invoice format requirements?
- **OQ-202**: For QRIS automatic mode, which payment gateway should be integrated? (e.g., Midtrans, Xendit, DANA, GoPay). What are the costs and integration complexity?
- **OQ-203**: Should the system support expense tracking beyond COGS and AP? (e.g., rent, utilities, salaries — manually entered expenses.) If yes, this expands the accountant mode significantly.
- **OQ-204**: For cash reconciliation, should the system track the opening cash balance (float) at shift start?
- **OQ-205**: Should down payments for repairs create an "Unearned Revenue" liability until the repair is completed? (This is the correct accrual accounting treatment. Suggested: yes.)
- **OQ-206**: How should the chart of accounts be structured for multi-store consolidated reports? Same account codes across stores, or store-prefixed?

---
