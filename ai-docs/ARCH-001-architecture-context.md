# ARCH-001: Architecture Context

> **SUPERSEDED IN PART (2026-07-14) — the ai-docs/ spec set and `decisions/` win wherever they differ.** This document is historical background reading. The following claims are known-superseded; do NOT implement from them (body text below is intentionally left unedited):
>
> - **§1 — "offered as a SaaS product within 6 months":** voided by decisions/ D5 — SaaS comes after V1, no hard deadline (00-product-overview).
> - **§3 — Technology Context recommendations** (Drizzle, Fastify, Bun, Turborepo, BullMQ+Redis, Socket.io): superseded by decisions/ D3 and D6–D10; the decided stack is owned by 08-stack-and-repo — do not re-litigate.
> - **§4.1 — "Shared/generic accounts allowed":** rejected — individual accounts always (PRD-011 §2; 00-product-overview).
> - **§4.3 — pull "operations since last sync timestamp":** superseded by the serverSeq cursor protocol (05-operation-log; api/01-sync).

> **Purpose:** This document provides architectural context for Claude Code when implementing PRDs. It describes the system's constraints, principles, and cross-cutting patterns. PRDs describe WHAT to build; this document provides the WHY and the CONSTRAINTS within which implementation decisions should be made.

---

## 1. Business Context

### What is this system?

An ERP (Enterprise Resource Planning) system for a phone repair franchise chain in West Papua, Indonesia. The franchise currently operates ~10 stores with plans to scale to 100. The system will also be offered as a SaaS product within 6 months.

### Who uses it?

| Role | Technical Skill | Primary Tasks | Device |
|------|----------------|---------------|--------|
| Main Owner (Pemilik Utama) | Low-medium | View all stores, configure system, manage catalog | Any |
| Store Owner (Pemilik Toko) | Low | Monitor store operations, approve actions, view financials | Any |
| Manager (Manajer) | Low | Approve returns/warranties, manage staff | Any |
| Cashier (Kasir) | Very low | Repair intake, POS sales, payments, pickup | Typically mobile |
| Technician (Teknisi) | Very low | Repair queue, parts consumption, QC | Typically mobile |
| Purchasing (Purchasing) | Low | PO creation, goods receiving, supplier management | Any |
| Delivery Driver (Driver) | Very low | Delivery manifest, POD, GPS tracked | Mobile |
| Accountant (Akuntan) | Medium-high | Ledger access, financial reports | Desktop preferred |

**Critical UX constraint:** Most users are tech-inadept. UX must be extremely simple, obvious, and forgiving. Minimize typing. Large touch targets. Indonesian language with English toggle.

### Key constraints

| Constraint | Implication |
|------------|-------------|
| Low-end Android devices (2GB RAM, 32GB storage) | Aggressive performance optimization, lazy loading, compressed media |
| Unreliable 3G connectivity in West Papua | Offline-first architecture is mandatory, not optional |
| Power outages lasting 1-2 days | Devices must function entirely offline for extended periods |
| Tech-inadept users | No complex navigation, no jargon, guided workflows |
| SaaS within 6 months | Architecture must support multi-tenancy from day one |
| Indonesian language | All UI in Bahasa Indonesia, with English toggle |
| Multiple users per device | PIN-based quick-switch between user accounts on same device |

---

## 2. Architectural Principles

### 2.1 Offline-First

Every feature must work without network connectivity. The typical pattern:

1. User performs action on device
2. Action is saved locally (SQLite) as an operation
3. UI updates immediately from local data
4. When online, operations sync to cloud server
5. Cloud server processes operations and distributes to other devices

**There is no "Store Primary" device.** All devices (desktop and mobile) are equal peers. Every device has its own local SQLite database and syncs independently to the cloud.

### 2.2 Append-Only Operation Log

All business actions are recorded as immutable, cryptographically signed operations. Operations are never edited or deleted.

```
Operation {
  id: string
  type: string               // e.g., "repair.created", "sale.completed"
  entityType: string          // e.g., "repair", "sale", "stock_movement"
  entityId: string
  payload: object             // The actual data
  storeId: string
  userId: string
  deviceId: string
  timestamp: number
  location?: { lat, lng, accuracy }
  previousHash: string        // Hash chain for tamper detection
  signature: string           // Signed with device key
  syncStatus: local | synced | rejected
}
```

**Why:** Audit trail, fraud detection, offline sync without data loss, ability to reconstruct state at any point in time.

### 2.3 Projections (Read Models)

Current state (e.g., "what is the stock level of LCD-001?") is derived from replaying operations. Projections are read-only views computed from the operation log.

- Projections are stored in local SQLite for fast querying
- Projections are rebuilt from operations when needed (e.g., after sync brings new operations)
- The UI reads from projections, never directly from the operation log

### 2.4 Modular Monolith

The system is organized as a modular monolith with two layers:

**Platform Layer (Horizontal Modules):**
Reusable across verticals (repair shop, restaurant, manufacturing in the future).
- Inventory, Finance, POS, Chat, HR, CRM, Delivery, Supplier, Auth

**Vertical Layer (Industry-Specific):**
The repair-shop-specific logic that composes platform modules.
- Repair lifecycle, evidence collection, warranty, damage types

**Module Contract:** Each module exposes:
- Operation types it handles
- Projections it provides
- Commands (write operations)
- Queries (read operations)
- Screens and components (optional)

Modules communicate via operations and shared projections, not direct function calls. This keeps modules decoupled and allows future extraction into separate services if needed.

### 2.5 Flexible Over Fixed

Where the original conversation used fixed enums (e.g., group types = "store | region | role"), prefer extensible interfaces:

- Customer tiers: configurable by main owner, not hardcoded
- Damage types: admin-managed list, not enum
- Chat group types: provider-based (StoreUserProvider, RegionUserProvider, etc.)
- Payment methods: extensible list, not fixed enum
- Roles and permissions: configurable

---

## 3. Technology Context

> **Note:** PRDs are technology-agnostic. These are RECOMMENDATIONS based on the conversation history, not requirements. Claude Code should evaluate these choices.

### Client

| Concern | Recommendation | Reasoning |
|---------|---------------|-----------|
| Desktop app | Tauri (Rust + React) | Lightweight, native-feeling, SQLite via Rust |
| Mobile app | React Native | Cross-platform, SQLite support, camera/GPS access |
| Local database | SQLite | Universal, works offline, lightweight |
| UI | Shared component library (React Native Web patterns) | Code reuse between desktop and mobile |
| Offline state | Local SQLite + operation queue | Full offline capability |

### Server

| Concern | Recommendation | Reasoning |
|---------|---------------|-----------|
| Runtime | Node.js / Bun | Type sharing with client code (TypeScript) |
| Framework | Fastify or Hono | Lightweight, fast |
| Database | PostgreSQL | Robust, JSONB support for payloads |
| ORM | Drizzle | Lightweight, good TypeScript support |
| Job queue | BullMQ + Redis | Background media processing, notifications |
| File storage | S3-compatible (MinIO self-hosted or cloud) | Photos, videos, documents |
| WebSocket | ws or Socket.io | Real-time chat, notifications |

### Shared

| Concern | Recommendation | Reasoning |
|---------|---------------|-----------|
| Language | TypeScript throughout | Type sharing, team familiarity |
| Validation | Zod | Shared schemas client + server |
| Monorepo | pnpm workspaces + Turborepo | Multiple packages, shared code |

---

## 4. Cross-Cutting Concerns

### 4.1 Authentication & Authorization

- Users are created by main owner or store owner (not self-registration)
- Multiple user accounts can exist on one device (PIN-based quick-switch)
- Shared/generic accounts allowed (e.g., "Cashier 1") but individual accounts preferred for audit
- Role-based access control:
  - Roles are configurable by main owner
  - Each role has a set of permissions
  - UI shows/hides features based on permissions (same app, different visibility)
- Permission examples: `repair.intake`, `repair.diagnose`, `inventory.view_cost`, `finance.accountant_mode`, `admin.manage_damage_types`

### 4.2 Multi-Store Data Isolation

- Each store's data is isolated. A store can only see its own data.
- Store owners with multiple stores can switch between stores within the app and see aggregated views.
- Main owner can see all stores.
- When data syncs to the cloud, it is tagged with `storeId`.
- Cross-store operations (transfers, catalog copy) are explicit actions, not ambient data sharing.

### 4.3 Sync Protocol

**Push (client → server):**
1. Client collects unsynced operations (syncStatus = 'local')
2. Client sends operations to server via HTTP POST
3. Server validates signatures and hash chain
4. Server stores operations, updates projections
5. Server responds with acknowledgment (which operations were accepted/rejected)
6. Client marks acknowledged operations as synced

**Pull (server → client):**
1. Client requests operations since last sync timestamp
2. Server returns operations from other devices/stores that this client needs
3. Client applies operations to local operation log
4. Client rebuilds affected projections

**Media sync:**
- Separate from operation sync (media is large)
- Background upload with chunked, resumable uploads
- Operations reference media by ID; media upload happens independently
- No specific upload priority required

### 4.4 Conflict Resolution

Since operations are append-only, there are no true "conflicts" in the traditional sense. However, business-level conflicts can occur:

- **Stock oversell:** Two devices sell the same last item offline. When operations sync, stock goes negative. Resolution: alert store owner, auto-flag for review.
- **Concurrent repair ticket edits:** Two people update the same ticket offline. Since operations are append-only, both edits are preserved. Projection applies them in timestamp order.
- **Auto-resolution for minor conflicts:** e.g., two small stock adjustments → just apply both.
- **Manual resolution for significant conflicts:** Store owner reviews and decides.

### 4.5 Stale Data Indicators

When a device hasn't synced recently, the UI must warn users about potentially stale data:

- Show "Last synced: X minutes/hours/days ago" prominently
- If offline > threshold (e.g., 1 hour): warning banner
- If offline > extended threshold (e.g., 1 day): stronger warning
- Certain cross-store features should be labeled as "may not reflect latest data" when data is stale
- Within a single device, data is always consistent (local operations are applied immediately)

### 4.6 Printing

The system supports multiple printer types:
- **Thermal printers:** Bluetooth, USB, and network. Used for POS receipts and short-form repair receipts.
- **Standard printers:** Network or USB. Used for detailed repair order receipts (A4/A5).
- **Printer discovery:** Auto-discover available printers. Minimal configuration required.
- **Offline printing:** Prints from local data, no network required.

### 4.7 WhatsApp Integration

Two modes:
- **Manual link generation:** System generates a wa.me link with pre-filled message. User taps to open WhatsApp and send. Used for customer notifications (repair ready, price change).
- **Automated (if feasible):** Research free or low-cost methods for automated WhatsApp notifications to store owners for critical operations. If WhatsApp Business API is required, this becomes a paid feature.

### 4.8 Internationalization (i18n)

- Primary language: Indonesian (Bahasa Indonesia)
- Secondary language: English
- UI toggle to switch language
- All user-facing strings must be externalized (no hardcoded Indonesian text in code)
- Accounting terms must be translated appropriately (and hidden from non-accountant users)

### 4.9 Onboarding

- Built-in, role-specific guided tours on first login
- Tooltips with highlighted UI areas
- Can be re-triggered from settings
- Covers the primary flows for each role:
  - Cashier: intake, POS, pickup
  - Technician: repair queue, parts, QC
  - Store owner: dashboard, reports, approvals
  - Purchasing: PO creation, receiving

---

## 5. Multi-Tenancy (SaaS Readiness)

Since the system will be SaaS within 6 months:

- **Shared infrastructure with data isolation** is the primary model
- Each "tenant" is a franchise/business (which may have multiple stores)
- Data isolation at the database level (e.g., `tenantId` on all tables, or schema-per-tenant)
- The vertical layer determines which modules are active for a tenant
- Tenant configuration includes: active modules, custom tiers, branding (future), feature flags
- Self-service onboarding should be supported alongside white-glove onboarding
- The architecture should NOT assume a single franchise — all "main owner" features should work per-tenant

---

## 6. Module Dependency Map

```
Platform Core (operations, projections, sync, auth)
    │
    ├── @mod/auth (users, roles, permissions)
    │
    ├── @mod/crm (customers, tiers)
    │     │
    │     └── Used by: POS, Repair, Finance
    │
    ├── @mod/inventory (products, stock, pricing, transfers, supplier returns)
    │     │
    │     └── Used by: POS, Repair, Supplier
    │
    ├── @mod/supplier (suppliers, POs)
    │     │
    │     └── Creates: AP entries in Finance
    │
    ├── @mod/finance (CoA, journal entries, AR, AP, payments, cash reconciliation)
    │     │
    │     └── Used by: POS, Repair, Supplier, Inventory
    │
    ├── @mod/pos (sales, checkout)
    │     │
    │     └── Creates: stock movements, journal entries, AR (credit sales)
    │
    ├── @mod/chat (groups, messages, polls)
    │
    ├── @mod/hr (employees, attendance, payroll)
    │
    ├── @mod/delivery (manifests, deliveries, POD, driver tracking)
    │
    └── @vertical/repair-shop
          │
          ├── Uses: inventory, finance, pos, crm, chat, hr, delivery, supplier
          │
          └── Adds: repair lifecycle, evidence, diagnosis, warranty, damage types
```

---

## 7. Feature Parity: Desktop vs. Mobile

Both desktop (Tauri) and mobile (React Native) should maintain feature parity where it makes sense. All terminals are equal — there is no "primary" device.

| Feature | Desktop | Mobile | Notes |
|---------|---------|--------|-------|
| Repair intake | ✅ | ✅ | Camera better on mobile |
| POS | ✅ | ✅ | |
| Repair queue/working view | ✅ | ✅ | |
| Inventory management | ✅ | ✅ | Spreadsheet view may need horizontal scroll on mobile |
| Financial dashboard | ✅ | ✅ | |
| Accountant mode | ✅ | ✅ | Desktop preferred for complex tables |
| Stock opname | ✅ | ✅ | Mobile may be more convenient for barcode scanning |
| Chat | ✅ | ✅ | |
| Delivery (driver) | ❌ | ✅ | Drivers use mobile only |
| GPS tracking | ❌ | ✅ | Only relevant for mobile users |
| Receipt printing | ✅ | ✅ | Desktop: USB/network. Mobile: Bluetooth/network |
| Barcode scanning | ✅ (camera) | ✅ (camera) | Mobile camera may be more convenient |

---

## 8. Data Flow Example: Complete Repair Journey

To illustrate how operations, projections, and journal entries work together:

```
1. Customer walks in → Cashier opens intake form

2. Intake completed (one-sitting flow):
   Operation: repair.created
   → Repair projection: new ticket (status: intake_complete)
   → No journal entry yet (no money exchanged)

3. Customer pays down payment (Rp 100,000 cash):
   Operation: payment.received (method: cash, amount: 100000, related: repair)
   → Payment projection: payment recorded
   → Journal: Dr Cash 100,000 / Cr Unearned Revenue 100,000

4. Technician self-assigns:
   Operation: repair.technician_assigned
   → Repair projection: assignedTechnicianId updated

5. Technician uses parts (LCD screen, SKU: LCD-001):
   Operation: repair.part_consumed (sku: LCD-001, qty: 1)
   → Inventory projection: stock decremented
   → Repair projection: part added to ticket
   → Journal: Dr COGS 150,000 / Cr Inventory 150,000

6. Technician finds additional damage, adds price:
   Operation: repair.price_entry_added (+Rp 80,000, reason: "cracked connector found")
   → Repair projection: price log updated, total increased
   → No journal entry (no money yet)

7. QC passed:
   Operation: repair.qc_completed
   → Repair projection: status → ready

8. Customer picks up, pays remaining (Rp 230,000 QRIS):
   Operation: repair.picked_up
   Operation: payment.received (method: qris, amount: 230000, related: repair)
   → Repair projection: status → completed
   → Payment projection: payment recorded
   → Journal: Dr Bank 230,000 / Cr Service Revenue 230,000
   → Journal: Dr Unearned Revenue 100,000 / Cr Service Revenue 100,000
   (Reclassify the down payment from unearned to earned revenue)
```

This example shows how a single repair flows through multiple modules, generating operations, updating projections, and creating journal entries — all working offline and syncing later.

---

## 9. V2 Agent Mode Enablement

Agent Mode (PRD-004) is deferred to V1.5/V2. However, V1 implementation decisions must NOT paint us into a corner. Claude Code should follow these principles during P0/P1 implementation:

### 9.1 Module Command Structure

Each module's commands (CRUD operations, state transitions, etc.) must be:
- **Pure functions** — no UI dependencies, no toast/navigate side effects inside the command
- **Explicitly typed** — input and output schemas (Zod preferred for shared validation)
- **Permission-checked** — permission enforcement inside the command, not just in UI
- **Deterministic and auditable** — given same input and context, same outcome

This allows V2 to expose commands as agent tools with zero refactoring.

### 9.2 Operation Reversibility

Every operation type must have a documented reversal pattern. Module PRDs specify these. Example:
- Stock adjustment +N → reversed by -N
- Price change A→B → reversed by price change B→A
- Status transition X→Y → reversed by Y→X (if state machine allows)

Claude Code should document the reversal pattern alongside each operation type in code comments.

### 9.3 Audit Trail Fields

Every operation record must include these fields from day one, even if unused in V1:
- `agentInitiated: boolean` (default false)
- `agentConversationId: string | null` (default null)
- `source: 'ui' | 'agent' | 'api' | 'system'` (default 'ui')

This makes V1 operations forward-compatible with V2 agent attribution.

### 9.4 Granular Permissions

Permissions must be fine-grained (e.g., `inventory.adjust_stock`, `inventory.view_cost_price`, `finance.record_payment`) — not coarse ("can use inventory"). Agent will check permissions before tool execution.

### 9.5 Projection Query API

Projections should expose structured query methods (filters, sorting, pagination) that are callable programmatically — not only via UI-specific hooks. V2 agent tools will call these APIs to answer user questions.

### 9.6 Explicit Non-Goals for V1

Do NOT build these in V1; they will be designed properly for V2:
- LLM provider abstraction
- Transaction/rollback machinery for multi-step operations
- Knowledge base or RAG infrastructure
- Agent UI components
- Proactive insight engine

Just keep the door open by following 9.1–9.5.
