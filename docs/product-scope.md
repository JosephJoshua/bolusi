# V1 scope — complete repair journey first

Business decisions carried forward from the owner’s October 13–17 discussions.
See [product direction](product-direction.md) for the full vision and milestone
sequence and [earlier discussions](product-reference/README.md) for the PRDs.
References to old numbered specs and tasks are historical; recover those from
Git at `06b063b` only when needed. This file preserves scope, not the retired
specification/task workflow. Current implementation limits: `architecture.md`.

**Status:** Product direction decided by the owner on 2026-10-13, with follow-ups
through October 17. These decisions are the current starting point, and the owner
may revise them. Before implementing a new scope, discuss the relevant unresolved
choices and challenge assumptions; record any changed agreement. The old PRDs are
inputs to revalidate, not executable specifications.

## Slice 1 agreement — digital repair ticket (2026-10-25)

Agreed with the owner before implementation. This is the first usable slice; it
overrides the earlier "foundations first" ordering in product direction.

- **Outcome:** replace the paper ticket and WhatsApp tracking with a repair ticket
  from intake to handover, piloted in one store. Stock and customer payments are
  later slices; payments stay in the store's paper cash book until then. The
  ticket keeps a stable ID and quote total so a payment ledger attaches later
  without reworking tickets.
- **Intake (cashier only):** customer name required, phone encouraged but never
  forced. Device entered manually (model lookup later). Condition checklist,
  peripherals, complaint, itemized quote lines (parts/labour) and estimated
  completion. The customer leaves with a price that may change later. All 6
  intake photos are required. Customers who wait in the store get the same
  ticket and documents, since they may return for warranty.
- **Finding tickets:** offline search by name with Indonesian spelling
  tolerance, any phone format (08…, 628…, +628…), ticket number, IMEI and model.
- **Work:** a store queue; technicians self-assign or are assigned. Technicians
  never do intake. Each ticket tracks **repair outcome** (received, in repair,
  waiting for parts, repaired, cancelled) separately from **device location**
  (in store, returned to customer), so "cancelled, still in store" is visible.
- **Work photos:** besides the 6 intake photos the counter takes, technicians
  take at least one before photo to start work and at least one after photo
  each time they mark a repair done.
- **One device per job:** counter staff and technicians can each do their whole
  job on a phone or on a computer; nobody is made to switch devices mid-job. A
  PC without a camera or touch screen hands photos and signatures to a store
  phone (this hand-off may need a connection). Owners use either and see at
  least what staff see. Ownership video, when specified, is taken at intake.
- **Price changes:** after intake, each change is a new logged line with a reason
  and a "customer agreed" mark. Only the cashier or store owner applies changes;
  technicians propose.
- **Handover:** photo, signature and a printed final document.
- **Clients:** three over time sharing the offline core, logic and translations:
  the Expo mobile app (technicians, phone-only counters); an **Electron** desktop
  app for Windows counter PCs with its own DOM UI (see Counter PC app below); and
  a web app later for back-office work. A pure web counter was rejected: browsers
  cannot send raw output to dot-matrix printers and their offline storage is
  less durable.
- **Printing:** every ticket gets a repair order with store and customer copies.
  Documents are code templates in the repo (Crystal Reports is retired; no
  report-designer product). HTML/CSS pages print through the desktop app to any
  installed printer, any paper size, or PDF. An ESC/P text-mode renderer drives
  Epson-compatible dot-matrix printers on blank carbonless continuous paper.
  Owners edit store details and terms, not layouts.
- **UX:** screens follow user flows, not record editing; guided photo capture;
  search-first finding. Admin grids later get Excel-like in-place bulk editing.
- **No paid components:** use high-quality open-source libraries or build it.

## Counter PC app (2026-10-26)

Agreed with the owner before building the Electron app.

- **Its own desktop UI.** The counter is used all day, so the PC must not feel
  like a phone app in a window: real tables, mouse and keyboard, side-by-side
  panes. Screens are React DOM (Radix, Tailwind, TanStack Table); repair rules,
  queries, commands, search and translations stay shared with the phone. A test
  of the phone screens in a desktop browser was fast enough but read as a
  stretched phone list. The later web back office reuses the desktop parts.
- **Counter first.** v1 covers what the phone does today: enrolment, PIN
  switching, the board, intake, ticket, handover, settings, plus printing.
  Back-office screens belong to the web app later.
- **One-page intake** with sections (customer, device, condition, price,
  photos) instead of the phone's wizard, so keyboard users can Tab through.
- **Camera:** use the PC's webcam when present, otherwise hand the step to a
  store phone by QR.
- **Enrolment** works like a phone: an owner signs in once and picks the store,
  then staff switch by PIN. One PC belongs to one store.
- **Windows 10 and 11 only.** Electron and Chrome dropped Windows 7/8 in 2023;
  a store still on Windows 7 upgrades or uses a phone at the counter. Must stay
  responsive on 4 GB machines.
- **Install and updates:** a normal installer that updates itself from GitHub
  Releases. Unsigned for the pilot (Windows warns on first install).
- **Printing:** dot-matrix printers are USB and installed in Windows; the app
  sends raw ESC/P through the Windows spooler and HTML pages through normal
  printing. Templates are shared code owned by the printing work.

## Configurable intake lists and phone catalog (2026-10-26)

Agreed with the owner after slice 1's phone screens.

- **Editable lists:** intake condition checks, accessories left with the phone,
  intake photo angles, quick brand buttons and ready-by choices stop being fixed
  in code. The owner sets them for the whole franchise; a store may hide items
  it does not use. Edits happen on the owner's phone (later also the back-office
  web) and sync like any other change, so counters work offline with the last
  list they received.
- **History stays true:** a servisan keeps showing what was recorded at intake,
  even after an item is renamed or removed.
- **As built:** avatar menu → Pengaturan → Servisan → "Pilihan saat terima HP"
  (the avatar menu also holds "Ganti pengguna"). Rows reorder by dragging their
  handle; a store hides an item with its "Tampil di toko ini" switch, while
  "Hapus dari semua toko" removes it everywhere. Changing a list
  needs `repair.manage_intake_options` (tenant-wide, main owner); hiding items
  for a store needs `repair.hide_intake_options` (store owner, or the owner on
  that store's device). Built-in items keep their translated names until
  renamed. Every listed photo angle is required at intake, and a store always
  keeps at least one photo angle and one ready-by choice. Ready-by choices are
  day counts (0 to 60) plus an optional "Belum tahu". The later save wins.
- **Phone catalog:** the owner chose to crawl GSMArena, slowly, including phone
  photos, knowingly accepting its terms-of-use and image-copyright risk. Models
  learned from intakes supplement it. The catalog syncs to devices for offline
  typo-tolerant model search; photos download only when shown.
  Built with these defaults: one request a second, slowing down by itself when
  refused, robots.txt obeyed; phones, tablets and watches all kept; learned
  models come from the store's own intakes. The model is typed first and a
  catalog match fills the brand. Specs are kept per model: the counter sees
  memory variants and colour choices, someone who repairs also sees screen,
  chipset, battery and charging, port, SIM, card slot and system.
- **Screen lock at intake:** none, PIN, password or pattern (drawn on a 3 x 3
  pad the way the customer draws it). It stays in the ticket's one passcode
  text as `kind:value` (`pattern:14789`), so no operation changed; older
  passcodes show as typed. Hidden on the ticket until someone taps to show it.
  Choice chips from lists that grow (colours, quick brands, accessories) scroll
  sideways in one row instead of wrapping.

## Cancelling a servisan (2026-10-26)

Agreed with the owner. Counter staff have kept a customer's cash by marking the
repair cancelled, so cancelling is an owner decision, as in the old system.

- **Owners only:** the store owner or main owner cancels, always with a reason.
  Cashiers no longer can; a cashier who needs a cancel asks the owner, who does
  it on their phone or with their PIN on the counter device.
- **Any time before handover:** a repaired phone can still be cancelled (the
  customer won't pay or collect), since only owners can do it.
- **Cancellation fee:** each store has two fees set by its owner in Settings →
  Servisan: before work starts and after work has started (a technician has
  started work on it at least once). Both start at Rp 0. The fee in force is
  filled in when cancelling and the owner may change it; the record keeps both.
- **Customer sees it:** the handover of a cancelled phone shows the fee owed
  ("Biaya pembatalan"), and the customer signs under it. The printed slip will
  show it too once printing lands.
- **Owners see every cancel:** a "Dibatalkan" view on the board, for owners
  only, lists each cancel with who, when, reason and fee, and flags a fee that
  differs from the store's.
- **Discounts are owners' too:** any line that lowers a price (a discount, or a
  negative adjustment) needs an owner, at intake or later. Counter staff and
  technicians can still raise a price or propose a part or labour; the counter
  can decline an owner's proposed discount but not apply it.
- **Any drop in what a customer owes is an owner's** (2026-10-27): a lower
  price, a lower or removed down payment, a lower cancellation fee. Every later
  module follows this rule (for example a POS discount or a refund).
- **A price change counts only once the customer agrees:** whether a technician
  proposes it or the counter enters it, a change waits ("Menunggu persetujuan
  pelanggan") and is left out of the total until the counter records the
  customer's yes; a no drops it. There is no applying without asking, and the
  phone cannot be handed back while a change waits. Technicians keep proposing,
  since they find the extra fault once the phone is open.

## Printing repair slips (2026-10-26)

Agreed with the owner before building printing.

- **Paper:** two-ply carbonless continuous paper (pink kept by the store, yellow
  for the customer) on whatever Epson-compatible dot-matrix the store has, or
  plain paper. No printer model is assumed: text mode uses the basic ESC/P set,
  and the store picks a paper preset (9.5" continuous half form, the landscape
  default, or full form; A4 or A5 either way round) or types a size, then checks
  it with a test page. Windows printing cannot report the paper, so it is never
  auto-detected. The paper is a setting of each device, picked once in its
  Settings (owner, 2026-10-27), not at every print.
- **Layout:** on landscape paper the money and terms sit beside the customer and
  phone details. Every field is printed whole at its longest allowed length,
  wrapping rather than cutting. An ordinary slip fits one half form at the
  printer's default 6 lines per inch, a line down from the perforation; only a
  longer one tightens to 8 lines per inch (only 1/6" and 1/8" mean the same on
  9-pin and 24-pin Epsons) before spilling onto a second form. Spare lines go
  above the signatures. Plain paper gets more spacing. A cancelled servisan's
  slip has no warranty terms.
- **Two documents:** the intake receipt ("Tanda terima servisan") and the
  handover slip ("Nota servisan") for a pickup or a cancel, which is also the
  customer's receipt. No technician job sheet. Repair counters have no separate
  thermal printer, so receipts use the same paper; thermal stays for POS.
- **Money on the slips:** the intake receipt shows the quoted lines and total;
  the handover slip shows the lines that count (or the cancellation fee) and the
  total. A down payment ("DP") taken at intake is recorded on the servisan now,
  ahead of the payments slice, printed on both slips with what is left to pay,
  and only an owner can change it.
- **Signatures:** a signature line for the customer and the staff member on both
  slips; the handover also keeps the on-screen signature, shown on plain paper.
- **Header and terms:** owners edit the store name, address, phone, an optional
  logo and the terms of each slip. The logo prints on plain paper and PDF, and
  on dot-matrix only when switched on. The unlock code is never printed.
- **Reprints** say "Cetak ulang ke-N", and every print is logged on the servisan.
- **Phone-only counters** make a PDF to print through the phone's print dialog
  or share (for example on WhatsApp), on A4 or A5 (remembered per phone).
  Dot-matrix printing is the desktop app's. Android's print dialog does not
  report a cancel, so the phone asks whether the slip printed before logging it;
  a cancelled first print never makes the real one read "Cetak ulang".
- **Logo from the gallery:** the store logo is the one picture that may come from
  the phone's gallery. Evidence photos stay camera-only; the lint rule allows the
  photo picker in exactly one file, which feeds only the slip settings screen.
- **Code:** one shared printing layer (core `print`: document model, HTML and
  ESC/P renderers) that POS receipts will reuse; slips are module templates.

## Who makes a first PIN (2026-10-26)

A phone that is offline or behind can show "no PIN yet" for someone who made one
elsewhere, so a self-made first PIN there would let a coworker sign in as them.

- **The owner who set up the phone** makes their own first PIN on it, right after
  setup, and only if the server has no PIN for them.
- **Everyone else** gets their first PIN from an owner (Settings → PIN karyawan),
  typed by the person themselves. Their name in the switcher says "Belum ada PIN"
  and tells them to ask an owner.
- Phones set up before this change have no such owner on record, so an owner
  without a PIN there gets theirs from another owner.

## Decision

The first shippable v1 workflow is the **complete repair journey**, not an intake-only prototype or a retail sale: customer/device intake, condition and evidence, diagnosis and quote, technician assignment and parts consumption, QC, pickup and handover, payment, printed repair order, and warranty handling. Deliver this through smaller vertical slices with an end-to-end offline/sync acceptance case before calling the milestone shippable. Build the minimum real customer, inventory/stock, and finance/payment foundations the journey needs; do not substitute fake stock deductions or unbalanced payment records. Standalone retail POS checkout is **not** a prerequisite and is deferred to a later scope decision.

**Parts ordering (owner follow-ups, 2026-10-14):** the first v1 release must manage ordering repair parts, not merely record stock received. Include supplier purchase orders for needed parts, track order and partial-receipt state, receive into auditable stock, and associate ordered/used parts with their repair where applicable. Cross-store sourcing is essential: a store can request parts from another permitted store, track authorization and dispatch, and acknowledge quantities received, including discrepancies; associate requests with repairs where applicable. Transferred parts leave the source's available stock on dispatch and enter the destination's only on receipt; in-transit parts cannot be consumed at either store. A part not yet received is not available stock; consumption is recorded against the repair when actually used. Specify permissions, discrepancies, and offline/sync conflict handling so duplicate or conflicting dispatches cannot create stock. Supplier-return handling was settled in a later follow-up below.

**Supplier invoices and payments (owner follow-up, 2026-10-14):** first-release repair-parts purchasing also tracks supplier invoices/bills and payments against them, including partial payments, due dates and outstanding balances per supplier/store. Link invoices to purchase orders and actual receiving so the same goods do not create duplicate payables; record payment amount, method/reference, payer and time with replay-safe accounting entries. Ordering, receipt, invoice, and payment are distinct events: a submitted PO is not a settled bill, and stock receipt must not imply a supplier payment. Specify invoice-versus-receipt matching and discrepancies, advance payments, permissions/approval, offline conflict handling and any due-date reminders before implementation. Do not infer tax compliance or a full standalone accounting suite from this decision.

**Invoice timing (owner follow-up, 2026-10-14):** allow entry of a supplier invoice before any parts arrive. Link it to the purchase order and show what has or has not been received; an early invoice neither creates stock nor marks the order received. Later partial/full receipts reconcile against the existing invoice rather than creating a duplicate bill/payable. Specify the balance and accounting treatment of early invoices, mismatched quantities/prices, multiple invoices per PO, and prepayment reversals before implementation. PRD-003 FR-214's receive-only AP creation is stale input, not authority to prevent early invoice entry.

**Early-invoice visibility (owner follow-up, 2026-10-15):** as soon as a supplier invoice is entered, include its unpaid amount in that store's supplier balance and due-date views, explicitly flagged **awaiting parts** until the associated quantities are received. Keep receipt status, invoice amount and payment status distinct; receiving parts updates receipt status and stock, not a second payable. A pending manager-recorded payment does not reduce the displayed unpaid balance before separate approval. Specify the balanced accounting treatment for invoices preceding goods receipt without conflating the store's visible obligation with on-hand inventory.

**Supplier prepayments (owner follow-up, 2026-10-15):** v1 may record an outside payment against an early supplier invoice before any associated parts are received. The payment reduces that invoice's outstanding balance (or marks it paid), but never creates stock, marks receipt, or represents provider-verified settlement. Keep the invoice visibly flagged **awaiting parts** until receipt is confirmed; retain the payment and invoice linkage if delivery is late, partial, cancelled, or disputed. Apply the same recording, approval, self-approval, audit, duplicate-reference and replay-safety rules as other supplier payments; define reversal/refund and accounting treatment in the finance contract.

**Supplier refunds and credits (owner follow-up, 2026-10-16):** v1 may record an external supplier refund or credit note against a linked invoice, including a refund for a prepayment or a credit for a cancelled/short/incorrect delivery. Recording the adjustment reduces the applicable paid/prepaid amount or payable balance according to the finance contract; it never creates stock. Link adjustments to a physical supplier return when applicable, without making every credit require a shipment. Use the same store-scoped recording permission, manager pending-approval rule, owner self-approval rule, external-reference/evidence, audit, duplicate and replay-safety controls as supplier payments. Refunds/credits remain manually recorded and are not bank/provider-verified; Bolusi does not initiate the bank refund.

**Physical supplier returns (owner follow-up, 2026-10-16):** v1 tracks physical return of defective or incorrect parts to the supplier, not just a refund/credit entry. Record the supplier, originating order/receipt where available, items, quantities, reason, actor, return request/authorization, dispatch and tracking/reference, supplier acknowledgement, and final resolution. Quarantine return-bound parts so they are unavailable for repairs; dispatch and any rejected/short return must produce auditable stock movements without duplicating deductions or silently restoring availability. Keep return status separate from financial credit/refund status; a shipment alone does not prove a refund. Specify partial returns, offline/sync conflicts, authorization, proof and the resolution path before implementation. Tracking the return does not imply a carrier integration or supplier API.

**Return approval (owner follow-up, 2026-10-16):** the source store owner or a manager explicitly granted supplier-return approval for that store may authorize dispatch of parts back to the supplier. A manager cannot approve a return they initiated, even if they hold multiple roles; another authorized manager or the store owner must approve it. The store owner may authorize their own request. Recording the return, approving dispatch, confirming shipment, receiving a replacement and recording a refund/credit are separately permissioned, auditable actions; a supplier-payment approval grant does not also authorize return dispatch. Quarantine prevents use pending resolution, but an unapproved return must not silently leave stock.

**Replacement receipt (owner follow-up, 2026-10-16):** when a supplier resolves a return by sending replacement parts, v1 tracks their receipt into stock **on the same return case**. Record actual received SKU, quantity, condition, receiving store and actor; reconcile partial or differing replacements with what was returned. No incoming stock is recognized for a promised or dispatched replacement until physical receipt is confirmed. A replacement receipt creates one auditable stock movement, not a second purchase-order receipt or duplicate payable; link any credit/refund or price difference separately so stock and supplier balance remain consistent. Keep the return open while replacement quantities or other agreed resolutions remain outstanding. Define exceptions and offline replay/concurrency behavior in the inventory/finance contracts.

**Supplier payment boundary (owner follow-ups, 2026-10-14):** v1 records payments made outside Bolusi (for example by bank transfer or cash); it does **not** initiate transfers or disburse money to suppliers. A store owner or a manager **explicitly granted supplier-payment-recording permission for that store** may record a payment; this does not grant permission to initiate a bank transfer or confer authority at another store. Record the amount, method, external reference/evidence where available, actor and time against the supplier invoice, including partial payments and the remaining balance. A manager's record stays **pending approval**: the store owner or a **different manager explicitly granted supplier-payment-approval permission at that store** must approve it before it reduces the invoice's outstanding balance or posts to the payment ledger. Recording and approval are distinct permissions; the recording manager cannot approve their own record, including via a second role or device. A store owner's own record posts without a second approver, but is still audited. Approval must be replay-safe and must not double-post if retried offline or after sync. Every manually recorded/approved payment remains a staff assertion, not bank/provider-verified settlement; display and audit that distinction. Specify correction/reversal and duplicate-reference handling before authoring the finance contracts.

**User-facing atomic permissions (owner follow-up, 2026-10-16):** the first v1 release must expose a usable role/permission administration flow for all shipped v0 and repair-first v1 modules, not just hard-code manager checks. Keep the existing registered, versioned `<module>.<action>` capability model and per-store/tenant grants (02-permissions); define distinct permissions for meaningful actions and sensitive reads across customer/intake/evidence/printing, repair/QC/warranty, parts orders/receipts/transfers/returns/replacements, supplier invoices/payments/credits, and repair payments/refunds/overrides. In particular, supplier-return approval is separate from creating a return, dispatching it and approving supplier payments. Offer sensible editable role presets and grouped, plain-language Bahasa Indonesia/English permission descriptions, highlighting dangerous grants; show effective access and store scope to the person configuring staff. Permission checks must be enforced by command/query handlers, not merely hidden UI controls, and role/grant changes must be audited and respect anti-escalation, last-admin, data visibility and offline propagation rules. Since 2026-10-26 (owner decision) the server refuses every pushed op whose author lacks the op type's declared permission in the device's store, using the same evaluator as the device; the refused op keeps its chain place so the device keeps syncing, and a deactivated user's unsynced ops are all refused. Per-type business rules and v1 approval policies (separation of duties, limits) still need their own server-side checks before v1 approvals are called secure. Do not invent runtime-defined permission IDs.

**Role governance (owner follow-up, 2026-10-16):** only the main owner can create or edit role definitions (the sets of capabilities and role presets) for the tenant. Store owners may assign/revoke available roles for staff **only within their own stores** and set the already-decided manager approval limits within the main-owner caps; they cannot alter role definitions, grant tenant-wide authority, grant a role exceeding their own effective authority, assign access to another store, or edit main-owner grants. Managers have no role-management or grant-assignment power by default. Show each role's effective permissions and store scope before confirmation; audit who changed each definition and assignment. V0's `auth.role_manage` is tenant-scoped and mixes editing with grants: preserve its shipped ID/semantics, and specify an additional store-scoped assignment capability plus server-enforced scope/subset and last-admin rules for v1 rather than reusing `auth.role_manage` as a store-owner editor. Directory mutations stay online-only; offline devices receive updated roles through bundle refresh.

**Offline high-risk approvals (owner follow-up, 2026-10-16):** authorized staff may make repair, stock-transfer/return and money-related approval decisions while offline, but show them as **provisional** until the server accepts them on sync; never label a local assertion server-accepted or provider-verified. Enforce the local, store-scoped permission and separation-of-duties checks immediately. Locally quarantine or subtract dispatched parts from _available_ stock to prevent reuse; do not expose an unaccepted cross-store receipt as canonical source/destination stock. Show pending, accepted and rejected/conflicted states with an actionable resolution path; a rejected offline action must not silently disappear or double-post stock or money. Role/grant editing stays online-only. Before implementation, specify a tamper-resistant server validation/revocation policy for offline high-risk operations that does not rely on client-supplied timestamps or on the v0 audit-only push behavior; prove forged approvals are rejected or safely held and legitimate offline work is handled explicitly. Physical dispatch under provisional approval is decided below.

**Physical dispatch while offline (owner follow-up, 2026-10-17):** after an authorized provisional offline approval, staff may physically send parts to another store or return them to a supplier before server acceptance. Record the dispatch, actor, destination/supplier, quantities and handover/tracking reference offline; mark the shipment provisional and make those parts unavailable at the source immediately. Pending sync is not evidence that the other store or supplier received them. If validation rejects or conflicts with a shipment that has actually left, preserve its physical-shipment record and surface an owner-visible exception for human reconciliation; do not silently reverse it, restore stock, or fabricate a successful transfer/return. Specify shipment proof, eventual source/destination reconciliation, and replay/concurrency tests before implementation. Whether the destination may record physical receipt offline before source dispatch syncs is a separate decision.

**Store manager across v1 (owner follow-ups, 2026-10-14):** ship a usable store-scoped manager role with the repair-first modules; do not treat it as a transfer-only alias for store owner. The source-store owner **or a manager explicitly granted transfer approval in that source store** may approve/reject cross-store parts requests; the requesting store's manager has no authority over the source's stock just by requesting it. Integrate manager permissions and relevant screens/work queues across repair (including QC and warranty decisions), parts procurement/receiving/transfers, customers, and repair payments/finance. A manager with the relevant permission may approve repair refunds and price overrides **within separately configurable limits**; above those limits require store-owner approval. If a limit is missing or cannot be verified, fail closed to owner approval rather than assume unlimited manager authority. A price change requiring customer confirmation still requires it regardless of staff approval. Define a granular permission and action/visibility matrix per v1 module before implementation, including who may request, approve, dispatch, receive, adjust, refund, and view cost or financial data; do not give managers blanket owner privileges or expose sensitive fields merely because a screen is hidden. Audit actors and approvers separately and verify both offline authorization and synchronized cross-store outcomes. The existing v0 three-role default is unchanged; add the manager and its business-module permissions as v1 contracts land. Set actual limits and self-approval rules before implementation.

**Separation of duties (owner follow-ups, 2026-10-14):** a manager must not approve a repair refund, price override, **or cross-store parts transfer** that the same person initiated, even if the manager has grants at both stores or the amount is within their limit. Require a different authorized approver (another eligible manager at the source store or its store owner). A store owner **may initiate and approve their own** refund or price override within their store scope, without the manager cap; the source-store owner may approve a transfer they requested, provided they have authority at the source store. Do not force a second approver on the store owner. Record requester and approver user IDs and reasons even when they are the same store owner, so self-approval remains auditable. Deny manager self-approval in the command path, including offline and on sync, and cover both manager denial and store-owner allowance with adversarial tests. Approval limits still apply to managers. Customer confirmation of price changes remains a separate requirement.

**Limit governance (owner follow-up, 2026-10-14):** the main owner sets the maximum authority for manager approvals, separately for repair refunds and price overrides; each store owner may set their store's effective manager limits no higher than those caps. Managers cannot raise their own limits. Audit cap and store-limit changes, enforce the lower applicable value in the command path, and route any request above it to the store owner. Missing or unverifiable caps or store limits must not grant managers approval authority. Define actual amounts, units, change propagation and offline approval/revocation behavior in the specs; do not assume a stale local limit can override a reduced central cap.

**Device identification (owner follow-ups, 2026-10-14):** searchable model/specification lookup is in the first v1 release. Pursue GSMArena through an authorized commercial arrangement, but its availability does **not** block launch: if access cannot be arranged, use another approved source with rights covering the planned lookup, display, offline caching, attribution, and retention. Do not assume GSMArena offers a public API; do not scrape, bulk-import, or repackage its data without permission, including via an unlicensed third-party proxy. The lookup source is replaceable; explicitly identify the chosen source and verify its terms before implementation. Manual device entry remains fully functional offline and lookup failure never blocks intake.

Paper printing is mandatory in v1. Repair orders use a full-page A4/A5 layout with customer and store copies, not the narrow thermal POS receipt layout. Support ordinary document printers and a tested path for preprinted, carbonless multipart forms (the owner's red/yellow copy example). The owner identified multipart forms provisionally; confirm actual forms, printer models, printable area, connection, and Android/iOS behaviour before promising broad compatibility. Preserve the repair transaction if printing fails and allow retry. The shared printing boundary must remain reusable for later POS thermal receipts.

Repair types requiring ownership video are in scope. Extend the v0 photo/signature media pipeline for bounded, offline video capture, durable upload/retry, and low-end-device/storage/bandwidth verification. Never treat a photo as satisfying a required video. The video limits and supported repair-type evidence policy require specification before implementation.

The repair payment journey supports deposits, split payments, and the remaining balance with distinct methods and verification states:

- Cash, existing/manual QRIS, and card payments made on a shop's existing EDC terminal are recorded with amount, method, attribution, and any external reference; these do **not** become provider-verified automatically.
- Integrated transaction-specific QRIS is in v1: a selected provider creates the QR; a verified provider result, not QR generation or the cashier's assertion, establishes provider-confirmed payment. A store may offer this alongside its existing QRIS arrangement.
- Stores may choose existing QRIS accounts or an integrated provider, with central or per-store settlement where the selected provider's merchant-account arrangement actually permits it. Supporting customers' BCA/Mandiri QRIS apps does not imply direct API access to each bank's existing merchant account. Do not claim automatic reconciliation of manual QRIS.
- Direct Bolusi-to-EDC terminal control/result integration is **not** required for the first release. It is a candidate for v1.1 after selecting bank/provider and supported hardware; manually recorded EDC payments remain in v1.

## Why / rejected alternatives

The owner chose an actual repair business outcome rather than stock control alone, a retail-sale-first sequence, or intake without pickup/payment. A full repair journey needs genuine stock, customer, payment, evidence, and printing seams, but does not require shipping a standalone retail checkout first. Automatically treating an externally paid QRIS/EDC transaction as provider-confirmed would substitute a cashier claim for a provider result. Promising universal printer or existing-bank API compatibility without real hardware/merchant access would create a false acceptance gate.

## Parts and stock (2026-10-28)

Agreed with the owner, as the first part of parts, purchasing and stock.

- **One parts list for the business** (the inventory module), built for
  thousands of parts. Stock is per store. Owners add parts and correct stock
  ("Koreksi stok", owners only); starting stock comes from a correction. The
  phones a part fits are picked from the phone catalog, as at intake, and the
  take step offers the parts that fit the servisan's phone first.
- **Taking a part drops stock; putting it back returns it.** Technicians take
  parts for their own servisan, and the counter (who assigns work) can take for
  any servisan. There is no storekeeper.
- **No cheating the shelf:** parts move only for a servisan being worked on
  (Dikerjakan or Tunggu sparepart, in the store); every take records who and when; only what a
  servisan took can go back; once it is repaired, cancelled or handed back only
  an owner corrects its parts. A cancelled servisan shows parts not yet back.
- **Customers never see part prices:** parts are not bill lines, and taking a
  part never changes the price.
- **Offline first:** two phones may take the last part; stock goes below zero
  and the owner sees it under "Stok minus" instead of the repair being blocked.
  A count is the shelf at the moment it was made (by the phone's clock): a take
  made after it still comes off when it syncs, one made before is already in the
  count, and of two counts the later one stands.
- **Next, in order:** supplier orders and receiving, supplier invoices and
  payments (on the shared money ledger), transfers between stores, supplier
  returns, stock counts across many parts (a fast table on the PC). Part costs
  will be seen only by owners and whoever records purchases; a sell price per
  store waits for the shop POS.

## Open product choices

- Reconfirm PRD-001 and dependent PRDs against this milestone: supplier ordering/receiving, physical returns and invoice/payment reconciliation (including partial receipts/payments and repair linkage), cross-store sourcing authorization, the user-facing v1 permission/grant matrix and server/offline enforcement of high-risk approvals, manager refund/price-override caps and per-store limits, customer identity, payment ledger/refunds and split rules, warranty, cross-store reporting, and what remains out of scope. Preserve iOS parity (D17/D18) or explicitly decide any exception.
- Choose and verify a QRIS integration provider, onboarding and merchant-account model, fees/settlement and verification/reconciliation semantics; test both central and per-store account needs. No provider (including Midtrans) is selected here.
- Inspect representative ordinary printers and carbonless forms, then define supported hardware, layouts, failure/retry and offline acceptance. Confirm video duration/compression/retention and low-end-device budget.

Changing the roadmap does not establish physical-device performance; see
[architecture](architecture.md) for current limits. Resolve relevant open choices
and record a concise agreement as each repair slice is selected. The former
phase/task workflow is retired.

## Deferred and excluded scope

Agent mode is deferred to V2; payroll and tax/e-Faktur/PPN remain separate later
scope decisions. Attendance, wholesale delivery, continuous GPS, chat, full
reporting, desktop and standalone retail POS also remain later scope discussions.
Their ideas and milestone context are retained in [product direction](product-direction.md).

Vouchers/store credit/loyalty points, voice input/messages, delivery of repaired
phones, facial recognition/behavioral analysis and custom BI/query builders remain
explicitly excluded unless the owner revisits them. They are not simply queued
for the next release. Android/iOS parity remains part of the direction.
