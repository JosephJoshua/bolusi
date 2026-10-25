# Product direction and roadmap

Bolusi is an offline-first ERP for a phone-repair franchise in West Papua,
Indonesia: roughly 10 stores today, with an ambition to support about 100 and,
after proving the product in our stores, offer multi-tenant SaaS. There is no
fixed SaaS launch deadline. The aim is to connect repairs, goods, money and people
so owners can understand what happened without reconstructing it from paper and
WhatsApp.

This carries forward the earlier product discussions and the owner's October
repair-first decisions. It is a living direction, not a promise to build every
idea. The owner explicitly wants Claude to challenge and refine each scope when
it becomes the next implementation request. Existing ideas provide a starting
point for that conversation.

## Who and what we design for

- Main owners, store owners, managers, cashiers, technicians, purchasers, drivers
  and accountants, with configurable roles and store-scoped access.
- Staff with limited technical experience using shared, low-end phones. Fast
  individual PIN switching, clear attribution, large controls and little typing.
- Unreliable connectivity and long power outages. Routine store work must survive
  offline use; sync status and stale information must be understandable.
- Android and iOS as first-class targets, with Bahasa Indonesia and English.
  Desktop remains a later option.
- Auditable business events, recoverable mistakes and honest evidence. Stock and
  money must reconcile; signatures and location alone do not prove a human claim.
- Simple workflows for shop staff, with deeper financial and operational views
  available to the people who need them.

## Milestones

| Stage                             | Intended outcome                                                                                                                                       | Current standing                                                                                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **v0 — Foundation proof**         | Offline operation log, sync, authentication, tenant isolation, media, translations and notification infrastructure, exercised by Notes.                | Implemented foundation; see [architecture](architecture.md) for remaining limits and unverified hardware behavior. This is not a usable repair business release.    |
| **V1 — Complete repair journey**  | Run a repair from intake through parts sourcing, work, QC, pickup, payment and warranty, with real customer, inventory and finance foundations.        | Chosen first release. Detailed decisions are in [repair scope](product-scope.md); unresolved choices need discussion as slices are selected.                        |
| **After the repair release**      | Extend into standalone retail/wholesale POS and useful owner reporting. Consider direct EDC terminal integration (previously proposed as v1.1).        | Candidate next scopes; order, size and providers remain undecided. A small owner view can be scoped separately once repair data exists.                             |
| **v1.x — Wider store operations** | Attendance, wholesale delivery, supporting GPS services, fuller reporting and contextual internal chat.                                                | Earlier direction, with sequencing still open. Chat was the lowest priority and needs evidence that staff want it.                                                  |
| **SaaS and desktop expansion**    | Serve other businesses through tenant onboarding and configuration; decide billing/support/suspension behavior and whether a desktop client is useful. | Longer-term ambitions after V1, without dates or a fixed order relative to other later scopes. Tauri was a preference to investigate, not a settled desktop design. |
| **V2 — In-product AI assistant**  | Let users ask questions about their business and, with appropriate permissions and confirmation, request actions.                                      | Deferred idea to revisit after useful workflows exist. This is a Bolusi feature, separate from using Claude Projects to develop Bolusi.                             |

### The current repair sequence

Use these as practical slices, adjusting boundaries after discussion:

1. Settle the choices needed for the selected slice: real shop workflow,
   permissions, offline exceptions, evidence, hardware or provider constraints.
2. Establish customer records, parts catalog and sourcing/stock movements, plus
   repair payments and supplier invoices/payments/refunds with real accounting.
3. Deliver offline intake, condition/evidence capture, diagnosis/quote and repair
   printing. This is a usable slice, not the whole release.
4. Connect technician assignment, ordering/transferring/using parts, repair work
   and QC, including failure paths.
5. Complete pickup/handover, payment reconciliation and warranty handling; verify
   the complete journey through disconnection and later sync.
6. Separately select reporting and retail checkout scope from actual shop needs.

Supplier purchasing, partial receiving, physical returns/replacements, payables,
recorded supplier payments/refunds, cross-store transfers, permission management,
required ownership video, integrated QRIS and an approved device-model lookup
source are already part of the chosen repair release. Do not silently reduce it
to intake-only, or make standalone retail checkout a prerequisite. Resolve the
remaining provider, hardware and business-rule choices in [repair scope](product-scope.md).

## The wider product we discussed

The linked references preserve the detailed earlier ideas, examples, UI flows,
edge cases and questions. Their old priority labels are not release commitments.

| Area                     | Direction to carry forward                                                                                                                                                                                                                                                        | Discussion reference                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Repair                   | One-sitting intake/diagnosis/quote; device evidence and lookup; auditable pricing; queue and assignment; parts use; QC; handover; warranty; abandoned-device handling; paper copies and customer communication.                                                                   | [Repair](product-reference/PRD-001-repair-lifecycle.md)               |
| Inventory and purchasing | Store catalogs, tier/volume prices, catalog copying, stock movements/counting/adjustments, supplier orders/returns, cross-store procurement, customer returns and barcodes. Repair needs a subset now; broader catalog and retail functionality is later.                         | [Inventory](product-reference/PRD-002-inventory.md)                   |
| Finance                  | Accounting generated from business actions; simple owner views; repair payments and supplier balances first. Later ideas include B2B receivables, cash reconciliation, full accrual accounting, accountant mode and consolidated reports.                                         | [Finance](product-reference/PRD-003-financial-accounting.md)          |
| AI assistant             | Natural-language queries, read-only default, permission-bound actions with previews and explicit confirmation, appropriate reversals, bulk work, knowledge/memory, proactive insights and cost controls. Language/provider choices and the amount of automation remain proposals. | [Agent mode](product-reference/PRD-004-agent-mode.md)                 |
| Owner reporting          | Store health and comparisons; repair, inventory, financial and staff reports; drill-down to transactions; understandable stale/offline data; potential anomaly review and exports. Predefined business questions, rather than a custom BI system.                                 | [Reporting](product-reference/PRD-005-owner-reporting.md)             |
| Retail and wholesale POS | Fast scan/search checkout, customer-tier and volume pricing, controlled discounts, split payments, B2B credit, receipts, voids/returns, shift reconciliation and shareable wholesale catalog ordering. Repair payment stays in the repair journey.                                | [POS](product-reference/PRD-006-pos.md)                               |
| Attendance               | Employee records, clock-in/out with photo/location, schedules/lateness, presence, corrections, leave and history. Payroll is a separate undecided scope; attendance export was a preferred smaller option.                                                                        | [Attendance](product-reference/PRD-007-hr-attendance.md)              |
| Wholesale delivery       | Runs/manifests, address capture, driver assignment/navigation, proof of delivery, cash collection, failures and end-of-run goods/cash reconciliation. Deliver wholesale goods, not repaired phones.                                                                               | [Delivery](product-reference/PRD-008-delivery.md)                     |
| Location and evidence    | Shared location/geofence services for attendance, delivery and evidence; honest accuracy and stale-location handling; delivery-run tracking, appropriate alerts and retention/privacy choices. Location is evidence to assess, not an automatic fraud verdict.                    | [GPS and evidence](product-reference/PRD-009-gps-antifraud.md)        |
| Internal chat            | Conversations attached to repair/business records, organization-based groups, offline send, notifications and search; polls were an idea to validate. Employees only; assess whether a narrow record thread offers enough value over WhatsApp.                                    | [Chat](product-reference/PRD-010-chat.md)                             |
| Identity and access      | Individual attribution on shared devices, owner-configurable granular permissions, scoped roles, device enrollment/revocation, multi-store access and strict tenant isolation. V1 includes owner-facing permission administration and approval rules.                             | [Auth and permissions](product-reference/PRD-011-auth-permissions.md) |
| Platform and growth      | Durable offline actions, sync/conflict visibility, media, printing, translations, notifications and eventual onboarding. Extend existing foundations when a selected business workflow needs it.                                                                                  | [Platform](product-reference/PRD-012-platform-core.md)                |

## Boundaries and conditional ideas

Previously excluded ideas remain excluded unless the owner explicitly revisits
them: vouchers, store credit, loyalty points, voice input/messages, delivery of
repaired phones, facial recognition/behavioral analysis and custom BI/query
builders. Their absence is deliberate, not an invitation to fill gaps.

Payroll and tax/e-Faktur/PPN are undecided later possibilities, not first-release
requirements. Reassess actual business needs and current rules if they are ever
selected; old research figures are not current guidance. Agent mode is deferred
to V2, not permanently rejected.

Cross-store sync/store switching must be addressed when chosen workflows need
them. Per-user notifications/preferences and profile-photo management were later
ideas. Tenant onboarding, billing-related suspension and consented support access
belong to SaaS scoping. Storage retention/snapshots and signing-key rotation need
measured workload or concrete operational requirements. These are remembered
considerations, not a queue of preventative infrastructure tasks.

## How to start each scope with Claude

When the owner says to implement a new scope, first read this direction, the
applicable current decisions and the relevant reference sections. Briefly state
what was previously discussed, what already exists, and what remains undecided.
Then **grill the owner on the consequential choices**: ask focused questions in
small rounds, use concrete shop scenarios, challenge contradictions and ask
whether proposed complexity earns its place.

Cover the intended user/outcome, the smallest useful boundary, exceptions and
approvals, offline/sync behavior, stock/money/evidence consequences, and what would
make the result acceptable. Bring relevant provider/hardware/cost choices into
that conversation. Recommend simpler alternatives where useful; do not treat an
old “Must” or target metric as a fresh approval.

Summarize the resulting scope and explicitly record changes to earlier decisions
in a short repository note or the relevant current scope document. Once the
material choices are settled and implementation is authorized, proceed without
repeatedly reopening them. Routine fixes and implementation details do not need
a new discovery interview. No task IDs, mandatory phase pipeline or large spec
set is required.

## Sources and precedence

The broader ideas come from the original twelve PRDs at `06b063b`. Milestones and
repair sequencing also use the owner's locally edited October product overview
and roadmap preserved during migration; those edits were newer than that commit.
The detailed October repair decision remains in [product scope](product-scope.md).

For product intent, latest explicit owner decisions take precedence over current
scope notes, which take precedence over earlier proposals. Keep the notes aligned
after a decision. For what is actually implemented or verified, inspect code and
executed checks; neither a roadmap nor Project memory establishes completion.
