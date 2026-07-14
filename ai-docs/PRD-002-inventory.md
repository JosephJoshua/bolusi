# PRD-002: Inventory Management

## 1. Overview

### Problem Statement

Franchise stores manage thousands of spare parts and accessories across multiple locations with no unified inventory system. Stock levels are tracked manually, leading to overselling, undetected theft, pricing inconsistencies, and inability for the franchise owner to see inventory across the network. Stores need to support retail sales (POS), parts consumption for repairs, cross-store procurement, supplier management, and stock counting — all while working offline.

### Goals

- Provide real-time (within sync window) inventory visibility per store and across the network
- Support tiered pricing (configurable customer tiers with per-product pricing)
- Support volume discounts layered on top of tier pricing
- Enable cross-store product catalog sharing (copy from another store, modify independently)
- Track all stock movements via append-only operations for full auditability
- Support stock opname (physical counting) with discrepancy resolution
- Support supplier returns with replacement/refund tracking
- Manage procurement with configurable cross-store dependency graph
- Keep purchasing costs hidden from unauthorized roles

### Success Metrics

- Zero unaccounted inventory discrepancies (all movements logged)
- Stock opname completable in one session per store
- New store can be set up with full product catalog in under 30 minutes (via copy)
- Owner has network-wide inventory visibility within one sync cycle

---

## 2. User Stories

### Products & Catalog

- **US-101** [P0]: Sebagai pemilik toko, saya ingin mengelola daftar produk (suku cadang & aksesoris) di toko saya, sehingga sistem tahu apa yang kami jual dan stoknya.
  *(As a store owner, I want to manage the product list (spare parts & accessories) at my store, so the system knows what we sell and stock.)*

- **US-102** [P0]: Sebagai pemilik utama, saya ingin menyalin seluruh katalog produk dari satu toko ke toko lain, sehingga toko baru tidak perlu menginput ribuan produk dari awal.
  *(As the main owner, I want to copy the entire product catalog from one store to another, so new stores don't need to input thousands of products from scratch.)*

- **US-103** [P0]: Sebagai pemilik toko, saya ingin mengatur harga produk per tier pelanggan (retail, member, reseller, grosir) dalam satu tabel, sehingga saya bisa melihat semua harga sekaligus tanpa klik tambahan.
  *(As a store owner, I want to set product prices per customer tier (retail, member, reseller, wholesale) in one table, so I can see all prices at once without extra clicks.)*

- **US-104** [P1]: Sebagai pemilik toko, saya ingin mengatur diskon volume (beli X dapat diskon Y%) per produk, sehingga pelanggan grosir mendapat harga yang sesuai.
  *(As a store owner, I want to set volume discounts (buy X get Y% off) per product, so wholesale customers get appropriate pricing.)*

- **US-105** [P0]: Sebagai kasir, saya ingin melihat harga per tier pelanggan secara langsung di tabel produk, sehingga saya bisa langsung memberi tahu harga tanpa membuka halaman lain.
  *(As a cashier, I want to see prices per customer tier directly in the product table, so I can immediately quote prices without opening another page.)*

- **US-106** [P0]: Sebagai pemilik utama, saya ingin agar harga modal (cost price) hanya bisa dilihat oleh pengguna dengan izin tertentu (bukan oleh purchaser), sehingga informasi sensitif terlindungi.
  *(As the main owner, I want the cost price to be visible only to users with specific permissions (not to purchaser), so sensitive information is protected.)*

### Stock Management

- **US-107** [P0]: Sebagai staf purchasing, saya ingin mencatat penerimaan barang dari supplier, sehingga stok bertambah dan tercatat.
  *(As purchasing staff, I want to record goods received from a supplier, so stock increases and is recorded.)*

- **US-108** [P0]: Sebagai pemilik toko, saya ingin melakukan stock opname (hitung fisik) dan menyelesaikan selisih dengan persetujuan, sehingga data stok selalu akurat.
  *(As a store owner, I want to do a physical stock count and resolve discrepancies with approval, so stock data is always accurate.)*

- **US-109** [P0]: Sebagai pemilik toko, saya ingin menyesuaikan stok secara manual (misalnya barang rusak, hilang) dengan alasan, sehingga setiap perubahan stok tercatat.
  *(As a store owner, I want to manually adjust stock (e.g., damaged, lost items) with a reason, so every stock change is recorded.)*

### Cross-Store & Procurement

- **US-110** [P1]: Sebagai pemilik utama, saya ingin mengatur dari mana setiap toko boleh melakukan pengadaan (supplier tertentu dan/atau toko lain), sehingga rantai pasok terkontrol.
  *(As the main owner, I want to configure where each store can procure from (specific suppliers and/or other stores), so the supply chain is controlled.)*

- **US-111** [P1]: Sebagai staf purchasing, saya ingin membuat purchase order ke supplier atau permintaan transfer ke toko lain, sehingga barang yang dibutuhkan bisa dipesan.
  *(As purchasing staff, I want to create a purchase order to a supplier or a transfer request to another store, so needed items can be ordered.)*

- **US-112** [P1]: Sebagai pemilik toko sumber, saya ingin menyetujui atau menolak permintaan transfer dari toko lain, sehingga saya tetap bisa mengontrol stok saya.
  *(As the source store owner, I want to approve or reject transfer requests from other stores, so I can still control my stock.)*

### Supplier Returns

- **US-113** [P1]: Sebagai staf purchasing, saya ingin membuat retur ke supplier untuk barang cacat/salah, sehingga kami bisa mendapatkan penggantian atau refund.
  *(As purchasing staff, I want to create a return to supplier for defective/wrong items, so we can get a replacement or refund.)*

- **US-114** [P1]: Sebagai staf purchasing, saya ingin melacak status retur supplier (pending, diterima supplier, resolved), sehingga saya tahu posisi setiap retur.
  *(As purchasing staff, I want to track the status of supplier returns (pending, received by supplier, resolved), so I know the position of each return.)*

### Barcodes

- **US-115** [P0]: Sebagai kasir, saya ingin memindai barcode produk untuk menambahkannya ke transaksi, sehingga proses lebih cepat.
  *(As a cashier, I want to scan a product barcode to add it to a transaction, so the process is faster.)*

- **US-116** [P1]: Sebagai pemilik toko, saya ingin menghasilkan barcode baru untuk produk yang belum punya barcode, sehingga semua produk bisa dipindai.
  *(As a store owner, I want to generate new barcodes for products that don't have one, so all products can be scanned.)*

### Customer Returns

- **US-117** [P1]: Sebagai kasir, saya ingin memproses retur dari pelanggan (dengan persetujuan manajer) dan memberikan refund, sehingga kebijakan retur kami berjalan.
  *(As a cashier, I want to process a customer return (with manager approval) and issue a refund, so our return policy works.)*

---

## 3. Functional Requirements

### 3.1 Product Catalog

- **FR-101** [Must]: Each store shall have its own product catalog. A product belongs to a store.
- **FR-102** [Must]: A product shall have: SKU, name, category, brand, barcode (optional), cost price, and prices per customer tier.
- **FR-103** [Must]: Customer tiers shall be configurable by the main owner (e.g., retail, member, reseller, wholesale). Tier names and count are flexible, not hardcoded.
- **FR-104** [Must]: All tier prices shall be displayed as separate columns in a single product table view. No additional clicks needed to see tier prices.
- **FR-105** [Must]: Cost price shall be permission-gated. Only users with explicit permission (e.g., store owner, main owner) can view cost price. The purchaser role shall NOT see cost price.
- **FR-106** [Must]: The main owner shall be able to copy the entire product catalog from one store to another. Copied products are independent — changes to a copied product do not affect the source.
- **FR-107** [Should]: Products shall support volume discounts: an array of {minQuantity, discountPercent}. Volume discounts apply on top of the tier price.
- **FR-108** [Should]: Each product shall have an "active/inactive" status to soft-delete without losing history.
- **FR-109** [Should]: Products shall support both existing manufacturer barcodes and system-generated barcodes.

### 3.2 Pricing Calculation

- **FR-110** [Must]: The system shall calculate the final unit price as: `tierPrice × (1 − volumeDiscountPercent)`.
- **FR-111** [Must]: B2B customers may have custom negotiated prices that apply as an additional discount on top of tier + volume pricing.
- **FR-112** [Must]: The price calculation shall be deterministic and reproducible from stored data (no hidden state).

### 3.3 Stock Tracking

- **FR-113** [Must]: Each store shall maintain a stock level per product (SKU): `quantity` (on-hand).
- **FR-114** [Must]: Stock levels shall be derived from stock movement operations (received, consumed, adjusted, transferred, returned). The stock level is a projection.
- **FR-115** [Must]: Stock movements shall include: type (received, consumed_repair, sold_pos, adjusted, transferred_out, transferred_in, returned_customer, returned_supplier), quantity, reference (PO ID, repair ticket ID, sale ID, etc.), user, timestamp.
- **FR-116** [Must]: Inventory consumption from repairs (parts used) shall automatically create stock movement operations.
- **FR-117** [Must]: Inventory consumption from POS sales shall automatically create stock movement operations.

### 3.4 Receiving (from Supplier)

- **FR-118** [Must]: Purchasing staff shall be able to record goods received against a purchase order.
- **FR-119** [Must]: Receiving shall increment stock levels for the received items.
- **FR-120** [Should]: Receiving shall allow partial receipt (not all items in PO received at once).
- **FR-121** [Should]: Receiving shall support noting discrepancies (received quantity ≠ ordered quantity).

### 3.5 Stock Opname (Physical Count)

- **FR-122** [Must]: System shall support initiating a stock opname session at a store.
- **FR-123** [Must]: During opname, staff can enter counted quantities per product via manual entry or barcode scanning.
- **FR-124** [Must]: After counting, system shall display discrepancies (system quantity vs. counted quantity).
- **FR-125** [Must]: Discrepancies shall require store owner approval before being applied as stock adjustments.
- **FR-126** [Should]: Each adjustment from opname shall be logged with the reason "stock_opname" and reference to the opname session.

### 3.6 Manual Stock Adjustment

- **FR-127** [Must]: Store owner shall be able to manually adjust stock with a reason (damaged, lost, found, correction, other).
- **FR-128** [Must]: All adjustments shall be logged as operations with user, timestamp, quantity change, and reason.

### 3.7 Cross-Store Transfers

- **FR-129** [Must]: The main owner shall be able to configure a procurement dependency graph: which stores can procure from which suppliers and/or which other stores.
- **FR-130** [Must]: A store shall be able to create a transfer request to another store (within allowed dependencies).
- **FR-131** [Must]: The source store owner shall approve or reject the transfer request.
- **FR-132** [Must]: Upon approval and shipping, the source store's stock decreases. Upon receiving confirmation, the destination store's stock increases.
- **FR-133** [Should]: Transfer receiving shall support noting discrepancies (received ≠ shipped).

### 3.8 Purchase Orders

- **FR-134** [Must]: Purchasing staff shall be able to create purchase orders to suppliers (within allowed dependencies).
- **FR-135** [Must]: PO shall contain: supplier, list of items (SKU, quantity, unit cost), expected delivery date.
- **FR-136** [Must]: PO status tracking: draft → submitted → partially_received → received → closed.
- **FR-137** [Should]: PO creation shall auto-create an accounts payable entry (integration with Finance module).

### 3.9 Supplier Returns

- **FR-138** [Must]: Purchasing staff shall be able to create a return to supplier with items and reason (defective, wrong_item, overstock, other).
- **FR-139** [Must]: Returned items shall be placed "on hold" (not counted as available stock) until resolution.
- **FR-140** [Must]: Supplier return resolution: replacement (new stock received) or refund (AP adjustment).
- **FR-141** [Must]: Return status tracking: draft → pending_pickup → in_transit → received_by_supplier → resolved.

### 3.10 Customer Returns

- **FR-142** [Must]: Cashier shall be able to initiate a customer return for a previously purchased product.
- **FR-143** [Must]: Customer returns shall require store manager approval.
- **FR-144** [Must]: Approved returns shall increment stock and issue a refund (cash-back or to original payment method).
- **FR-145** [Should]: Returns shall be linkable to the original sale transaction.

### 3.11 Barcode Support

- **FR-146** [Must]: System shall support scanning existing manufacturer barcodes (EAN-13, UPC-A, Code 128) via device camera.
- **FR-147** [Should]: System shall be able to generate and print barcodes for products without existing barcodes.
- **FR-148** [Should]: Barcode scanning shall work for: POS product lookup, stock opname counting, receiving.

---

## 4. Non-Functional Requirements

- **NFR-101**: All inventory operations must work fully offline with eventual sync.
- **NFR-102**: Stock levels must be consistent within a single device (derived from local operations). Cross-device consistency is eventual (after sync).
- **NFR-103**: Product catalog copy (store-to-store) must handle thousands of products without timeout or memory issues on low-end devices.
- **NFR-104**: Barcode scanning must work on low-end Android cameras with reasonable lighting conditions.
- **NFR-105**: Cost price visibility must be enforced at the data layer, not just the UI layer — hidden columns should not be retrievable by unauthorized users.
- **NFR-106**: UI must follow the design philosophy: all tier prices visible in one table row, no extra clicks needed.

---

## 5. Data Entities (Conceptual)

### Product

- `id` — Unique identifier
- `storeId` — Which store owns this product
- `sku` — Stock keeping unit (unique per store)
- `name` — Product name
- `category` — Product category (e.g., "LCD Screen", "Battery", "Case")
- `brand` — Brand name
- `barcode` — Manufacturer barcode (optional)
- `generatedBarcode` — System-generated barcode (optional)
- `costPrice` — Purchasing cost (permission-gated)
- `tierPrices` — Map of tier ID → price (e.g., { "retail": 250000, "reseller": 220000, ... })
- `volumeDiscounts` — Array of { minQuantity, discountPercent }
- `isActive` — Boolean
- `createdAt`, `updatedAt`

### CustomerTier (Admin-Managed)

- `id` — Unique identifier
- `name` — e.g., "Retail", "Member", "Reseller", "Wholesale"
- `sortOrder` — Display order in tables
- Managed by the main owner; global across all stores

### StockLevel (Projection)

- `storeId` + `productId` — Composite key
- `quantity` — On-hand (derived from stock movements)
- `onHold` — Quantity held for supplier returns (not available)
- `available` — `quantity − onHold`
- `lastUpdated`

### StockMovement (Recorded via Operations)

- `id` — Unique identifier
- `storeId`, `productId`
- `type` — received | consumed_repair | sold_pos | adjusted | transferred_out | transferred_in | returned_customer | returned_supplier | opname_adjustment
- `quantity` — Signed (+/−)
- `reference` — { type: "purchase_order" | "repair_ticket" | "sale" | "transfer" | "opname" | "manual", id: string }
- `reason` — Text (for adjustments)
- `userId`, `timestamp`

### PurchaseOrder

- `id`, `storeId`, `supplierId`
- `status` — draft | submitted | partially_received | received | closed
- `items` — Array of { productId, sku, quantity, unitCost }
- `expectedDeliveryDate`
- `createdBy`, `createdAt`, `updatedAt`

### Supplier

- `id`, `name`, `contactPhone`, `contactEmail`, `address`
- `paymentTerms` — e.g., "net_30", "cod"
- `isActive`

### StoreTransfer

- `id`, `sourceStoreId`, `destinationStoreId`
- `status` — requested | approved | rejected | shipped | received | closed
- `items` — Array of { productId, sku, requestedQuantity, shippedQuantity, receivedQuantity }
- `discrepancyNotes`
- `requestedBy`, `approvedBy`, `shippedBy`, `receivedBy`
- Timestamps per status

### SupplierReturn

- `id`, `storeId`, `supplierId`
- `status` — draft | pending_pickup | in_transit | received_by_supplier | resolved
- `items` — Array of { productId, sku, quantity, reason }
- `resolution` — { type: "replacement" | "refund", replacementItems?, refundAmount?, refundMethod? }
- Timestamps per status

### StockOpnameSession

- `id`, `storeId`
- `status` — in_progress | pending_approval | approved | rejected
- `counts` — Array of { productId, sku, systemQuantity, countedQuantity, discrepancy }
- `approvedBy`, `approvalNotes`
- `startedAt`, `completedAt`

### ProcurementDependencyGraph (Admin-Managed)

- `storeId` → allowed sources: Array of { type: "supplier" | "store", id: string }
- Managed by the main owner

---

## 6. UI/UX Flows

### 6.1 Product Catalog — Spreadsheet View

- Full-width table with columns: SKU | Name | Category | Cost* | Retail | Member | Reseller | Wholesale | Stock | Actions
- Cost column hidden unless user has permission
- Inline editing for prices (tap cell → edit → save)
- Column headers show tier names (dynamic, from admin config)
- Filters: category, brand, active/inactive, low stock
- Search bar at top (searches name, SKU, barcode)
- Bulk actions: import, export, activate/deactivate
- "Copy Catalog From..." button (main owner only) → select source store → confirm

**Design:** Dense but readable. Think spreadsheet, not card layout. Optimized for information density since users need to see and compare prices across tiers without navigation.

### 6.2 Stock Opname Flow

**Step 1: Start Session**
- Select "Start Stock Count" from inventory screen
- Optional: filter by category (count only a subset)

**Step 2: Counting**
- List of products with system quantity (hidden or shown, configurable)
- Two input methods:
  - Scan barcode → product found → enter counted quantity
  - Browse list → tap product → enter counted quantity
- Progress indicator: X of Y products counted

**Step 3: Review Discrepancies**
- Table showing: Product | System Qty | Counted Qty | Difference
- Highlight rows with discrepancies
- Can re-count individual items

**Step 4: Submit for Approval**
- Submit to store owner for review
- Store owner sees discrepancy summary → approve or reject (with notes)
- Approval auto-adjusts stock levels

### 6.3 Purchase Order Flow

- Create PO: select supplier (from allowed list) → add items (search products) → set quantities → submit
- PO list: filter by status, supplier, date
- Receive against PO: select PO → enter received quantities per item → note discrepancies → confirm

### 6.4 Transfer Request Flow

- Create transfer: select destination store → add items → submit request
- Source store owner: view pending requests → approve/reject
- Ship: source marks as shipped
- Receive: destination enters received quantities → note discrepancies → confirm

### 6.5 Customer Return Flow

- Cashier: search original sale → select items to return → submit for manager approval
- Manager: review return request → approve/reject
- If approved: stock incremented, refund processed

---

## 7. Edge Cases & Error States

- **Product copied to new store with different pricing:** Copied products inherit all prices; store owner can modify independently.
- **Barcode collision:** Two products with the same barcode at a store → system alerts, requires resolution.
- **Stock goes negative:** Should not happen via normal operations, but adjustments can create negative stock. System should warn but allow (for correction scenarios).
- **Partial PO receiving:** PO stays in "partially_received" until all items are received or PO is manually closed.
- **Transfer discrepancy:** Received quantity ≠ shipped quantity → logged, both stores maintain their own stock levels correctly.
- **Supplier return unresolved for a long time:** Items remain "on hold." System should flag long-pending returns.
- **Offline stock opname:** Entire opname works offline. Discrepancy resolution syncs when online.
- **Concurrent stock changes during opname:** The opname compares against the system quantity at the time of counting. Any stock changes during the count are separate operations and don't affect the opname discrepancy calculation.

---

## 8. Fraud Prevention Measures

- **Cost price hiding:** Cost price is permission-gated and not sent to the client for unauthorized users (enforced at data/API layer).
- **All stock movements logged:** Every stock change is an immutable operation with user, timestamp, and reason. No "silent" inventory changes.
- **Stock opname as audit:** Regular stock counts catch discrepancies from theft, damage, or errors.
- **Manual adjustments require reason:** Cannot adjust stock without providing a reason.
- **Supplier return tracking:** Prevents "phantom returns" (claiming return but keeping goods) by tracking the full return lifecycle.

---

## 9. Open Questions

- **OQ-101**: Should product categories be a flat list or hierarchical (e.g., "Parts > Screens > LCD")?
- **OQ-102**: Should the system suggest reorder points / low stock alerts? If yes, is the threshold per product or per category?
- **OQ-103**: For the procurement dependency graph, should it be positive (allow list) or negative (block list)? Positive seems safer.
- **OQ-104**: Should barcode generation support QR codes as well, or only traditional 1D barcodes?
- **OQ-105**: For volume discounts, can a store define volume discounts differently from another store for the same copied product? (Assumed yes, since products are independent after copy.)

---

## 10. Claude Code Task Breakdown

### TASK-INV-001: Product Data Model & Operations

**Context:** Define product, customer tier, and related entities. Set up operations for product CRUD, pricing changes, and catalog copy.

**Acceptance Criteria:**
- [ ] Product type defined with all fields from §5
- [ ] CustomerTier type defined (admin-managed, global)
- [ ] Product operation types: product.created, product.updated, product.price_changed, product.deactivated, product.catalog_copied
- [ ] Product projection defined
- [ ] Cost price field marked as permission-gated in the data model

**Depends On:** Platform Core

**Relevant PRD Sections:** §3.1, §5

---

### TASK-INV-002: Stock Level Projection & Movement Operations

**Context:** Stock levels are derived from stock movement operations. Define the movement types and the projection that computes current stock.

**Acceptance Criteria:**
- [ ] StockMovement operation types defined (all types from §5)
- [ ] StockLevel projection: correctly computes quantity, onHold, available from movement history
- [ ] Stock movements automatically created by repair parts consumption and POS sales (integration hooks)

**Depends On:** TASK-INV-001, Platform Core

**Relevant PRD Sections:** §3.3, §5

---

### TASK-INV-003: Product Catalog UI — Spreadsheet View

**Context:** The primary product management screen. Dense table showing all tier prices as columns.

**Acceptance Criteria:**
- [ ] Table with dynamic tier price columns (based on configured tiers)
- [ ] Cost column conditionally visible based on user permission
- [ ] Inline editing for prices
- [ ] Search, filter (category, brand, active/inactive, low stock)
- [ ] Stock quantity column
- [ ] Works on both desktop and mobile (responsive, horizontal scroll OK on mobile)

**Depends On:** TASK-INV-001

**Relevant PRD Sections:** §3.1, §6.1

---

### TASK-INV-004: Catalog Copy Feature

**Context:** Main owner copies entire product catalog from one store to another.

**Acceptance Criteria:**
- [ ] Select source store → preview product count → confirm → copy
- [ ] Copied products are independent (new IDs, linked to destination store)
- [ ] Handles thousands of products without performance issues
- [ ] Only main owner can perform this action

**Depends On:** TASK-INV-001

**Relevant PRD Sections:** FR-106

---

### TASK-INV-005: Stock Opname (Physical Count) Flow

**Context:** Full stock counting workflow with barcode scanning, discrepancy detection, and approval.

**Acceptance Criteria:**
- [ ] Start opname session (optionally filtered by category)
- [ ] Count entry via barcode scan or manual browse
- [ ] Discrepancy report: system qty vs. counted qty
- [ ] Submit for store owner approval
- [ ] Approval auto-generates stock adjustment operations
- [ ] Works fully offline

**Depends On:** TASK-INV-002

**Relevant PRD Sections:** §3.5, §6.2

---

### TASK-INV-006: Purchase Order Management

**Context:** Create, track, and receive purchase orders from suppliers.

**Acceptance Criteria:**
- [ ] Create PO: select supplier (from allowed list), add items, submit
- [ ] PO status tracking: draft → submitted → partially_received → received → closed
- [ ] Receiving flow: enter received quantities, note discrepancies
- [ ] Receiving auto-increments stock
- [ ] PO creation auto-creates AP entry (integration hook with Finance module)

**Depends On:** TASK-INV-001, TASK-INV-002

**Relevant PRD Sections:** §3.8, §6.3

---

### TASK-INV-007: Cross-Store Transfer Management

**Context:** Request, approve, ship, and receive stock transfers between stores.

**Acceptance Criteria:**
- [ ] Procurement dependency graph configuration (main owner)
- [ ] Create transfer request (within allowed dependencies)
- [ ] Source store approval/rejection
- [ ] Ship + receive with discrepancy tracking
- [ ] Stock adjustments on both sides

**Depends On:** TASK-INV-002

**Relevant PRD Sections:** §3.7, §6.4

---

### TASK-INV-008: Supplier Return Management

**Context:** Create and track returns to suppliers, with resolution (replacement or refund).

**Acceptance Criteria:**
- [ ] Create return: select supplier, add items with reasons
- [ ] Items placed "on hold" (reflected in available stock calculation)
- [ ] Status tracking: draft → pending_pickup → in_transit → received_by_supplier → resolved
- [ ] Resolve as replacement (stock received) or refund (AP adjustment)

**Depends On:** TASK-INV-002

**Relevant PRD Sections:** §3.9

---

### TASK-INV-009: Customer Return Flow

**Context:** Process customer returns with manager approval and refund.

**Acceptance Criteria:**
- [ ] Cashier initiates return linked to original sale
- [ ] Manager approval step
- [ ] Stock increment on approval
- [ ] Refund processing (cash-back or original payment method)

**Depends On:** TASK-INV-002, POS module (sale reference)

**Relevant PRD Sections:** §3.10, §6.5

---

### TASK-INV-010: Manual Stock Adjustment

**Context:** Store owner manually adjusts stock with a reason.

**Acceptance Criteria:**
- [ ] Adjust quantity up or down for any product
- [ ] Mandatory reason field
- [ ] Logged as a stock movement operation
- [ ] Permission-restricted to store owner / manager

**Depends On:** TASK-INV-002

**Relevant PRD Sections:** §3.6

---

### TASK-INV-011: Barcode Scanning & Generation

**Context:** Support scanning existing barcodes and generating new ones.

**Acceptance Criteria:**
- [ ] Camera-based barcode scanning (EAN-13, UPC-A, Code 128)
- [ ] Scan → product lookup in catalog
- [ ] Generate barcode for products without one
- [ ] Print barcode label (integration with printer)
- [ ] Works on low-end Android cameras

**Depends On:** TASK-INV-001

**Relevant PRD Sections:** §3.11

---

### TASK-INV-012: Pricing Calculation Engine

**Context:** Deterministic price calculation: tier price × volume discount × custom B2B discount.

**Acceptance Criteria:**
- [ ] Given product, customer tier, and quantity → returns unit price, total, discount breakdown
- [ ] Volume discount lookup by quantity threshold
- [ ] Custom B2B customer discount applied as additional layer
- [ ] Calculation is pure function, reproducible from stored data

**Depends On:** TASK-INV-001

**Relevant PRD Sections:** §3.2
