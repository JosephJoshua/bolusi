# Design guide

How Bolusi screens should look, read and behave. It collects the owner's
feedback on the repair screens (2026-10-25/26) and the general rules behind it,
backed by established guidance (references at the end). The redesigned repair
phone screens in PR #19 are the **minimum** bar: new work matches or beats them.

Tokens live in `packages/ui/src/tokens.ts`; components in `packages/ui`. Use
them instead of one-off values.

## 1. Who we design for

- Counter staff and technicians on cheap Android phones or a Windows counter PC,
  often with a customer standing in front of them. They are not technical.
- Owners on a phone or desktop who want to see everything at a glance.
- So: fast to scan, hard to make mistakes, works offline, readable at arm's
  length, one-handed on a phone. Every role can do its whole job on a phone
  only or a computer only.

## 2. Hierarchy: one thing leads

The owner's first complaint was "looks cheap". Almost always this was weak or
competing hierarchy, not missing decoration.

- **One primary action per screen**, filled, in the fixed bottom bar. Everything
  else is visibly quieter.
- **Action levels:** primary (filled `Button`), secondary (outlined `Button`,
  `size="compact"` inside content), tertiary (`TextButton`, coloured text).
  Never style two different importance levels alike, and never put two
  different levels side by side as if they were alternatives.
- **Choices that answer one question are equals.** A yes/no ("Pelanggan setuju
  dengan harga ini?") is a question above two same-size buttons, "no"
  outlined and "yes" filled (`FlowScreen` `question` + `secondary`). A rare or
  risky escape ("Pakai tanpa konfirmasi pelanggan") is a `TextButton` in the
  body, away from the answers.
- **Destructive actions** are danger `TextButton`s placed apart at the end
  ("Batalkan servisan"), then confirmed in `ConfirmSheet`. They are never a
  solid red block that looks like the next step.
- **Emphasise with weight and colour before size.** Muted text (`textMuted`)
  for metadata, bold for the thing the eye should land on. Saturated colour is
  only for actions, links, status and warnings.
- **The number that matters is big.** A price being decided is `type.title`
  with tabular figures; a total gets a divider above it.
- **Squint test:** blur the screenshot. The title, the key fact and the primary
  action should still stand out, in that order.

## 3. Scale: a ladder, not a pile

Use the type scale and nothing in between: display 32, title 24, heading 20,
body 18, bodySm 16, caption 14. Limit a component to 2 or 3 sizes.

- Screen title in the header, entity name (customer) `title`, section titles
  `bodyBold`, values `bodySm` 600, labels `caption` muted.
- Controls are sized to their importance. Filters, segmented controls and
  in-content buttons are compact (36 dp drawn, 48 dp hit area via hitSlop).
  The status filter once took a quarter of the board; filters stay one row.
- Photos are thumbnails in one scrolling `PhotoStrip` with "Lihat semua (n)",
  not grids that eat the screen. Tap opens `PhotoViewer` (zoom, swipe, share).
- Avatars and icons sit inside their bar with padding (36 dp disc), never
  touching its edges.

## 4. Alignment and spacing

- Everything snaps to the spacing scale (xs 4, sm 8, md 12, lg 16, xl 24,
  2xl 32, 3xl 48). Screen gutter is `space.lg`.
- One left edge per column. Text links that sit under content align their text
  with that edge (offset the `TextButton` padding), not with their hit box.
- Label left, control right on the same row (condition checks); controls in a
  list line up on one right edge, with real room (`space.md`) above and below
  each row's divider. When the control does not fit beside its label (narrow
  phone, large font), every row stacks the same way, label on top and the
  control under it. Never squeeze a control to make it fit.
- Amounts are right-aligned and top-aligned with their description.
- Related things close, unrelated things far: section gap `space.xl`, items in
  a group `space.sm` to `space.md`.
- Group with background (`surfaceAlt` box, card) or spacing before reaching for
  borders. Dividers are hairlines.
- Rows in a list are edge to edge, with no chevrons when the whole row is
  tappable.
- Nothing touches. Every label sits `space.xs` above its field, fields in a
  group are `space.md` apart, groups and sections `space.xl` apart, and the
  primary action lives in the fixed bottom bar, never glued under the last
  field. Forms are steps with a `StepHeader` title, like intake (the first
  device-setup screens broke all of this and read as unfinished).
- The keyboard opens only when someone taps a field. A step never focuses a
  field on its own (it covered "Lanjut" on intake); `autoFocus` is only for a
  field that appears because the person just asked to type (Tambah, Ubah biaya).

## 5. No redundancy

- No label that repeats the placeholder or the obvious ("Cari" above a search
  field that says "Cari nama, nomor, IMEI…").
- No restating the screen title in the body, no "Status:" before a status chip.
- Contextual actions sit beside the fact they change ("Ganti" next to the
  technician, "Ubah harga" in the price header). The visible label can be
  short when the full meaning is in its `accessibilityLabel`.
- Show empty sections only when the emptiness is information; otherwise hide
  them.

## 6. Use real, modern components

Prefer a proper component over a hand-made approximation. Already built:
`SearchField`, `SegmentedControl` (compact, bleed), `TextButton`, `Timeline`
(history, "Riwayat"), `PhotoStrip`, `Sheet` (bottom sheet to show more, never a
form), `PhotoViewer` (pinch and double-tap zoom, pager, share), `ConfirmSheet`,
`Chip`/`StatusChip`, `FactGrid`/`Fact`, `Banner`, `EmptyState`,
`ReorderableList` (drag a handle to reorder, iOS style), `SwitchRow` (an on/off
setting).

- When a screen needs something these do not cover, build a reusable
  component in `packages/ui` (with a gallery entry), not a screen-local hack.
- Flows, not modals or CRUD: each task is a full-screen step with a back arrow
  and one bottom action. Capture is guided (photo walk with angle labels).
- Desktop and admin screens: enterprise-grade tables with sorting, filtering,
  column control, drag where it helps, and Excel-like inline bulk editing.
- No paid component libraries.

## 7. States are part of the design

Every screen ships loading (skeleton for lists, not spinners), empty, error and
offline or stale states, plus the success feedback after an action ("Servisan
mulai dikerjakan."). A refused action shows a banner in the fixed slot, never
only at the top of a scrolled page. Sync state is a quiet chip, not an alarm.

## 8. Indonesian copy

Write like Gojek or Tokopedia product copy: short, everyday, friendly, exact.

- Address the user as "kamu". Name the customer "pelanggan", the device "HP".
- A repair order is a **servisan** (noun); "servis" is the verb. Others:
  teknisi, sparepart, jasa, keluhan, kelengkapan, estimasi selesai.
- Say what happened or what to do, in plain words: "Belum dikonfirmasi
  pelanggan: Rp 180.000", not "Usulan belum diputuskan". Prefer
  "konfirmasi", "ajukan", "diajukan teknisi", "ditolak pelanggan".
- Buttons are verbs or direct answers: "Ambil servisan ini", "Serahkan HP",
  "Setuju" / "Tidak setuju". No "OK", no "Submit", no "Proses".
- Validation tells the next step, ending in "dulu" where natural: "Tulis
  alasannya dulu." Errors say what failed and what to try: "Fotonya belum bisa
  disimpan. Coba lagi nanti."
- Consequences are stated before irreversible steps: "Servisan dihentikan dan
  biaya perbaikan tidak ditagih."
- No translated-English structure ("Apakah Anda yakin…", passive bureaucratic
  phrases), no jargon from the code (op, entity, sync conflict).
- Read every string aloud as a counter person would say it to a customer. If
  it sounds like a form, rewrite it.
- **Short, and said once.** Be clear in one short sentence, not a paragraph.
  Never say again what the title, a label or the button on the same screen
  already says ("Daftarkan HP ini" as both title and button; "Terdaftar" in the
  title and the line under it). A lead line that only restates the title goes.

## 9. Accessibility floor

48 dp touch targets, 4.5:1 text contrast (3:1 for borders and large text),
labels on every control (including icon-only and shortened ones), no meaning
carried by colour alone (chips have icons), text scales without clipping.

**Labels never truncate or clip.** A button, pill, chip, tab, title or
choice shows its whole text at every supported width and font size. The
Android run showed "Tidak" for "Tidak dicek"; that is a defect, not a style.
When text does not fit, change the layout (wrap, stack the label above its
control, share the width equally), or shorten the copy so it still reads
naturally. Never rely on `numberOfLines` to hide the overflow. The only
ellipsis allowed is a long user-entered value in a list row (a customer
name), whose full text is one tap away.

**Values never split mid-phrase.** A money amount, a date or a name stays on
one line ("Rp" and "50.000" together). Let the label beside it wrap instead
(`repairStyles.rowText`), or give the value its own line.

Supported range: 360 dp wide phones and the system font up to 1.3×.

## 10. Review before showing anyone

Run the app, take screenshots of every changed screen and state, and check:

1. Squint test: does the right thing lead? Is there exactly one primary?
2. Is every size on the type ladder, every gap on the spacing scale?
3. Do edges line up? Any control wrapped under its label?
4. At 360 dp and at the system font at 1.3×: any label cut off, clipped or
   ellipsized? Anything touching with no space between?
5. Any redundant label, chevron, title, or full-width secondary button?
6. Are paired choices equal, and risky or destructive ones set apart?
7. Does each Indonesian string sound natural spoken aloud? Is it short, and
   is nothing on the screen said twice?
8. Loading, empty, error, offline and success states all present?
9. Would this look at home next to Gojek, Tokopedia or a good banking app?

Share the screenshots with the owner along with what was verified on a real
device vs only in the browser.

## References

When unsure, look at how mature products solve the same problem (order
detail, approvals, timelines, photo capture) rather than at concept shots.
Dribbble is good for visual ideas but shows unusable concepts too; check
patterns against shipped apps.

- Refactoring UI (Wathan, Schoger): hierarchy through weight and colour,
  spacing scales, one primary button, fewer borders.
- Material Design 3 and Apple Human Interface Guidelines: button emphasis
  levels, bottom sheets, touch targets.
- Gojek Asphalt Aloha principles (consistency, usability, accessibility,
  aesthetics): https://asphalt.gojek.io/pages/principles.html
- Button hierarchy and placement:
  https://cieden.com/book/atoms/button/how-to-create-button-hierarchy
- Laws of UX (Hick, Fitts, Miller, proximity): one task per screen, primary
  within thumb reach, chunked content.
- Shipped Indonesian apps for copy and patterns: Gojek, Tokopedia, Grab,
  Traveloka, BCA mobile.
