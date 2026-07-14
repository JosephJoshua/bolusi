# PRD-005: Owner Reporting & Dashboard

## 1. Overview

### Problem Statement

The main owner invests in stores but has no visibility into how they perform. Store owners manage day-to-day operations but lack the data to spot problems early — a technician who is slower than peers, a product category with collapsing margin, a store that has been quietly bleeding cash on repair reworks. Today this information exists only in the heads of the people at each store, and comparing stores means asking each store owner and hoping the numbers are honest.

Reporting is also the primary fraud-detection surface. Most fraud in this business is not a single dramatic event — it is a pattern that only becomes visible when you compare a person, a product, or a store against its peers over time. Reporting must make those patterns visible without requiring the owner to be an analyst.

### Goals

- Give the main owner a single view of every store's health, with drill-down to individual transactions
- Give store owners the same view scoped to the store(s) they manage, with aggregation across their stores
- Surface comparisons (store vs. store, technician vs. technician, this period vs. last) because comparison is what turns raw numbers into decisions
- Present every metric in plain language — no accounting or analytics jargon
- Make reports usable offline with honest staleness indicators
- Support export for sharing outside the app

### Non-Goals

- Not a BI tool. No custom query builder, no pivot tables, no user-defined dashboards. The reports are pre-designed for the questions this business actually asks.
- Not real-time. Reports reflect the last sync. Near-real-time is fine; sub-second is not a requirement.

### Success Metrics

- Main owner opens the dashboard at least 3× per week
- 80% of owner questions about store performance are answerable without leaving the dashboard
- Time from "something is wrong at a store" to "owner knows about it" drops below 24 hours
- Every headline number on the dashboard can be drilled down to the underlying transactions in ≤3 taps

---

## 2. User Stories

### Main Owner

- **US-401** [P0]: Sebagai pemilik utama, saya ingin melihat ringkasan performa semua toko dalam satu layar, sehingga saya tahu toko mana yang perlu perhatian.
  *(As the main owner, I want to see a summary of all stores' performance on one screen, so I know which store needs attention.)*

- **US-402** [P0]: Sebagai pemilik utama, saya ingin membandingkan toko-toko saya berdampingan (pendapatan, laba, jumlah servis, retur), sehingga saya bisa melihat siapa yang tertinggal.
  *(As the main owner, I want to compare my stores side by side (revenue, profit, repair count, returns), so I can see who is falling behind.)*

- **US-403** [P0]: Sebagai pemilik utama, saya ingin klik angka apa pun di dashboard untuk melihat transaksi di baliknya, sehingga saya bisa memverifikasi sendiri.
  *(As the main owner, I want to tap any number on the dashboard to see the transactions behind it, so I can verify for myself.)*

- **US-404** [P1]: Sebagai pemilik utama, saya ingin melihat tren dari waktu ke waktu (bukan hanya angka hari ini), sehingga saya bisa membedakan masalah sesaat dengan masalah struktural.
  *(As the main owner, I want to see trends over time (not just today's number), so I can distinguish a bad day from a structural problem.)*

- **US-405** [P1]: Sebagai pemilik utama, saya ingin diberi tahu ketika suatu angka menyimpang jauh dari biasanya, sehingga saya tidak perlu memelototi dashboard setiap hari.
  *(As the main owner, I want to be told when a number deviates sharply from normal, so I don't have to stare at the dashboard every day.)*

### Store Owner

- **US-406** [P0]: Sebagai pemilik toko, saya ingin melihat performa toko saya (pendapatan, laba, servis aktif, stok menipis), sehingga saya bisa mengelola operasional harian.
  *(As a store owner, I want to see my store's performance (revenue, profit, active repairs, low stock), so I can manage daily operations.)*

- **US-407** [P0]: Sebagai pemilik toko dengan beberapa toko, saya ingin melihat agregat semua toko saya sekaligus, dan bisa masuk ke masing-masing toko, sehingga saya tidak perlu login berulang.
  *(As a store owner with multiple stores, I want to see an aggregate of all my stores at once, and drill into each one, so I don't need to log in repeatedly.)*

- **US-408** [P1]: Sebagai pemilik toko, saya ingin melihat performa per teknisi (jumlah servis, waktu rata-rata, tingkat rework), sehingga saya tahu siapa yang perlu dilatih.
  *(As a store owner, I want to see per-technician performance (repair count, average time, rework rate), so I know who needs training.)*

- **US-409** [P1]: Sebagai pemilik toko, saya ingin melihat produk mana yang paling laku dan paling menguntungkan, sehingga saya bisa mengatur stok dengan lebih baik.
  *(As a store owner, I want to see which products sell most and which are most profitable, so I can manage stock better.)*

### Shared

- **US-410** [P1]: Sebagai pemilik (toko atau utama), saya ingin mengekspor laporan ke file yang bisa saya kirim atau cetak, sehingga saya bisa membahasnya di luar aplikasi.
  *(As an owner (store or main), I want to export a report to a file I can send or print, so I can discuss it outside the app.)*

- **US-411** [P0]: Sebagai pemilik, saya ingin tahu kapan terakhir data saya diperbarui, sehingga saya tidak mengambil keputusan berdasarkan data basi.
  *(As an owner, I want to know when my data was last updated, so I don't make decisions on stale data.)*

---

## 3. Functional Requirements

### 3.1 Dashboard Scope & Access

- **FR-401** [Must]: The main owner shall see data for all stores in the tenant.
- **FR-402** [Must]: A store owner shall see data only for stores they are assigned to. Attempting to view another store returns a permission error, not an empty result.
- **FR-403** [Must]: A store owner assigned to multiple stores shall see an aggregated view across their stores by default, with the ability to switch to a single store.
- **FR-404** [Must]: Managers shall see a reduced dashboard (operational metrics only — no profit, no cost prices) scoped to their store.
- **FR-405** [Must]: All metric visibility shall respect the same permission rules as the underlying modules. If a role cannot see cost price in the inventory module, no report may expose margin to that role.

### 3.2 Period Selection

- **FR-406** [Must]: Every report shall support period selection: today, this week, this month, custom range.
- **FR-407** [Must]: The selected period shall persist as the user navigates between reports within a session.
- **FR-408** [Should]: Every headline metric shall show a comparison against the equivalent prior period (e.g., "Rp 5.2jt — naik 12% dari minggu lalu").

### 3.3 Overview Dashboard (Landing Screen)

- **FR-409** [Must]: The overview shall present these headline metrics for the selected period and scope:
  - Revenue (pendapatan)
  - Profit (keuntungan)
  - Repair count — completed, and currently active
  - Sales count (POS transactions)
  - Outstanding receivables (piutang)
  - Outstanding payables (hutang supplier)
  - Cash position (estimated cash in drawer)
- **FR-410** [Must]: Each headline metric shall be tappable, leading to a detail view (see §3.9 Drill-Down).
- **FR-411** [Must]: The overview shall surface an attention list — items that need action right now:
  - Repairs overdue past estimated completion
  - Devices flagged as abandoned
  - Payables due within 7 days or overdue
  - Receivables overdue
  - Products below reorder threshold
  - Cash reconciliation variances above threshold
  - Stock opname sessions awaiting approval
  - Transfer requests awaiting approval
  - Customer returns awaiting approval
  - Warranty claims awaiting decision
- **FR-412** [Must]: Each attention item shall link directly to the screen where it can be acted upon.
- **FR-413** [Should]: The attention list shall be ordered by urgency, not by category.

### 3.4 Store Comparison (Main Owner)

- **FR-414** [Must]: The main owner shall see a table comparing all stores across: revenue, profit, margin %, repair count, average repair value, sales count, return rate, cash variance total.
- **FR-415** [Must]: The comparison table shall be sortable by any column.
- **FR-416** [Should]: Stores deviating significantly from the network median on any metric shall be visually flagged.
- **FR-417** [Should]: The main owner shall be able to select two stores for a focused side-by-side comparison.

### 3.5 Repair Reports

- **FR-418** [Must]: Repair volume over the period, broken down by status.
- **FR-419** [Must]: Average time in each repair state (intake → in_repair → qc → ready → completed). This exposes bottlenecks.
- **FR-420** [Must]: Repairs by damage type, with count and average value.
- **FR-421** [Must]: Rework rate — repairs that failed QC and returned to in_repair, and warranty claims as a share of completed repairs. This is the primary quality signal.
- **FR-422** [Must]: Per-technician breakdown: repairs completed, average completion time, rework rate, average repair value, parts cost per repair.
- **FR-423** [Should]: Repairs where the final price deviated significantly from the initial quote, with the reasons from the price log. This is both a quality signal and a fraud signal.
- **FR-424** [Should]: Abandoned device count and aging.

### 3.6 Inventory Reports

- **FR-425** [Must]: Top-selling products by quantity and by revenue.
- **FR-426** [Must]: Most profitable products by margin contribution (permission-gated — requires cost price visibility).
- **FR-427** [Must]: Dead stock — products with no movement in a configurable period.
- **FR-428** [Must]: Low stock — products below reorder threshold.
- **FR-429** [Must]: Stock adjustment summary: total adjustments by reason, by user. Frequent unexplained adjustments are a theft signal.
- **FR-430** [Must]: Stock opname history: sessions, total discrepancy value, discrepancy trend over time.
- **FR-431** [Should]: Inventory value on hand (permission-gated).
- **FR-432** [Should]: Shrinkage rate — value of stock lost to adjustments and opname discrepancies, as a percentage of inventory value.

### 3.7 Financial Reports

> These are the plain-language reports. The full accountant reports (GL, trial balance, P&L, balance sheet) live in PRD-003 §3.8 Accountant Mode and are not duplicated here.

- **FR-433** [Must]: Revenue breakdown by source: repair service revenue vs. product sales revenue.
- **FR-434** [Must]: Expense breakdown in plain language: cost of parts and goods, stock losses, other expenses.
- **FR-435** [Must]: Profit and margin % over the period, with trend.
- **FR-436** [Must]: Receivables aging: how much is owed, by how old (current, 1-30 days, 31-60, 60+).
- **FR-437** [Must]: Payables aging: how much is owed to suppliers, and what is due soon.
- **FR-438** [Must]: Payment method mix: how much came in as cash vs. QRIS vs. EDC vs. transfer. A store whose cash share is drifting downward relative to peers may be under-reporting cash sales.
- **FR-439** [Must]: Cash reconciliation summary: variance by shift, by cashier, over time.

### 3.8 Staff Reports

- **FR-440** [Should]: Per-cashier metrics: transactions handled, total sales value, cash variance history, void/return count.
- **FR-441** [Should]: Per-technician metrics (as in FR-422).
- **FR-442** [Should]: Attendance summary (integrates with HR module when available).

### 3.9 Drill-Down

- **FR-443** [Must]: Every aggregate number shall be traceable to the individual records that compose it, in at most 3 taps.
- **FR-444** [Must]: A drill-down view shall list the underlying records with the key fields, and each record shall link to its full detail screen (the repair ticket, the sale, the adjustment).
- **FR-445** [Must]: Drill-down shall preserve the active period and scope filters.

### 3.10 Anomaly Alerts

- **FR-446** [Should]: The system shall compute a baseline for key metrics per store and per user, and flag significant deviations.
- **FR-447** [Should]: Metrics monitored for anomalies shall include, at minimum:
  - Daily revenue vs. that store's own trailing average
  - Cash variance per cashier vs. their own history and vs. peers
  - Stock adjustment volume per user vs. peers
  - Repair price deviation from quote, per technician
  - Discount volume per cashier
  - Return/void rate per cashier
- **FR-448** [Should]: Alerts shall be delivered as notifications to the store owner, and to the main owner for network-level anomalies.
- **FR-449** [Must]: Alerts shall be advisory, not accusatory. An alert states what is unusual and links to the evidence; it does not assert wrongdoing.
- **FR-450** [Should]: Alert thresholds shall be configurable, and alert types individually mutable.

### 3.11 Export

- **FR-451** [Should]: Any report shall be exportable to a shareable file.
- **FR-452** [Should]: Export shall respect the exporting user's permissions — a manager's export cannot contain cost prices.
- **FR-453** [Should]: Exports shall record who exported what and when.

### 3.12 Offline Behavior

- **FR-454** [Must]: Reports for the user's own store(s) shall be computable offline from local projections.
- **FR-455** [Must]: Cross-store reports (main owner views) require synced data. When offline, the last synced version shall be shown with a prominent staleness indicator.
- **FR-456** [Must]: Every report screen shall display when its data was last synced.
- **FR-457** [Must]: When data is stale beyond a threshold, the staleness indicator shall escalate visually (see ARCH-001 §4.5).

---

## 4. Non-Functional Requirements

- **NFR-401**: Any report shall render in under 3 seconds on a 2GB-RAM Android device. Reports read from pre-computed projections; they do not aggregate raw operations at request time.
- **NFR-402**: Report projections shall be updated incrementally as operations arrive, not rebuilt wholesale.
- **NFR-403**: All labels shall be plain language. Accounting and analytics jargon is prohibited outside Accountant Mode.
- **NFR-404**: Permission enforcement shall occur in the data layer. A report must not fetch cost prices and then hide them client-side.
- **NFR-405**: All reports shall be available in Indonesian and English.
- **NFR-406**: Charts shall be legible on a small, low-brightness screen in a brightly lit shop. High contrast, few series, direct labels rather than legends where possible.

---

## 5. Data Entities (Conceptual)

Reporting introduces no new business entities. It introduces **report projections** — pre-computed aggregates derived from the operation log.

### ReportProjection (general shape)

- `scope` — tenant | store | user
- `scopeId`
- `metric` — Named metric (e.g., `revenue`, `repair_count`, `cash_variance`)
- `period` — Granularity bucket (day, week, month)
- `periodStart`
- `value` — The aggregate
- `dimensions` — Optional breakdown keys (e.g., by damage type, by payment method, by technician)
- `lastComputedAt`

Reports compose these projections. Period selections that span buckets sum the buckets; custom ranges that cut across bucket boundaries fall back to finer-grained buckets.

### MetricBaseline (for anomaly detection)

- `scope`, `scopeId`
- `metric`
- `mean`, `stdDev` — Or a comparable robust statistic
- `sampleWindow` — What period the baseline was computed over
- `lastComputedAt`

### Anomaly

- `id`
- `scope`, `scopeId`
- `metric`
- `observedValue`, `expectedRange`
- `severity` — info | warning | critical
- `detectedAt`
- `status` — unread | read | dismissed | investigated
- `evidenceRef` — Link to the drill-down that shows the underlying records

---

## 6. UI/UX Flows

### 6.1 Overview Dashboard

The landing screen for owners. Structure, top to bottom:

1. **Scope + period selector.** Store picker (or "All stores" for main owner / multi-store owner) and period tabs. Sticky.
2. **Sync status line.** "Diperbarui 5 menit lalu" — escalates to a warning banner when stale.
3. **Attention list.** If empty, this section collapses to a single "Semuanya beres" line. If not empty, it is the first thing the owner sees. Each item is one line: what it is, how urgent, and a tap target.
4. **Headline metrics.** Large numbers with period-over-period deltas. Revenue, profit, repairs, sales, receivables, payables, cash.
5. **Trend.** One chart, not six. Revenue and profit over the selected period. Everything else is one tap away.

**Design note:** The attention list sits above the metrics deliberately. Metrics tell you how things went; the attention list tells you what to do. For a busy owner on a phone, the second is more useful, and burying it below a wall of numbers means it does not get read.

### 6.2 Store Comparison (Main Owner)

A sortable table, one row per store. Columns: store, revenue, profit, margin %, repairs, sales, returns, cash variance.

Stores that deviate sharply from the network median are marked — not with an accusation, just a marker that draws the eye. Tapping a store switches the whole dashboard scope to that store.

Selecting two stores opens a focused comparison: the same metrics, two columns, differences highlighted.

### 6.3 Report Detail Screens

Each report (repair, inventory, financial, staff) is its own screen with a consistent shape:

- Same scope + period selector, carried over
- A small number of charts (rarely more than two)
- A table of the underlying breakdown
- Every row tappable, leading to the records behind it

### 6.4 Drill-Down

Tapping a number anywhere leads to a list of the records that produced it, filtered to the same scope and period. From that list, tapping a record opens its native detail screen — the actual repair ticket, the actual sale, the actual stock adjustment.

The path back preserves state. An owner who drills three levels deep and comes back should land where they left.

### 6.5 Anomaly Alerts

Alerts appear in the attention list and as push notifications. Each alert reads as an observation, not a verdict:

> "Selisih kas Kasir Joko minggu ini Rp 180.000 lebih besar dari biasanya. Lihat detail."
> *(Cashier Joko's cash variance this week is Rp 180,000 larger than usual. See details.)*

Tapping shows the underlying reconciliations and the baseline it was compared against. The owner draws their own conclusion.

---

## 7. Edge Cases & Error States

- **New store with no history.** Comparisons and baselines need data. A store with under a configurable minimum of history shows metrics but not comparisons or anomaly flags, with a note explaining why.
- **Store owner with one store.** The aggregate view is meaningless. Skip it and land directly on the single store.
- **Period with no activity.** Show zero, not an empty state. "Rp 0" is information; a blank screen is not.
- **Offline main owner.** Cross-store data is only as fresh as the last sync of *each* store. A store that has not synced in three days contributes stale data to the network aggregate. The staleness indicator must reflect the *oldest* contributing store, not the current device's sync time. This is easy to get wrong and it silently produces false confidence.
- **Permission mismatch mid-session.** A user's role changes while they have a report open. On the next fetch, the report must re-check permissions and drop newly-forbidden fields rather than serving cached privileged data.
- **Timezone.** "Today" must mean today in the store's local time, not the device's or the server's. Stores in West Papua are UTC+9 (WIT). If the tenant ever spans timezones, the period boundary must follow the store.
- **A repair spanning periods.** A repair opened in one month and completed in the next. Revenue is recognized on completion (see PRD-003), so it lands in the completion month. Repair *count* metrics must be explicit about whether they count opened or completed repairs — the reports should show both and label them clearly.
- **Deleted or corrected data.** Nothing is deleted; corrections are reversing operations. A report over a past period may therefore change as corrections arrive. This is correct behavior, but it means a report is not immutable — an exported report and a freshly-generated one for the same period may differ. Exports should record their generation timestamp for this reason.

---

## 8. Fraud Prevention Measures

Reporting is where employee fraud becomes visible. The reports below are designed around specific fraud patterns rather than generic analytics.

| Fraud pattern | The report that surfaces it |
|---|---|
| Cashier pockets cash by not recording a sale | Payment method mix drifting away from cash relative to peers; cash variance trend per cashier |
| Cashier voids a completed sale and keeps the cash | Void/return rate per cashier vs. peers |
| Employee removes stock and covers it with an adjustment | Stock adjustment volume by user; adjustment reasons; shrinkage rate |
| Employee removes stock and lets opname absorb it | Opname discrepancy trend per store; discrepancy value over time |
| Technician inflates parts usage and keeps the parts | Parts cost per repair by technician vs. peers, for the same damage type |
| Technician quotes low, then inflates mid-repair (kickback or padding) | Price deviation from initial quote, by technician, with the price-log reasons |
| Cashier applies unauthorized discounts for friends | Discount volume per cashier |
| Fake repairs billed for work not done | Repair value distribution per technician; repairs completed with zero or minimal parts consumption |
| Collusion on supplier returns | Supplier return volume and resolution outcomes per purchaser |

**Design principle:** these reports compare a person against their own history and against their peers doing the same job. A single number in isolation proves nothing. A cashier whose cash variance is consistently negative while every other cashier's hovers around zero is a pattern worth a conversation — and the report's job is to make that pattern visible, then get out of the way. The system does not accuse; it shows the owner where to look.

---

## 9. Open Questions

- **OQ-401**: What is the reorder threshold for "low stock" — a fixed quantity per product, a computed days-of-cover figure, or both? Days-of-cover is more useful but requires sales velocity, which needs history.
- **OQ-402**: What defines "dead stock"? Suggested default: no movement in 90 days. Confirm with Ocep.
- **OQ-403**: What cash variance threshold should trigger an alert? Absolute (e.g., Rp 50,000) or relative to the shift's cash volume? Relative is fairer to high-volume shifts.
- **OQ-404**: How much history is needed before a store or user gets a baseline and becomes eligible for anomaly flagging? Suggested: 30 days.
- **OQ-405**: Should the main owner see per-employee metrics across all stores, or only per-store aggregates with the store owner handling employee-level detail?
- **OQ-406**: Export format — PDF for sharing and printing, or spreadsheet for further analysis? Both is possible but doubles the work.
- **OQ-407**: Should reports be schedulable (e.g., a weekly summary pushed to the owner's WhatsApp), or is pull-only sufficient for V1?

---

## 10. Claude Code Task Breakdown

### TASK-RPT-001: Report Projection Infrastructure

**Context:** Reports must not aggregate the raw operation log at request time — that will not meet the performance target on low-end devices. Build the projection layer that maintains pre-computed metric buckets.

**Acceptance Criteria:**
- [ ] ReportProjection storage: scope, metric, period bucket, value, dimensions
- [ ] Incremental update: an incoming operation updates affected buckets rather than triggering a full rebuild
- [ ] Bucket granularities: day, week, month
- [ ] Custom date ranges compose from day buckets
- [ ] Rebuild path exists for correctness (used after sync brings out-of-order operations)
- [ ] Permission metadata attached to each metric so the query layer can filter before returning

**Depends On:** Platform Core (operation log, projection system)

**Relevant PRD Sections:** §5, NFR-401, NFR-402

---

### TASK-RPT-002: Scope & Permission Layer for Reports

**Context:** Every report is scoped to what the requesting user is allowed to see. This must be enforced in the data layer, not the UI.

**Acceptance Criteria:**
- [ ] Resolve the set of stores a user may see (main owner: all; store owner: assigned; manager: their store)
- [ ] Resolve the set of metrics a user may see (e.g., margin requires cost-price permission)
- [ ] Queries for forbidden scopes return a permission error, not empty data
- [ ] Forbidden metrics are never fetched, not merely hidden
- [ ] Permission is re-checked on every fetch, not cached for the session

**Depends On:** TASK-RPT-001, Auth module

**Relevant PRD Sections:** §3.1, NFR-404, §7 (permission mismatch mid-session)

---

### TASK-RPT-003: Overview Dashboard

**Context:** The landing screen. Attention list first, then headline metrics, then one trend chart.

**Acceptance Criteria:**
- [ ] Scope selector (store picker / all stores) and period selector, both sticky and persistent across navigation
- [ ] Sync status line with escalating staleness treatment
- [ ] Attention list assembled from all sources in FR-411, ordered by urgency, each item linking to its action screen
- [ ] Headline metrics with period-over-period deltas
- [ ] One revenue/profit trend chart
- [ ] Every metric tappable into drill-down
- [ ] Renders in under 3 seconds on a 2GB device
- [ ] Works offline for own-store scope

**Depends On:** TASK-RPT-001, TASK-RPT-002

**Relevant PRD Sections:** §3.3, §6.1

---

### TASK-RPT-004: Store Comparison View

**Context:** The main owner's core screen for spotting the store that needs attention.

**Acceptance Criteria:**
- [ ] Sortable table, one row per store, columns per FR-414
- [ ] Deviation from network median visually flagged
- [ ] Tap a store to switch dashboard scope to it
- [ ] Two-store focused comparison view
- [ ] Staleness reflects the oldest contributing store's sync time, not the local device's

**Depends On:** TASK-RPT-001, TASK-RPT-002

**Relevant PRD Sections:** §3.4, §6.2, §7 (offline main owner)

---

### TASK-RPT-005: Repair Reports

**Context:** Repair volume, cycle time, quality, and per-technician performance.

**Acceptance Criteria:**
- [ ] Volume by status over period
- [ ] Average time in each state (bottleneck view)
- [ ] Breakdown by damage type with count and average value
- [ ] Rework rate: QC failures and warranty claims as a share of completed repairs
- [ ] Per-technician: count, average time, rework rate, average value, parts cost per repair
- [ ] Price-deviation-from-quote report with price log reasons
- [ ] Abandoned device count and aging
- [ ] Repair count metrics explicitly labeled as opened vs. completed

**Depends On:** TASK-RPT-001, TASK-RPT-002, Repair module

**Relevant PRD Sections:** §3.5

---

### TASK-RPT-006: Inventory Reports

**Context:** What sells, what earns, what sits, and what goes missing.

**Acceptance Criteria:**
- [ ] Top sellers by quantity and by revenue
- [ ] Most profitable by margin contribution (permission-gated)
- [ ] Dead stock (configurable no-movement window)
- [ ] Low stock against reorder threshold
- [ ] Stock adjustment summary by reason and by user
- [ ] Opname history with discrepancy value trend
- [ ] Inventory value on hand (permission-gated)
- [ ] Shrinkage rate

**Depends On:** TASK-RPT-001, TASK-RPT-002, Inventory module

**Relevant PRD Sections:** §3.6

---

### TASK-RPT-007: Financial Reports (Plain Language)

**Context:** The owner-facing financial reports. Accountant Mode reports live in PRD-003 and are out of scope here.

**Acceptance Criteria:**
- [ ] Revenue split: repair service vs. product sales
- [ ] Expenses in plain language: parts and goods, stock losses, other
- [ ] Profit and margin with trend
- [ ] Receivables aging buckets
- [ ] Payables aging with upcoming dues
- [ ] Payment method mix
- [ ] Cash reconciliation summary by shift and by cashier
- [ ] No accounting terminology anywhere in this surface

**Depends On:** TASK-RPT-001, TASK-RPT-002, Finance module

**Relevant PRD Sections:** §3.7, NFR-403

---

### TASK-RPT-008: Staff Reports

**Context:** Per-cashier and per-technician performance.

**Acceptance Criteria:**
- [ ] Per-cashier: transaction count, sales value, cash variance history, void/return count, discount volume
- [ ] Per-technician: as in TASK-RPT-005
- [ ] Attendance summary (deferred if HR module not yet built — stub the integration point)

**Depends On:** TASK-RPT-001, TASK-RPT-002

**Relevant PRD Sections:** §3.8

---

### TASK-RPT-009: Drill-Down Navigation

**Context:** Every aggregate must lead to the records behind it. This is what makes the dashboard trustworthy rather than merely decorative.

**Acceptance Criteria:**
- [ ] Any metric taps through to a filtered record list within 3 taps
- [ ] Record list preserves the active scope and period
- [ ] Each record links to its native detail screen (repair ticket, sale, adjustment)
- [ ] Back navigation restores prior scroll position and filter state

**Depends On:** TASK-RPT-003 and the report screens

**Relevant PRD Sections:** §3.9, §6.4

---

### TASK-RPT-010: Anomaly Detection & Alerts

**Context:** Compute baselines and flag deviations. This is the fraud-detection surface — see §8 for the specific patterns it must catch.

**Acceptance Criteria:**
- [ ] Baseline computation per scope and metric over a rolling window
- [ ] Minimum-history requirement before a scope becomes eligible for flagging
- [ ] Deviation detection across the metrics in FR-447
- [ ] Peer comparison (a user against others in the same role at the same store) in addition to self-comparison
- [ ] Alerts surface in the attention list and as push notifications
- [ ] Alert copy is observational, never accusatory
- [ ] Each alert links to the evidence
- [ ] Thresholds configurable; alert types individually mutable

**Depends On:** TASK-RPT-001, all reporting tasks

**Relevant PRD Sections:** §3.10, §8

**Notes for Implementation:**
- Prefer robust statistics (median, MAD) over mean and standard deviation. Retail data is skewed and a single large legitimate transaction should not blow out the baseline and suppress future alerts.
- Peer comparison is the higher-signal check. A cashier whose variance is drifting is interesting; a cashier whose variance is drifting *while their colleagues' is not* is actionable.

---

### TASK-RPT-011: Report Export

**Context:** Get a report out of the app in a form that can be printed or sent.

**Acceptance Criteria:**
- [ ] Export any report to a shareable file
- [ ] Export respects the exporting user's permissions
- [ ] Generation timestamp embedded in the export (see §7 on corrections changing past periods)
- [ ] Export action is logged: who, what, when

**Depends On:** The report screens

**Relevant PRD Sections:** §3.11
