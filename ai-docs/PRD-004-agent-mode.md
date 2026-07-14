# PRD-004: Agent Mode (AI Assistant)

> **Timeline:** Deferred to V1.5 / V2 (post-launch, months 7-12). This PRD is written at full fidelity to enable implementation without re-specification. See §13 for V1 architecture considerations that enable this module.

---

## 1. Overview

### Problem Statement

Tech-inadept users struggle with complex multi-step workflows (creating POs, bulk price updates, cross-store transfers, report generation). Main owners and store owners want quick answers from their data ("how did we do last week?") without navigating complex report screens. Employees waste time on repetitive operations that could be expressed in one sentence. Existing UI, while designed to be simple, still requires users to know where features live — an agent can let users express intent in natural language.

### Goals

- Provide a natural language interface to the ERP — users can ask questions and request actions in Indonesian, English, or Chinese
- Enable a plan → preview → commit/rollback workflow for multi-step actions, giving users full control before changes are applied
- Default to read-only mode (safe by default); writes require explicit opt-in per user
- Provide proactive insights (pattern detection, anomaly alerts) without requiring explicit queries
- Maintain strict permission boundaries — the agent can only do what the current user could do manually
- Integrate seamlessly with all existing modules via their exposed commands
- Support multi-provider LLM routing (Gemini, Claude, OpenAI, Qwen, etc.) — no vendor lock-in
- Integrate with chat (mention @agent in chat groups)
- Maintain a memory system (per-user preferences, per-store context)
- Include a RAG knowledge base for documentation, accounting rules, and tenant-specific knowledge

### Success Metrics

- 40%+ of main owners and store owners use the agent at least weekly after 3 months of availability
- Agent-initiated actions have <2% rollback rate (agent accuracy)
- Average user time-to-insight reduced by 50% vs. navigating UI for the same question
- 70%+ of users rate agent responses as "helpful" or "very helpful"
- Agent query cost per store stays under target budget (configurable per tenant)

---

## 2. User Stories

### Read-Only Queries (Default Mode)

- **US-301** [P0]: Sebagai pemilik toko, saya ingin bertanya "berapa pendapatan toko saya minggu ini?" dan mendapat jawaban langsung, sehingga saya tidak perlu navigasi ke laporan.
  *(As a store owner, I want to ask "how much revenue did my store make this week?" and get a direct answer, so I don't need to navigate to reports.)*

- **US-302** [P0]: Sebagai pemilik utama, saya ingin bertanya "toko mana yang paling banyak retur bulan ini?" dan mendapat analisis, sehingga saya bisa memantau performa jaringan.
  *(As the main owner, I want to ask "which store had the most returns this month?" and get analysis, so I can monitor network performance.)*

- **US-303** [P1]: Sebagai teknisi, saya ingin bertanya "berapa stok LCD iPhone 15 di toko ini?" sambil mengerjakan repair, sehingga saya tidak perlu keluar dari layar repair.
  *(As a technician, I want to ask "how much LCD iPhone 15 stock is in this store?" while working on a repair, so I don't need to leave the repair screen.)*

- **US-304** [P1]: Sebagai pemilik utama, saya ingin bertanya "bandingkan margin Toko A dan Toko B bulan ini" dan mendapat analisis naratif, sehingga saya bisa memahami performa tanpa mengolah angka manual.
  *(As the main owner, I want to ask "compare margin between Toko A and Toko B this month" and get narrative analysis, so I can understand performance without processing numbers manually.)*

### Action Execution (Opt-In Mode)

- **US-305** [P0]: Sebagai pemilik toko (dengan mode write aktif), saya ingin berkata "naikkan harga semua LCD sebesar 5%" dan melihat preview perubahan sebelum di-commit, sehingga saya yakin dengan aksi agent.
  *(As a store owner (with write mode enabled), I want to say "raise all LCD prices by 5%" and see a preview of changes before committing, so I'm confident in the agent's action.)*

- **US-306** [P0]: Sebagai pemilik toko, saya ingin melihat rencana (plan) aksi agent sebelum eksekusi, sehingga saya bisa konfirmasi atau batalkan.
  *(As a store owner, I want to see the agent's action plan before execution, so I can confirm or cancel.)*

- **US-307** [P0]: Sebagai pemilik toko, saya ingin rollback aksi agent setelah review jika ada kesalahan, sehingga data tidak rusak.
  *(As a store owner, I want to rollback the agent's actions after review if there's an error, so data isn't corrupted.)*

- **US-308** [P1]: Sebagai pemilik toko, saya ingin bisa undo aksi agent kapan saja (bahkan setelah commit), sehingga saya punya safety net.
  *(As a store owner, I want to undo agent actions anytime (even after commit), so I have a safety net.)*

### Bulk Operations

- **US-309** [P1]: Sebagai purchasing, saya ingin berkata "buat PO ke Supplier X dengan 10 LCD iPhone 15 dan 20 baterai Samsung" dan agent langsung menyiapkan PO untuk review, sehingga lebih cepat dari input manual.
  *(As a purchaser, I want to say "create a PO to Supplier X with 10 iPhone 15 LCDs and 20 Samsung batteries" and have the agent prepare the PO for review, so it's faster than manual input.)*

- **US-310** [P1]: Sebagai pemilik utama, saya ingin berkata "pindahkan 20 LCD iPhone 15 dari Toko A ke Toko B" dan agent menyiapkan transfer request, sehingga saya tidak perlu klik banyak layar.
  *(As the main owner, I want to say "move 20 iPhone 15 LCDs from Toko A to Toko B" and have the agent prepare the transfer request, so I don't need to navigate many screens.)*

### Proactive Insights

- **US-311** [P1]: Sebagai pemilik toko, saya ingin agent memberikan notifikasi proaktif tentang pola tidak biasa (misalnya selisih kas yang sering pada hari tertentu), sehingga saya bisa investigasi.
  *(As a store owner, I want the agent to proactively notify me about unusual patterns (e.g., frequent cash variances on specific days), so I can investigate.)*

- **US-312** [P2]: Sebagai pemilik utama, saya ingin agent memberikan ringkasan mingguan tentang jaringan saya, sehingga saya tetap update tanpa harus login setiap hari.
  *(As the main owner, I want the agent to give me a weekly summary of my network, so I stay updated without logging in every day.)*

### Knowledge Base Access

- **US-313** [P1]: Sebagai kasir baru, saya ingin bertanya "gimana cara terima barang dari supplier?" dan mendapat panduan langkah demi langkah, sehingga saya bisa belajar tanpa training manual.
  *(As a new cashier, I want to ask "how do I receive goods from supplier?" and get step-by-step guidance, so I can learn without manual training.)*

- **US-314** [P1]: Sebagai pemilik toko, saya ingin bertanya tentang aturan akuntansi atau pajak Indonesia, dan agent menjawab berdasarkan knowledge base yang akurat, sehingga saya mendapat info yang bisa dipercaya.
  *(As a store owner, I want to ask about Indonesian accounting or tax rules, and have the agent answer based on an accurate knowledge base, so I get trustworthy information.)*

### Chat Integration

- **US-315** [P2]: Sebagai pengguna di grup chat, saya ingin mention @agent untuk bertanya atau melakukan aksi, sehingga agent terintegrasi dengan alur kolaborasi tim.
  *(As a chat group user, I want to mention @agent to ask questions or take actions, so the agent is integrated into team collaboration.)*

### Data Entry Assistance

- **US-316** [P2]: Sebagai pemilik toko, saya ingin berkata "tambahkan produk baru: Kabel USB-C, modal 15rb, retail 35rb, reseller 28rb" dan agent mengisi form untuk saya konfirmasi, sehingga input produk lebih cepat.
  *(As a store owner, I want to say "add new product: USB-C Cable, cost 15k, retail 35k, reseller 28k" and have the agent fill the form for me to confirm, so product entry is faster.)*

### Configuration Helper

- **US-317** [P2]: Sebagai pemilik utama, saya ingin agent membantu setup toko baru (salin katalog, buat users, konfigurasi permissions) berdasarkan toko referensi, sehingga onboarding toko baru cepat.
  *(As the main owner, I want the agent to help set up a new store (copy catalog, create users, configure permissions) based on a reference store, so new store onboarding is fast.)*

---

## 3. Functional Requirements

### 3.1 Agent Invocation

- **FR-301** [Must]: Agent shall be accessible via a persistent entry point (floating button / keyboard shortcut) on all screens where agent use is appropriate.
- **FR-302** [Must]: Agent shall open as a chat-style panel (not a new page) — user can continue to see their current context.
- **FR-303** [Must]: Agent shall preserve conversation history within a session.
- **FR-304** [Must]: User shall be able to start a new conversation (clear history) anytime.
- **FR-305** [Should]: Agent shall be accessible via @agent mention in chat groups (when integrated with Chat module).
- **FR-306** [Could]: Agent shall support voice input for users who prefer speaking (note: core platform doesn't have voice input; this would be a platform exception for agent only).

### 3.2 Read-Only Mode (Default)

- **FR-307** [Must]: Agent defaults to read-only mode for all users. Writes require explicit opt-in per user (in settings).
- **FR-308** [Must]: In read-only mode, agent can:
  - Answer questions about data the user has permission to view
  - Generate reports and analysis
  - Explain features and workflows
  - Retrieve and summarize information
- **FR-309** [Must]: In read-only mode, agent CANNOT:
  - Create, update, or delete any operations
  - Modify any business data
  - Change settings or configurations
- **FR-310** [Must]: When read-only user requests an action, agent shall explain that write mode is required and how to enable it.

### 3.3 Write Mode (Opt-In)

- **FR-311** [Must]: Write mode is opt-in per user. Enabling is a deliberate setting change (not default).
- **FR-312** [Must]: Write mode is gated by user's role permissions. The agent can only perform actions the current user could perform manually through the UI.
- **FR-313** [Must]: Write mode can be disabled at any time.
- **FR-314** [Should]: Write mode can be scoped by action type (e.g., "allow creates but not deletes", "allow inventory but not finance").
- **FR-315** [Should]: Certain destructive actions shall always require additional confirmation regardless of mode (e.g., deleting data, large financial transactions, bulk modifications affecting 100+ records).

### 3.4 Plan → Preview → Commit/Rollback Flow

- **FR-316** [Must]: When the user requests a write action, the agent shall:
  1. **Plan**: Generate a structured action plan
  2. **Preview**: Present the plan to the user with clear explanations of each step and expected outcomes
  3. **User decides**: User can approve, modify, or cancel
  4. **Execute**: If approved, execute actions within a transaction
  5. **Commit or Rollback**: User reviews final state and commits or rolls back
- **FR-317** [Must]: The action plan shall include:
  - Natural language summary of what will happen
  - List of specific operations (tool calls) that will be made
  - Affected entities (products, repairs, stores, etc.) with counts
  - Estimated reversibility of each step
  - Any warnings or prerequisites
- **FR-318** [Must]: During execution, user shall see a real-time log of actions being performed.
- **FR-319** [Must]: After execution, user shall see a summary of all actions performed with:
  - Success/failure status per action
  - Data changes (before → after)
  - Option to commit or rollback
- **FR-320** [Must]: If user rolls back, the system shall reverse all operations performed in the transaction.
- **FR-321** [Must]: Commit makes the changes permanent (but still undoable via the general undo feature).
- **FR-322** [Should]: User can cancel mid-execution. Cancellation rolls back completed actions in the transaction.

### 3.5 Undo Capability

- **FR-323** [Must]: All agent-initiated actions shall be undoable via the general undo feature, even after commit. Time window for undo is configurable (default: 7 days).
- **FR-324** [Must]: Undo is a user-initiated action from the agent activity log or general undo UI.
- **FR-325** [Should]: Undo shall be atomic for a single agent session — either all actions from that session are undone or none.
- **FR-326** [Should]: Some actions may become non-undoable after certain triggers (e.g., once a customer has been notified via WhatsApp, the price change that triggered it might be hard to fully undo). System shall clearly indicate this.

### 3.6 Permission Enforcement

- **FR-327** [Must]: Every tool/action the agent attempts shall be checked against the current user's permissions at execution time.
- **FR-328** [Must]: If the agent attempts an action the user cannot perform, the action shall be rejected and the agent informed (agent can communicate this to the user).
- **FR-329** [Must]: The agent shall not be able to elevate privileges or bypass permission checks through any means.
- **FR-330** [Must]: Agent actions shall be logged with the initiating user — the user is fully responsible for agent actions taken on their behalf.
- **FR-331** [Must]: Agent shall respect data visibility rules (e.g., a store owner asking about other stores gets a permission-denied response).

### 3.7 Memory System

- **FR-332** [Must]: Agent shall maintain per-user memory:
  - Short-term: Current conversation context
  - Long-term: Learned preferences, frequent queries, user-defined shortcuts
- **FR-333** [Must]: Agent shall maintain per-store memory:
  - Store-specific terminology, aliases (e.g., "LCD 15" = "LCD iPhone 15")
  - Frequent patterns, common workflows
- **FR-334** [Must]: Agent shall maintain per-tenant memory:
  - Franchise-wide knowledge (e.g., procurement rules, standard operating procedures)
- **FR-335** [Must]: Users shall be able to view and manage what the agent "remembers" about them.
- **FR-336** [Must]: Users shall be able to explicitly add memories (e.g., "always call me Pak Ocep", "my default store is Jayapura").
- **FR-337** [Must]: Users shall be able to delete memories at any time.
- **FR-338** [Should]: Memory shall persist across sessions and devices (synced via cloud).

### 3.8 RAG / Knowledge Base

- **FR-339** [Must]: Agent shall have access to a retrieval-augmented knowledge base containing:
  - System documentation (how-to guides, feature explanations)
  - Indonesian accounting and tax rules
  - Product catalog and specifications (via GSMArena integration)
  - Store SOPs and policies (tenant-customizable)
- **FR-340** [Must]: Knowledge base content shall be language-tagged (Indonesian, English, Chinese versions).
- **FR-341** [Should]: Tenants shall be able to add their own documents to the knowledge base (e.g., company policies, training materials).
- **FR-342** [Should]: Agent shall cite sources from the knowledge base when relevant.
- **FR-343** [Should]: Knowledge base shall be updated regularly (by platform team, with optional contribution from customers).

### 3.9 Proactive Agent

- **FR-344** [Should]: Agent shall analyze data periodically and surface insights proactively:
  - Unusual patterns (e.g., consistent cash variance on specific days)
  - Approaching deadlines (AP due dates, warranty expirations)
  - Anomalies (price outliers, unusual stock movements)
  - Opportunities (low stock items worth reordering, customer milestones)
- **FR-345** [Should]: Proactive insights shall be delivered via:
  - In-app notifications
  - Agent panel "For You" section
  - Optional: daily/weekly summary via WhatsApp
- **FR-346** [Must]: Users can disable proactive insights entirely or by category.
- **FR-347** [Should]: Each proactive insight shall include suggested actions the user can take.

### 3.10 Multi-Provider LLM Routing

- **FR-348** [Must]: The system shall support multiple LLM providers (Gemini, Claude, OpenAI, Qwen, etc.) via a pluggable provider interface.
- **FR-349** [Must]: Model routing shall be based on task type:
  - Simple Q&A → fast, cheap model (e.g., Gemini Flash-Lite, Haiku)
  - Complex planning / multi-step reasoning → capable model (e.g., Gemini Pro, Sonnet, Opus)
  - Structured data extraction → small/cheap model with good tool use
  - Long-context analysis → model with large context window
  - Embeddings (for RAG) → dedicated embedding model
- **FR-350** [Must]: Each tenant (SaaS customer) shall be able to configure their preferred provider(s).
- **FR-351** [Must]: Default provider for the franchise shall be configured by the main owner.
- **FR-352** [Should]: The system shall support fallback providers — if primary provider fails or rate-limits, fall back to secondary.
- **FR-353** [Should]: The system shall support custom/self-hosted models for enterprise customers with strict privacy needs.
- **FR-354** [Must]: Provider configuration shall include API keys, base URLs, model names, and routing rules.
- **FR-355** [Must]: Cost tracking per provider shall be available (token usage, estimated cost).
- **FR-356** [Must]: Per-tenant/per-store cost caps shall be configurable. When approaching cap, admin is alerted; when exceeding cap, agent is disabled until next period.

### 3.11 Offline Behavior

- **FR-357** [Must]: Agent mode requires internet connectivity (LLM calls are online-only).
- **FR-358** [Must]: When offline, the agent panel shall display "Agent tidak tersedia saat offline" (Agent unavailable while offline) with clear explanation.
- **FR-359** [Should]: Some lightweight agent features shall work offline using local models (future enhancement):
  - Basic Q&A over cached data
  - Simple intent recognition
- **FR-360** [Must]: Proactive insights generated while online shall be viewable offline (cached in local DB).

### 3.12 Language Support

- **FR-361** [Must]: Agent shall support Indonesian, English, and Chinese.
- **FR-362** [Must]: Language shall be auto-detected from user input OR explicitly set by user toggle.
- **FR-363** [Must]: Agent responses shall be in the same language as user input (unless user explicitly requests otherwise).
- **FR-364** [Must]: Knowledge base content shall exist in all three languages; agent retrieves the version matching user's language.
- **FR-365** [Should]: Agent shall handle code-switching (mixed languages in single message) gracefully.

### 3.13 Cost Management

- **FR-366** [Must]: Every LLM call shall be logged with: provider, model, input tokens, output tokens, cost, user, timestamp, purpose.
- **FR-367** [Must]: Admin dashboards shall show cost breakdowns: per user, per store, per provider, per time period.
- **FR-368** [Must]: Hard limits: cost per user per day, per store per month, per tenant per month. Configurable.
- **FR-369** [Should]: Soft limits with warnings before hard limits are hit.
- **FR-370** [Should]: Cost optimization hints (e.g., "routing simple queries to cheaper model would save X%").

### 3.14 Audit & Transparency

- **FR-371** [Must]: Every agent action shall be recorded as an operation with:
  - Original user prompt
  - Selected model and provider
  - Tool calls made
  - Final state changes
  - Tagged as `agentInitiated: true`
- **FR-372** [Must]: Users shall be able to view their agent activity history.
- **FR-373** [Must]: Store owners and main owners shall be able to audit agent activity across their stores.
- **FR-374** [Should]: Agent shall explain its reasoning when asked ("kenapa kamu melakukan ini?").

---

## 4. Non-Functional Requirements

- **NFR-301**: Agent response latency: p50 < 3 seconds, p95 < 8 seconds for simple queries. Streaming responses to show progress.
- **NFR-302**: Agent must work on low-end Android (2GB RAM) — UI should be lightweight, processing happens server-side or via LLM provider.
- **NFR-303**: All agent communication with LLM providers shall go through the backend server (never directly from client). This enables: API key security, cost tracking, rate limiting, content filtering.
- **NFR-304**: LLM provider changes (new model, new provider) shall require no client-side code changes — all routing logic is server-side.
- **NFR-305**: Knowledge base retrieval latency: < 500ms.
- **NFR-306**: Agent conversation data is private to the user by default. Tenant admins can audit but not read conversation contents unless user grants permission.
- **NFR-307**: Tool execution timeouts: complex operations shall have timeouts to prevent runaway costs. Default: 30 seconds per tool call, 5 minutes per agent session.
- **NFR-308**: Multi-tenant data isolation: agent queries against one tenant's data shall never leak to another tenant, even in shared LLM provider environments.

---

## 5. Data Entities (Conceptual)

### AgentConversation

- `id` — Unique identifier
- `userId` — Who started it
- `storeId` — Active store context
- `tenantId`
- `messages` — Array of AgentMessage
- `mode` — "read_only" | "write"
- `language` — "id" | "en" | "zh"
- `createdAt`, `updatedAt`

### AgentMessage

- `id`
- `conversationId`
- `role` — "user" | "agent" | "tool"
- `content` — Text content
- `toolCalls` — Array of tool invocations (if agent message)
- `toolResults` — Array of tool results (if tool message)
- `llmProvider`, `llmModel` — Which model generated (for agent messages)
- `inputTokens`, `outputTokens`, `cost`
- `timestamp`

### AgentTransaction

- `id`
- `conversationId`, `messageId` — Source
- `userId`, `storeId`, `tenantId`
- `status` — "planning" | "awaiting_approval" | "executing" | "awaiting_commit" | "committed" | "rolled_back" | "cancelled"
- `plan` — Structured action plan (JSON)
- `operations` — Array of operations performed (with before/after state)
- `rollbackOperations` — Prepared rollback operations
- `createdAt`, `committedAt`, `rolledBackAt`

### AgentMemory

- `id`
- `scope` — "user" | "store" | "tenant"
- `scopeId` — user ID, store ID, or tenant ID
- `key` — Memory key (e.g., "preferred_store", "common_aliases")
- `value` — Memory value (can be text, JSON, etc.)
- `createdAt`, `updatedAt`, `lastAccessedAt`
- `createdBy` — "user" (explicit) | "agent" (learned)

### KnowledgeBaseDocument

- `id`
- `tenantId` — Null for platform-wide docs, tenant ID for tenant-specific
- `language` — "id" | "en" | "zh"
- `category` — "documentation" | "accounting" | "tax" | "sop" | "product" | ...
- `title`, `content`
- `embeddings` — Vector representation for similarity search
- `source` — URL or reference
- `updatedAt`

### LLMProviderConfig

- `id`
- `tenantId`
- `provider` — "gemini" | "claude" | "openai" | "qwen" | "custom"
- `apiKey` (encrypted)
- `baseUrl`
- `models` — Map of task type → model name:
  - `simple_qa`: "gemini-2.5-flash"
  - `complex_planning`: "gemini-3-pro"
  - `structured_extraction`: "gemini-2.5-flash-lite"
  - `embeddings`: "gemini-embedding-001"
- `fallbackProviderId` — For resilience
- `isActive`

### AgentCostEntry

- `id`
- `tenantId`, `storeId`, `userId`
- `conversationId`, `messageId`
- `provider`, `model`
- `inputTokens`, `outputTokens`
- `cost` — In smallest currency unit (IDR)
- `purpose` — e.g., "planning", "tool_call", "summarization"
- `timestamp`

### ProactiveInsight

- `id`
- `tenantId`, `storeId`, `userId` — Target audience
- `category` — "anomaly" | "deadline" | "opportunity" | "summary"
- `title`, `description`
- `severity` — "info" | "warning" | "critical"
- `suggestedActions` — Array of suggestions
- `data` — Supporting data (JSON)
- `status` — "unread" | "read" | "dismissed" | "acted_on"
- `createdAt`

---

## 6. Tool Registry

The agent's capabilities come from a **tool registry** — each module (inventory, finance, repair, etc.) exposes its commands and queries as tools the agent can call.

### 6.1 Tool Definition

Each tool has:
- `name` — Unique identifier (e.g., `inventory.adjust_stock`, `repair.list_tickets`)
- `description` — What the tool does (in natural language for the LLM)
- `parameters` — Input schema (JSON Schema)
- `returns` — Output schema
- `permissions` — Required permissions to use
- `isWrite` — Boolean (true if modifies data)
- `reversibility` — "fully_reversible" | "partial" | "irreversible"
- `confirmationRequired` — Boolean (forces user confirmation even in write mode)

### 6.2 Core Tool Categories

**Query Tools (Read-Only):**
- `inventory.get_stock(sku, store_id?)` — Check stock levels
- `inventory.list_products(filters)` — Search products
- `inventory.get_pricing(sku, tier, quantity)` — Calculate pricing
- `repair.list_tickets(filters)` — List repairs
- `repair.get_ticket(id)` — Get repair details
- `finance.get_revenue(store_id?, period)` — Revenue summary
- `finance.list_ar(filters)` — List receivables
- `finance.list_ap(filters)` — List payables
- `finance.get_dashboard_metrics(store_id?, period)` — Dashboard numbers
- `chat.list_groups()` / `chat.get_messages(group_id)` — Chat access
- `crm.search_customer(query)` — Find customer
- `reports.generate(type, params)` — Report generation

**Action Tools (Write — requires write mode):**
- `inventory.adjust_stock(sku, quantity, reason)` — Stock adjustment
- `inventory.create_transfer(source_store, dest_store, items)` — Cross-store transfer
- `inventory.update_pricing(sku, tier, new_price)` — Price change
- `repair.update_status(ticket_id, new_status)` — Repair state change
- `supplier.create_po(supplier_id, items)` — Purchase order
- `finance.record_payment(ar_id|ap_id, amount, method)` — Payment recording
- `chat.send_message(group_id, content)` — Send chat message
- `crm.create_customer(data)` — Create customer record

**Meta Tools:**
- `knowledge.search(query)` — RAG retrieval
- `memory.remember(scope, key, value)` — Store memory
- `memory.recall(scope, key)` — Retrieve memory
- `agent.explain(decision)` — Meta-reasoning
- `agent.start_transaction()` / `commit()` / `rollback()` — Transaction control

### 6.3 Tool Registration Pattern

Each module registers its tools at startup:

```
// Conceptual — Claude Code will implement actual pattern
inventoryModule.tools = [
  {
    name: "inventory.adjust_stock",
    description: "Adjust stock level for a product...",
    parameters: { sku: string, quantity: number, reason: string },
    permissions: ["inventory.adjust"],
    isWrite: true,
    reversibility: "fully_reversible",
    confirmationRequired: false,
  },
  // ...
];
```

The agent's tool registry aggregates tools from all active modules at runtime.

---

## 7. Transaction Model for Agent Actions

### 7.1 Transaction Lifecycle

```
┌──────────────┐
│   Planning   │ ← Agent generates action plan
└──────┬───────┘
       ↓
┌──────────────────────┐
│  Awaiting Approval   │ ← User reviews plan
└──────┬───────────────┘
       │
   ┌───┴───┐
   ↓       ↓
[Approve] [Cancel]
   ↓       ↓
┌──────────────┐   ┌───────────┐
│  Executing   │   │ Cancelled │
└──────┬───────┘   └───────────┘
       ↓
┌──────────────────────┐
│  Awaiting Commit     │ ← User reviews execution
└──────┬───────────────┘
       │
   ┌───┴───┐
   ↓       ↓
[Commit] [Rollback]
   ↓       ↓
┌──────────┐   ┌──────────────┐
│Committed │   │ Rolled Back  │
└──────────┘   └──────────────┘
```

### 7.2 How Transactions Work with Append-Only Operations

Since the system uses append-only operations (see ARCH-001), "transactions" and "rollback" are implemented differently than traditional database transactions:

- **Plan** — Agent generates list of intended operations (not yet applied)
- **Execute** — Operations are created with `syncStatus: pending_agent_commit` — they ARE in the operation log but marked as pending
- **Commit** — Operations move to `syncStatus: local` (normal state) and become visible in projections
- **Rollback** — Reversing operations are created that undo each step (e.g., a stock adjustment of +10 is reversed by -10)

For UI/projection purposes:
- Pending agent transactions are NOT shown in normal views
- Only after commit do changes appear in projections
- Rollbacks create reversing operations visible in audit log (no silent deletes)

### 7.3 Reversibility Handling

Not all actions are perfectly reversible:

- **Fully reversible**: Stock adjustments, price changes, status transitions — rollback is straightforward
- **Partially reversible**: Actions with side effects (e.g., WhatsApp messages sent, printed receipts) — the digital state can be rolled back but real-world effects cannot be undone
- **Irreversible**: Certain external integrations (payment gateways that have already settled) — flagged clearly; user must explicitly acknowledge before execution

The agent shall:
- Clearly label each planned action's reversibility
- Warn heavily before executing irreversible actions
- Offer alternative reversible approaches when possible

---

## 8. LLM Provider Architecture

### 8.1 Provider Interface

All providers shall implement a common interface:

- `chat(messages, tools, options)` — Send chat completion request
- `embed(text)` — Generate embeddings
- `stream(messages, tools, options)` — Streaming chat
- `getUsage()` — Retrieve token usage for billing
- `validateConfig()` — Verify API key and connectivity

### 8.2 Supported Providers (at launch)

- **Google Gemini** — Recommended primary (cost-effective, good tool use, strong multilingual including Indonesian and Chinese)
- **Anthropic Claude** — Alternative primary (strong reasoning, excellent tool use, enterprise-friendly)
- **OpenAI GPT** — Alternative primary
- **Qwen (Alibaba Cloud Bailian)** — Cost-effective option with Chinese/Indonesian support (paid tier only — free preview tier unsuitable for production due to data collection)
- **Custom / Self-Hosted** — For enterprise customers with privacy requirements

### 8.3 Routing Logic

The router selects a provider + model based on:

1. **Task type** (simple QA, planning, extraction, long context)
2. **Tenant configuration** (preferred provider, cost caps)
3. **Availability** (provider health, rate limit status)
4. **Context size** (fits in chosen model's window?)

### 8.4 Model Recommendations (as of writing, subject to update)

- **Simple Q&A**: Gemini 2.5 Flash, Claude Haiku, GPT-5 mini
- **Complex planning**: Gemini 3 Pro, Claude Sonnet, GPT-5
- **Structured extraction**: Gemini Flash-Lite, GPT-5 nano
- **Long context (full ledger analysis)**: Gemini 3 Pro (1M context)
- **Embeddings**: Gemini embedding models, OpenAI text-embedding-3

These choices should be revisited regularly — the LLM landscape changes monthly.

### 8.5 Privacy Considerations per Provider

- **Gemini paid tier**: Data not used for training, enterprise-grade
- **Claude**: Data not used for training by default, zero-data-retention options available
- **OpenAI**: Data not used for training via API (opt-out default), zero-data-retention options
- **Qwen free preview**: NOT ACCEPTABLE — data collected for training
- **Qwen paid (Bailian)**: Acceptable with proper configuration
- **Self-hosted**: Full control

Tenant admin chooses based on their sensitivity.

---

## 9. UI/UX Flows

### 9.1 Agent Panel

- Floating button (bottom-right) on most screens
- Clicking opens slide-in panel (right side on desktop, bottom sheet on mobile)
- Chat-style interface with:
  - Message history
  - Input field at bottom
  - Model/mode indicator
  - Settings icon

### 9.2 Read-Only Query Flow

1. User types question (or voice input if enabled): "berapa pendapatan minggu ini?"
2. Agent shows "thinking..." indicator
3. Agent streams response:
   - Optionally: shows tool calls it's making (e.g., "📊 Mengecek data penjualan...")
   - Final answer with numbers, optional charts, optional source citations
4. User can ask follow-up questions

### 9.3 Action Request Flow

1. User types action: "naikkan harga semua LCD 5%"
2. Agent analyzes → generates plan
3. Plan displayed in structured format:
   ```
   📋 Rencana Aksi:
   
   Akan menaikkan harga 47 produk dengan kategori "LCD":
   • LCD iPhone 15: Rp 250.000 → Rp 262.500
   • LCD iPhone 14: Rp 220.000 → Rp 231.000
   • ... (tampilkan 5, [Lihat Semua])
   
   ⚠️ Catatan:
   • Perubahan berlaku di Toko Jayapura saja
   • Mempengaruhi semua tier harga (retail, member, reseller, grosir)
   • Bisa di-rollback dalam 7 hari
   
   [Setujui & Jalankan]  [Ubah]  [Batal]
   ```
4. User approves → agent executes, showing progress
5. After execution:
   ```
   ✅ Selesai! 47 produk diupdate.
   
   [Lihat Detail]  [Commit]  [Rollback]
   ```
6. User commits or rolls back

### 9.4 Mode Toggle

- In agent panel settings, user can toggle between:
  - "Read-only" (default) — agent can only answer
  - "Write (dengan konfirmasi)" — agent can act with user approval
- Cannot disable the approval step — it's always required for writes

### 9.5 Memory Management

- In agent settings: "Hal yang diingat agent tentang saya"
- List of memories the agent has stored
- User can:
  - Delete individual memories
  - Clear all memories
  - Add explicit memories manually

### 9.6 Proactive Insights

- "Untuk Anda" tab in agent panel
- List of insights with severity indicators
- Each insight: title, description, suggested actions
- User can: dismiss, act on, view details, snooze

### 9.7 Activity Log

- "Riwayat" tab in agent panel
- All conversations and actions, searchable
- Each action: timestamp, prompt, actions taken, status (committed/rolled back)
- Tap to view full conversation or undo

---

## 10. Edge Cases & Error States

- **Agent hallucinates tool that doesn't exist**: Tool registry is authoritative. Unknown tool calls are rejected, agent is informed to use only registered tools.
- **Agent plans an action the user doesn't have permission for**: Permission check at execution blocks it. Agent explains to user: "Saya tidak bisa melakukan ini karena Anda tidak memiliki permission X."
- **LLM provider is down**: Fallback to secondary provider. If all fail, agent shows error and suggests manual action.
- **Rate limit hit**: Queue request or show error. Don't silently fail.
- **Cost cap reached**: Block new agent queries. Admin notified. User sees clear message.
- **Ambiguous user request**: Agent asks for clarification rather than guessing.
- **User cancels mid-execution**: System rolls back completed steps. Partial state not allowed.
- **Tool execution fails mid-transaction**: Entire transaction is rolled back. User sees what succeeded and what failed.
- **Network drops during execution**: Operations are recorded locally; when reconnected, system determines if transaction completed. If ambiguous, user is asked.
- **Agent used in chat group**: Multiple users see the same conversation. Only the invoking user can approve actions. Agent must clearly identify who asked what.
- **User requests action in another store they don't have access to**: Permission denied, clearly explained.
- **Cross-language conversation**: User switches from Indonesian to English mid-conversation. Agent follows the language of the most recent user message.
- **Very long conversations**: History is summarized/compressed when approaching context limits. User is notified.

---

## 11. Security & Privacy Considerations

- **Prompt injection**: User-provided content (customer names, product descriptions, etc.) that gets passed to the LLM could contain prompt injection attempts. System shall sanitize and use structured prompts with clear boundaries.
- **Tool abuse**: Agent could be tricked into calling harmful tools. Permission checks and confirmation requirements mitigate this.
- **Data leakage across tenants**: In shared LLM provider environments, there's theoretical risk of context bleed. Mitigation: explicit tenant context in every call, no cross-tenant data in system prompts.
- **API key management**: Provider API keys encrypted at rest, never exposed to client, rotated periodically.
- **Conversation privacy**: User conversations are private by default. Admin audit requires explicit user consent (except for write actions, which are always auditable for compliance).
- **Right to delete**: Users can delete their conversation history and memories at any time.
- **Training data opt-out**: Default to providers that don't train on customer data. Tenants can opt into cheaper tiers that do, with explicit warning.

---

## 12. Open Questions

- **OQ-301**: Should agent have access to ALL modules on day one, or phased rollout (start with read-only queries, then inventory, then finance, etc.)?
- **OQ-302**: What's the preferred embedding store? (pgvector, dedicated vector DB, cloud service)
- **OQ-303**: For proactive insights, should the analysis run on a schedule (e.g., nightly) or be triggered by events?
- **OQ-304**: Should agent voice input be supported despite the platform's no-voice-input rule? Agent is a distinct UX and might warrant an exception.
- **OQ-305**: For multi-tenant SaaS, who bears the LLM cost? Platform absorbs it? Per-tenant billing? Usage-based tiers?
- **OQ-306**: How should the knowledge base be maintained? Platform team curates? Community contributions? AI-generated from customer support tickets?
- **OQ-307**: Should there be a "tutor mode" where the agent actively teaches the user (rather than just answering)?
- **OQ-308**: Rate limiting per user — what are reasonable defaults to prevent abuse while not restricting legitimate use?

---

## 13. V1 Architecture Enablement (What We Must Do Now)

Even though the agent is V1.5/V2, certain decisions during V1 development will make it easier or harder to build the agent later. Claude Code should be aware of these during P0/P1 implementation:

### 13.1 Module Command Structure

Each module's commands (CRUD operations, transitions, etc.) should be defined as:
- Pure functions (no UI dependencies)
- With explicit parameter schemas (Zod or similar)
- With explicit permission checks
- With deterministic, auditable behavior

This makes them trivially exposable as agent tools later.

**Bad (hard to expose later):**
```
// Tightly coupled to UI
function handleStockAdjustSubmit(formEvent, toast, navigate) { ... }
```

**Good (easy to expose later):**
```
// Pure command
async function adjustStock(input: AdjustStockInput, ctx: CommandContext): Promise<AdjustStockResult> { ... }
```

### 13.2 Operation Reversibility

Each operation type should have a documented reversal pattern:
- Stock adjustment +10 → reverses with -10
- Status change "in_repair" → "qc" → reverses with "qc" → "in_repair"
- Price change → reverses with price change back to original value

Module PRDs should document this. Claude Code should implement reversal as part of each command's design.

### 13.3 Audit Trail Completeness

Every operation must include:
- User who initiated it
- Timestamp
- Source (UI action, agent, API, etc.)

An `agentInitiated: boolean` field and `agentConversationId` reference should be added to all operations — even in V1 — so V1 operations are forward-compatible when agent launches.

### 13.4 Permission System Structure

Permissions should be granular and checkable programmatically:
- Not just "can use POS screen" but "can create sales", "can void sales", "can view cost prices"
- Checked at the command level, not just UI level

This enables the agent to check permissions before attempting actions.

### 13.5 Projection Query API

Projections should be queryable via a structured API (filters, sorts, pagination) that the agent can call — not only via UI-specific hooks.

### 13.6 Do NOT build in V1

Explicit non-goals for V1:
- Don't build an LLM provider abstraction yet (wait for agent module)
- Don't build transaction/rollback machinery (will be designed properly for V2)
- Don't build a knowledge base yet
- Don't build agent UI components

Just keep the door open by following §13.1–13.5.

---

## 14. Claude Code Task Breakdown

### Phase 1: Foundation (Weeks 1-3)

### TASK-AGT-001: Tool Registry & LLM Provider Abstraction

**Context:** Foundation for everything. Define the interfaces that modules plug their tools into, and the interfaces LLM providers implement.

**Acceptance Criteria:**
- [ ] `Tool` interface defined (name, description, parameters, permissions, isWrite, reversibility)
- [ ] `ToolRegistry` with register, lookup, list methods
- [ ] `LLMProvider` interface (chat, stream, embed, getUsage, validateConfig)
- [ ] Concrete providers: Gemini, Claude, OpenAI, Qwen (Bailian)
- [ ] Provider configuration loading per tenant
- [ ] Router that selects provider+model based on task type

**Depends On:** Platform Core, Auth module

**Relevant PRD Sections:** §3.10, §6, §8

---

### TASK-AGT-002: Agent Conversation Infrastructure

**Context:** Data model and backend for agent conversations, messages, and persistence.

**Acceptance Criteria:**
- [ ] AgentConversation, AgentMessage entities with CRUD
- [ ] Per-user conversation history
- [ ] Message storage with tool calls/results
- [ ] Token and cost tracking per message
- [ ] Audit trail for all agent activity

**Depends On:** TASK-AGT-001

**Relevant PRD Sections:** §3.1, §3.14, §5

---

### TASK-AGT-003: Core Agent Loop (Read-Only)

**Context:** The main agent reasoning loop for read-only queries. No writes, no transactions — just Q&A with tool calls.

**Acceptance Criteria:**
- [ ] User message → LLM call → tool call(s) → LLM response
- [ ] Multi-turn tool use (agent calls multiple tools in sequence)
- [ ] Streaming responses to UI
- [ ] Permission check before each tool call
- [ ] Error handling: tool not found, permission denied, tool execution error
- [ ] System prompt engineering for quality responses in ID/EN/ZH
- [ ] Language auto-detection and matching

**Depends On:** TASK-AGT-001, TASK-AGT-002

**Relevant PRD Sections:** §3.2, §3.6, §3.12

---

### TASK-AGT-004: Tool Registration from All Modules

**Context:** Wire up every module's commands and queries as agent tools.

**Acceptance Criteria:**
- [ ] Inventory tools registered (stock, products, pricing, transfers, etc.)
- [ ] Finance tools registered (revenue queries, AR/AP, payments, reports)
- [ ] Repair tools registered (tickets, status, parts)
- [ ] POS tools registered (sales queries)
- [ ] CRM tools registered (customer search)
- [ ] Chat tools registered (groups, messages)
- [ ] HR tools registered (attendance, employees)
- [ ] Delivery tools registered (manifests, POD)
- [ ] All tools properly tagged: isWrite, reversibility, confirmationRequired
- [ ] Tool descriptions written clearly for LLM consumption

**Depends On:** TASK-AGT-001, all module implementations

**Relevant PRD Sections:** §6.2

---

### Phase 2: Agent UI (Weeks 4-5)

### TASK-AGT-005: Agent Panel UI (Chat Interface)

**Context:** The chat panel UI where users interact with the agent.

**Acceptance Criteria:**
- [ ] Floating button on all screens
- [ ] Slide-in panel (desktop) / bottom sheet (mobile)
- [ ] Chat message history
- [ ] Streaming response rendering
- [ ] Tool call visualization (optional — shows what the agent is doing)
- [ ] Input field with send button
- [ ] Settings access
- [ ] New conversation button
- [ ] Language toggle

**Depends On:** TASK-AGT-003

**Relevant PRD Sections:** §9.1, §9.2

---

### TASK-AGT-006: Agent Settings UI

**Context:** User-facing settings for agent behavior.

**Acceptance Criteria:**
- [ ] Read-only / Write mode toggle (write is opt-in)
- [ ] Write mode granularity (optional: allow creates but not deletes)
- [ ] Language preference (auto, id, en, zh)
- [ ] Memory management (view, delete, add explicit memories)
- [ ] Notification preferences (proactive insights)
- [ ] Provider selection (if tenant allows user-level override)

**Depends On:** TASK-AGT-002

**Relevant PRD Sections:** §3.3, §3.7, §9.4, §9.5

---

### Phase 3: Write Mode & Transactions (Weeks 6-8)

### TASK-AGT-007: Transaction Model for Agent Actions

**Context:** Implement the plan → preview → execute → commit/rollback flow.

**Acceptance Criteria:**
- [ ] AgentTransaction entity with lifecycle states
- [ ] Plan generation from LLM (structured output)
- [ ] Plan presentation UI (human-readable summary)
- [ ] Execution with operation log tagging (pending_agent_commit)
- [ ] Commit flow (makes operations visible)
- [ ] Rollback flow (generates reversing operations)
- [ ] Mid-execution cancellation
- [ ] Clear reversibility labeling in plan

**Depends On:** TASK-AGT-003, TASK-AGT-004

**Relevant PRD Sections:** §3.4, §7

---

### TASK-AGT-008: Undo System Integration

**Context:** Integrate agent actions with the general undo system so actions can be reversed even after commit.

**Acceptance Criteria:**
- [ ] All agent-committed operations have documented reversal
- [ ] Undo UI accessible from agent activity log
- [ ] Undo time window (default 7 days, configurable)
- [ ] Atomic undo for an agent session
- [ ] Partial-reversibility warnings

**Depends On:** TASK-AGT-007, Platform Core (undo system)

**Relevant PRD Sections:** §3.5

---

### TASK-AGT-009: Destructive Action Safeguards

**Context:** Extra confirmation layers for high-risk actions.

**Acceptance Criteria:**
- [ ] Bulk actions (affecting 100+ records) require explicit confirmation
- [ ] Deletes require typed confirmation (e.g., "DELETE")
- [ ] Large financial transactions (above threshold) require secondary approval
- [ ] Irreversible actions show prominent warnings
- [ ] Tenant admins can configure safeguard rules

**Depends On:** TASK-AGT-007

**Relevant PRD Sections:** §3.3 (FR-315)

---

### Phase 4: Memory & Knowledge (Weeks 9-11)

### TASK-AGT-010: Memory System

**Context:** Per-user, per-store, per-tenant memory.

**Acceptance Criteria:**
- [ ] Memory storage (key-value with scope)
- [ ] Memory injection into agent context
- [ ] Explicit memory creation (user says "remember that...")
- [ ] Learned memory (agent infers patterns over time)
- [ ] Memory management UI
- [ ] Memory sync across devices
- [ ] Memory deletion

**Depends On:** TASK-AGT-002

**Relevant PRD Sections:** §3.7

---

### TASK-AGT-011: Knowledge Base & RAG

**Context:** Document storage, embedding, retrieval for knowledge queries.

**Acceptance Criteria:**
- [ ] KnowledgeBaseDocument storage
- [ ] Embedding generation on document ingestion
- [ ] Vector similarity search
- [ ] Content in all three languages
- [ ] Tenant-specific document addition
- [ ] Platform-curated base documents (system docs, accounting rules)
- [ ] `knowledge.search` tool for agent
- [ ] Source citations in responses

**Depends On:** TASK-AGT-001 (LLM embedding provider)

**Relevant PRD Sections:** §3.8

---

### Phase 5: Proactive & Advanced (Weeks 12-14)

### TASK-AGT-012: Proactive Insights Engine

**Context:** Scheduled analysis that surfaces patterns, anomalies, deadlines.

**Acceptance Criteria:**
- [ ] Scheduled job runs analysis periodically (nightly?)
- [ ] Event-triggered insights (e.g., approaching AP due date)
- [ ] Anomaly detection (statistical outliers in sales, variances, etc.)
- [ ] Insight UI (For You tab)
- [ ] User preferences for categories
- [ ] Optional WhatsApp delivery for critical insights
- [ ] Suggested actions per insight

**Depends On:** TASK-AGT-003, various modules

**Relevant PRD Sections:** §3.9

---

### TASK-AGT-013: Chat Integration

**Context:** @agent mention in chat groups.

**Acceptance Criteria:**
- [ ] Agent responds to @agent mentions in chat groups
- [ ] Agent identifies who asked the question (when multiple users present)
- [ ] Actions require approval from the original asker (not other group members)
- [ ] Agent response visible to whole group (unless private)
- [ ] Per-group opt-in (agent not in every group by default)

**Depends On:** TASK-AGT-003, Chat module

**Relevant PRD Sections:** §3.1, US-315

---

### TASK-AGT-014: Cost Management & Admin Dashboard

**Context:** Tracking, limits, and admin visibility for agent costs.

**Acceptance Criteria:**
- [ ] Cost tracking per LLM call (provider, model, tokens, estimated cost)
- [ ] Admin dashboard: cost per user, store, provider, period
- [ ] Cost caps: user/day, store/month, tenant/month
- [ ] Soft limits with warnings
- [ ] Hard limits with agent disabling
- [ ] Per-tenant provider configuration UI
- [ ] Provider fallback configuration

**Depends On:** TASK-AGT-001, TASK-AGT-002

**Relevant PRD Sections:** §3.10, §3.13

---

### TASK-AGT-015: Activity Log & Audit

**Context:** Complete history of agent interactions for user review and admin audit.

**Acceptance Criteria:**
- [ ] User can view their own conversation history
- [ ] Store owners see agent activity in their stores (write actions only — not read conversations without permission)
- [ ] Main owner sees cross-store agent activity
- [ ] Search and filter
- [ ] Each action links to its transaction + undo option

**Depends On:** TASK-AGT-002, TASK-AGT-007

**Relevant PRD Sections:** §3.14, §9.7

---

### TASK-AGT-016: Data Entry & Configuration Assistants

**Context:** Specialized assistants for common complex workflows.

**Acceptance Criteria:**
- [ ] Natural language product entry: "Tambahkan produk X harga Y" → form pre-filled
- [ ] New store setup: copy catalog, create users, configure from template
- [ ] Bulk operations: "Naikkan harga semua LCD 5%" with preview
- [ ] Report generation: "Laporan penjualan bulan ini per kategori"

**Depends On:** TASK-AGT-007

**Relevant PRD Sections:** §2 (US-316, US-317)
