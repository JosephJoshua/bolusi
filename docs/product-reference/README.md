# Earlier product discussions

These twelve references preserve the original product ideas and detailed
questions so a new Claude Project can continue the conversation. Read
[product direction](../product-direction.md) for the overview and milestones,
and [repair scope](../product-scope.md) for the latest detailed release decisions.
The module table in product direction links to every reference.

The PRDs were recovered from `06b063b`. Their product/design sections are retained;
their generated Claude Code task breakdowns are removed. Old requirement IDs
remain solely to make historical cross-references understandable. They do not
restore a task ledger, test inventory, mandatory architecture or execution order.
Read relevant sections for the scope under discussion, not this entire directory
at the start of every thread.

## Interpret older proposals correctly

- “Must”, “V1”, targets and estimates describe the earlier proposal. They neither
  authorize implementation nor prove owner approval of each detail.
- October's complete repair-first release supersedes older all-modules-in-V1 or
  inventory/finance/retail-first assumptions. Attendance, delivery, GPS, chat,
  standalone POS and full reporting remain later scope discussions.
- October decisions govern parts purchasing/returns, invoice timing, supplier
  payments/credits, cross-store approvals, permission administration and required
  video. Reconcile older simplified flows against those decisions before coding.
- Device-model lookup needs an authorized, validated source; GSMArena is preferred,
  not mandatory. Manual entry must work offline. Integrated QRIS is in the chosen
  repair release; no provider is selected. Manual EDC recording and direct terminal
  integration are different scopes.
- Android and iOS are both first-class targets. A dated Android-only assumption,
  SaaS “in six months”, provider/model recommendation or performance target is not
  a current commitment. SaaS has no fixed launch date.
- Historical payroll/tax research needs fresh verification if selected. No old
  rates, legal claims or vendor prices should become implementation constants.
- Agent mode is an eventual Bolusi feature, not the Claude development workflow.
  Its architecture sketches and “what we must do now” section are historical
  design rationale, not permission to add speculative framework work.
- Explicit exclusions in product direction still apply. An old open question
  suggesting voice or behavioral analysis does not reopen them automatically.
- Data entities, state machines, security claims and code examples are proposed
  designs. Compare them with current code and current decisions before relying
  on them; old “tamper-proof” wording does not establish such a guarantee.
- Some open questions were answered later. Check current decisions and code before
  asking them again. Other references to ARCH-001 or old numbered specifications
  can be recovered from Git for a specific historical question.

When a scope is chosen, use these ideas to ask better questions and record the
resulting current agreement. Do not turn the old documents back into an automatic
implementation backlog.
