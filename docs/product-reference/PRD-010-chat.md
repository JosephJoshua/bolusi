# PRD-010: Chat & Communication

> **Earlier product proposal — discussion reference, not approved implementation scope.**
> Preserved from `ai-docs/PRD-010-chat.md` at `06b063b`, with the generated
> task breakdown removed. Read [product direction](../product-direction.md) and
> [current repair scope](../product-scope.md) first. Later owner decisions override
> this text. Historical “Must”, “V1”, deadlines, technical designs, metrics and
> open questions are proposals to revalidate, not instructions to execute or
> claims about implemented behavior. Read only the relevant sections when scoping
> this feature; see the [reference guide](README.md) for known superseded ideas.

## 1. Overview

### Problem Statement

Staff coordinate over WhatsApp today. That works — it works well enough that it is worth asking honestly whether replacing it is a good idea at all.

The case for building chat into the ERP is not that WhatsApp is bad at messaging. It is that WhatsApp conversations are disconnected from the things they are about. A technician asking "is the LCD for the iPhone 15 in stock?" is asking a question the system can already answer. A store owner asking "what happened with ticket #4471?" is asking about a record that exists. The conversation and the data live in separate worlds, and the human is the integration layer.

The value of in-app chat is **context**: a message thread attached to a repair ticket, a group that automatically contains the right people, a question that can be answered by tapping through to the record.

### A caution worth stating plainly

**This module is last on Ocep's priority list, and that is the correct call.** Staff already have a working communication tool that they know, that runs on 2G, that survives a dead app, and that they use socially as well as professionally. Replacing it is a hard sell, and a half-built chat that people abandon back to WhatsApp is worse than no chat — it fragments the record.

The design should therefore aim narrowly: **be better than WhatsApp at the things WhatsApp cannot do**, and do not try to beat WhatsApp at being WhatsApp.

### Scope

**Internal only.** Employees. Customers do not participate — customer communication happens over WhatsApp via generated links (PRD-001 §3.10).

### Goals

- Attach conversation to the records it concerns
- Assemble groups automatically from the organisation's structure, rather than by hand
- Retain the record permanently and searchably
- Work offline, queuing messages for send
- Deliver push notifications

### Non-Goals

- Voice messages. No voice anywhere in the platform, per Ocep.
- Customer-facing chat.
- Video, calls, or anything approaching a full messaging platform.
- Being a WhatsApp replacement for social chatter. It won't be, and pretending otherwise leads to building features nobody uses.

---

## 2. User Stories

- **US-801** [P1]: Sebagai teknisi, saya ingin bertanya di dalam tiket servis, sehingga percakapan langsung terkait dengan pekerjaannya dan tidak hilang di WhatsApp.
  _(As a technician, I want to ask a question inside the repair ticket, so the conversation is tied to the work and doesn't get lost in WhatsApp.)_

- **US-802** [P1]: Sebagai pemilik toko, saya ingin mengirim pesan ke semua staf toko saya sekaligus, sehingga pengumuman sampai ke semua orang.
  _(As a store owner, I want to message all my store staff at once, so announcements reach everyone.)_

- **US-803** [P1]: Sebagai pemilik utama, saya ingin mengirim pesan ke semua pemilik toko, sehingga saya bisa berkoordinasi lintas toko.
  _(As the main owner, I want to message all store owners, so I can coordinate across stores.)_

- **US-804** [P2]: Sebagai staf, saya ingin mengirim foto dalam percakapan, sehingga saya bisa menunjukkan masalah alih-alih menjelaskannya.
  _(As staff, I want to send a photo in a conversation, so I can show a problem rather than describe it.)_

- **US-805** [P2]: Sebagai pemilik toko, saya ingin membuat polling sederhana, sehingga saya bisa mengumpulkan keputusan tim dengan cepat.
  _(As a store owner, I want to create a simple poll, so I can gather a team decision quickly.)_

- **US-806** [P1]: Sebagai staf, saya ingin mencari pesan lama, sehingga saya bisa menemukan kembali keputusan yang pernah dibuat.
  _(As staff, I want to search old messages, so I can find a decision that was made before.)_

- **US-807** [P1]: Sebagai staf, saya ingin menulis pesan saat offline dan terkirim otomatis saat online, sehingga saya tidak kehilangan pesan.
  _(As staff, I want to write a message while offline and have it send automatically when online, so I don't lose it.)_

---

## 3. Functional Requirements

### 3.1 Groups — Membership by Provider

This is the design decision that matters in this module. Ocep specifically asked that group types not be a fixed enum of strings but an extensible mechanism.

- **FR-901** [Must]: A group's membership shall be determined by a **membership provider** — a rule that resolves to a set of users — rather than by a hardcoded type or a manually maintained list.
- **FR-902** [Must]: The following providers shall exist at launch:
  - **Store** — everyone assigned to a given store
  - **Role** — everyone holding a given role, optionally scoped to a store (e.g. all technicians at Toko Jayapura; all store owners network-wide)
  - **Repair** — the people attached to a given repair ticket: the intaking cashier, the assigned technician, the store manager
  - **Custom** — an explicit, manually maintained list of users
- **FR-903** [Must]: Adding a new provider shall not require modifying existing groups, messages, or the chat core. A provider is a rule that answers one question: _given this scope, who is in it?_
- **FR-904** [Must]: Provider-derived membership shall be **live**. A technician who joins Toko Sorong is in the Toko Sorong group from that moment. A technician who leaves is out. Membership is not a snapshot taken at group creation.
- **FR-905** [Must]: When membership changes, the departing member shall retain access to messages sent while they were a member, and shall not gain access to messages sent after. History is not retroactively opened or closed.
- **FR-906** [Should]: Provider-derived groups shall be created automatically. A store does not need someone to remember to make a group for it.
- **FR-907** [Should]: A group shall display how its membership is derived, so a user knows why they are in it and who else can read what they write.

**Why this matters beyond elegance:** the alternative — manually maintained groups — rots. Someone leaves the company and stays in the group for a year. A new hire is never added and misses everything. In a franchise scaling to a hundred stores with staff turnover, hand-maintained membership lists are a guarantee of both leaks and gaps.

### 3.2 Messages

- **FR-908** [Must]: A message shall support text.
- **FR-909** [Should]: A message shall support images.
- **FR-910** [Should]: A message shall support a poll: a question and a set of options, with per-user single or multiple selection, and visible results.
- **FR-911** [Won't]: No voice messages. No video. No file attachments beyond images in V1.
- **FR-912** [Must]: Messages shall be attributed to a user — not to a device, not to a generic account.
- **FR-913** [Should]: A message shall support a reply-to reference, threading a response to a specific prior message. In a busy group, an unthreaded reply to a message from twenty messages ago is unreadable.
- **FR-914** [Must]: Messages shall be retained permanently. Ocep was explicit: forever.
- **FR-915** [Must]: A message, once sent, shall not be editable. It may be deleted — which marks it deleted and hides its content, but does not erase the fact that a message existed and who sent it. A chat log that can be silently rewritten is not a record.

### 3.3 Context Attachment

This is the module's reason to exist and should not be an afterthought.

- **FR-916** [Must]: A repair group shall be reachable from its repair ticket, and the ticket reachable from the group.
- **FR-917** [Should]: A message shall be able to reference a record — a repair ticket, a product, a purchase order, a delivery — as a link that renders as a card and taps through to the record.
- **FR-918** [Should]: Creating a repair ticket shall create its group lazily — on first message, not on ticket creation. Most repairs generate no conversation, and pre-creating thousands of empty groups is noise.

### 3.4 Offline

- **FR-919** [Must]: Messages composed offline shall queue and send automatically on reconnect.
- **FR-920** [Must]: A queued message shall be visibly marked as pending, and shall be distinguishable from a sent one. A user who thinks they have told the store something, and has not, is worse off than one who knows the message is waiting.
- **FR-921** [Must]: Message history shall be readable offline from local storage.
- **FR-922] [Must]: Ordering shall be stable. Messages composed offline by several people and synced later must not shuffle on every device's screen as they arrive.

### 3.5 Notifications

- **FR-923** [Must]: Push notifications on new messages.
- **FR-924** [Must]: Notifications shall be mutable per group. A store group that fires for every message will be muted within a week, and then the announcements will not be read either.
- **FR-925** [Should]: A mention (@user) shall notify even in a muted group.
- **FR-926** [Should]: Notification preferences shall be per user, not per device.

### 3.6 Search

- **FR-927** [Should]: Message search across groups the user is a member of.
- **FR-928** [Must]: Search shall not return messages from groups the user cannot read, or from periods before they joined.

### 3.7 Permissions

- **FR-929** [Must]: A user shall read only groups they are a member of.
- **FR-930** [Must]: A store owner shall not see another store's groups.
- **FR-931** [Should]: The main owner shall be able to read all groups within the tenant, for audit. This shall be visible in the group — covert reading of employee conversations is a bad idea in a small business and a legal problem in a large one.
- **FR-932** [Must]: Group creation and custom-group membership management shall be permission-gated.

---

## 4. Non-Functional Requirements

- **NFR-901**: Message delivery latency under a second when online. Chat that lags is chat that gets abandoned.
- **NFR-902**: Full offline read and compose. Send queues.
- **NFR-903**: History is retained forever, but not loaded eagerly. A group with three years of messages must open instantly on a 2GB device.
- **NFR-904**: Images compressed aggressively. This is a photo of a cracked screen for a colleague, not evidence.
- **NFR-905**: Realtime transport must degrade gracefully — reconnect, backfill, and never lose a message because a socket dropped on a 3G handover.
- **NFR-906**: Indonesian and English.

---

## 5. Data Entities (Conceptual)

### Group

- `id`
- `tenantId`
- `name` — Derived for provider groups, explicit for custom
- `providerType` — store | role | repair | custom | _(extensible)_
- `providerScope` — The parameter the provider resolves against: a store ID, a role ID, a repair ticket ID, or null for custom
- `explicitMembers` — Only for custom groups
- `createdBy`, `createdAt`
- `isArchived`

### Message

- `id`
- `groupId`
- `senderId`
- `type` — text | image | poll
- `body` — Text content
- `mediaRef` — For images
- `poll` — { question, options, allowMultiple, votes: [{userId, optionIds}] }
- `replyToId`
- `recordRefs` — Referenced records (repair, product, PO, delivery)
- `sentAt` — When composed, not when synced
- `deliveredAt`
- `isDeleted`, `deletedBy`, `deletedAt`

### GroupMembershipView (Projection)

Resolved from the provider, not stored as a list:

- `groupId`
- `userId`
- `joinedAt` — When the provider first resolved them into it
- `leftAt` — When it stopped, if it has

Used to enforce FR-905: what a user may read is bounded by the window in which they were a member.

### NotificationPreference

- `userId`
- `groupId`
- `muted`
- `mentionsOverrideMute`

---

## 6. UI/UX Flows

### 6.1 The Group List

A list of groups with unread counts. Provider-derived groups at the top (your store, your role), custom groups below, repair threads below that.

Nothing clever. People know what a chat list looks like, and inventing a new idiom for one of the lowest-priority modules in the product would be a poor use of everyone's attention.

### 6.2 A Conversation

Standard. Messages, sender, time. Pending messages visibly pending. Reply-to renders as a quoted stub above the reply.

The one non-standard element: a message that references a record renders as a **card** — the repair ticket with its status, the product with its stock — and tapping it goes there. This is the whole point of the module and it should be prominent rather than buried in a link.

### 6.3 Repair Thread

Reachable from the repair ticket. The ticket's key facts sit pinned at the top of the thread — device, status, technician — so a person arriving in the conversation does not have to go and look them up.

This is the flow most likely to actually get used, because it is the one WhatsApp genuinely cannot do.

### 6.4 Poll

Question, options, tap to vote, results visible inline. A poll is a message, not a screen.

### 6.5 What Not To Build

Stated because the temptation will be there:

- No reactions, stickers, GIFs
- No typing indicators
- No read receipts (they invite a management culture of "you read it and didn't reply")
- No status/presence
- No archiving, pinning, starring — until someone asks

Every one of these is a day of work and none of them is why anyone would move off WhatsApp.

---

## 7. Edge Cases & Error States

- **A user is removed from a store mid-conversation.** They keep what they could already read, lose the group going forward. They do not get a notification about their removal from within the chat — that is an HR event, not a chat event.
- **A user is added to a store.** They see the group and its history _from their join date_. They do not get three years of other people's messages, and equally they are not left in the dark about a group that exists.
- **Two people message offline simultaneously.** Both arrive with their composed timestamps. Ordering by composed time is right, and it means a message can appear _above_ one already on screen. Handle it without the list jumping.
- **A device has been offline for three days and its clock is wrong.** Composed timestamps are what the device believed. If the device clock is badly off, messages will land in the wrong place in history. Detect gross clock skew (PRD-009 FR-830) and mark such messages rather than silently misplacing them.
- **A repair group whose repair is completed.** The thread stays. The repair is closed; the conversation about it is still a record.
- **A group with no members** (e.g. a store with no staff assigned). It exists and is empty. Not an error.
- **The main owner reads a store's private group.** Visible in the group (FR-931). If the business wants covert monitoring, that is a decision they should have to make explicitly and defend, not one that happens by default because nobody thought about it.

---

## 8. Interactions With Other Modules

| Concern                             | Owned by                  |
| ----------------------------------- | ------------------------- |
| Who is in a store, who holds a role | Auth / HR                 |
| The repair a thread is attached to  | Repair (PRD-001)          |
| Records rendered as cards           | The owning module         |
| Push notification delivery          | Platform Core             |
| Realtime transport                  | Platform Core             |
| @agent participation in groups      | Agent (PRD-004 §3.1) — V2 |

Chat owns: groups, membership providers, messages, and the reading of them.

---

## 9. Open Questions

- **OQ-901**: Is chat actually wanted, or is it on the list because an ERP is supposed to have one? Worth asking the staff before building it. If they will keep using WhatsApp regardless, the repair-thread feature alone might be the entire justified scope.
- **OQ-902**: Should the main owner's ability to read all groups exist at all? It is defensible for audit and indefensible as routine management. If it exists, FR-931 (visible in the group) is the minimum guardrail.
- **OQ-903**: "Region" was in the original group-type list. Do regions exist as a real organisational unit, or was that speculative? If stores are not grouped into regions anywhere else in the system, there is no region provider to build.
- **OQ-904**: Are polls actually used, or were they an idea? They are cheap, but they are not free.
- **OQ-905**: Retention "forever" is simple to say. At a hundred stores over five years it is a lot of rows and a lot of images. Confirm forever means forever, and budget for it.

---
