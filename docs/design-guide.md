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
- **Offer the next step, not every transition.** A record shows the one step
  this person takes next for where it stands, at most one real alternative
  ("Tunggu sparepart" while working), and the rarer moves under "Lainnya".
  A row of every status change is CRUD thinking (`arrangeTicketActions`).
  Corrections to a finished record (money back on a settled bill, a part taken
  after pickup) also wait under "Lainnya".
- Status data leads with "Tandai sudah dicek" when changes were refused and with
  "Kirim sekarang" only when work waits; otherwise sending is a quiet link (`syncLead`).
  Refusal codes are for support, behind "Lihat detail untuk laporan".
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
- The counter PC app (`packages/ui-web`) is read closer and denser, so its
  ladder is a step smaller: display 28, title 22, heading 17, body 15, small 14.
  The 14 floor is the same. Mouse-first controls are 32 to 40 px tall; tables,
  not cards, carry lists.
- The PC window goes down to 1024 × 520 (a small laptop at 125% scaling) and
  nothing is cut off there: tabs and filters wrap to a second row instead of
  scrolling sideways out of a mouse's reach, and an open servisan sits beside
  the table, which folds to number, customer and status, never over it.

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

### Phones and tablets

- Lay out by the room on screen (`useViewport().widthClass`: compact under
  600 dp, medium, expanded from 840 dp), never by device type. Phones are
  locked upright; tablets turn.
- `AppShell` keeps content and the bottom action in one centred column of at
  most `size.contentMax`; sheets rise at the same width. Never stretch a form,
  a button or a line of text across a tablet.
- A list with a detail (the servisan board) shows both side by side when
  expanded; a task from start to finish (intake) keeps the whole screen.
  Exactly one filled primary across both panes.
- Check every changed screen at 360 x 640, 800 x 1280, 960 x 600 and
  1280 x 800, and at 1.3x font. A short landscape tablet is the tightest case:
  put things side by side rather than making the person scroll to a key.

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
(history, "Riwayat"), `PhotoStrip`, `ChipRow` (choice chips that scroll sideways; an edge with more to swipe to fades), `Sheet` (bottom sheet to show more, never a
form), `PhotoViewer` (pinch and double-tap zoom, pager, share), `ConfirmSheet`,
`Chip`/`StatusChip`, `FactGrid`/`Fact`, `Banner`, `EmptyState`,
`ReorderableList` (drag a handle to reorder, iOS style), `SwitchRow` (an on/off
setting).

- When a screen needs something these do not cover, build a reusable
  component in `packages/ui` (with a gallery entry), not a screen-local hack.
- Flows, not modals or CRUD: each task is a full-screen step with a back arrow
  and one bottom action. Capture is guided (photo walk with angle labels).
- Design every input for the on-screen keyboard, which covers about half a phone
  screen. Put fields inside `AppShell` (it lifts the content and bottom action
  above the keyboard and scrolls the focused field into sight); a field whose
  suggestions open below it uses `revealOnFocus="to-top"` and comes first on its
  step; picking a suggestion closes the keyboard. Check a screenshot at a
  keyboard-up height (about 390 x 520).
- Design for the realistic amount, not the demo's three items: owner-edited
  lists, catalog data and records grow. Choice chips from such a list sit in one
  `ChipRow` that scrolls sideways instead of wrapping down the screen; long lists
  get search or paging; tables keep their header and scroll. Try each screen
  with 20+ options, long names and an empty list.
- Desktop and admin screens: enterprise-grade tables with sorting, filtering,
  column control, drag where it helps, and Excel-like inline bulk editing.
- No paid component libraries.

## 7. States are part of the design

Every screen ships loading (skeleton for lists, not spinners), empty, error and
offline or stale states. A new device still on its first sync shows loading rows,
never "Belum ada …" (`List` and `DataTable` read `setDataArriving`). Every
action shows its success feedback ("Servisan mulai dikerjakan."). A refused action shows a banner in the fixed slot, never
only at the top of a scrolled page. Refused changes on the record you are looking
at show the same strip at the top of the page (`AppShell` `pageBanner`), so it
scrolls away instead of covering rows at a large font. Sync state is a quiet chip, not an alarm.

## 8. Indonesian copy

Write like Gojek or Tokopedia product copy: short, everyday, friendly, exact.

- Address the user as "kamu". Name the customer "pelanggan", the device "HP".
- A repair order is a **servisan** (noun); "servis" is the verb. Others:
  teknisi, sparepart, jasa, keluhan, kelengkapan, estimasi selesai.
- Say what happened or what to do, in plain words: "Belum dikonfirmasi
  pelanggan: Rp 180.000", not "Usulan belum diputuskan". Prefer
  "konfirmasi", "ajukan", "diajukan teknisi", "ditolak pelanggan".
- Buttons are verbs or direct answers: "Mulai kerjakan", "Serahkan HP",
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
naturally. Never rely on `numberOfLines` to hide the overflow. A chip
that runs past a scrolling row's edge sits under that edge's fade, so it
reads as "more", never as a cut label. The only
ellipsis allowed is a long user-entered value in a list row (a customer
name), whose full text is one tap away.

**Values never split mid-phrase.** A money amount, a date or a name stays on
one line ("Rp" and "50.000" together). Let the label beside it wrap instead
(`repairStyles.rowText` beside `rowValue`), or give the value its own line.

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

## 11. Motion

Motion explains what changed; it never decorates or makes anyone wait.

- Timings and curves are the `motion` tokens (`packages/ui/src/tokens.ts`),
  published to the PC as `--b-duration-*` and `--b-ease-*`. Nothing runs
  past 220 ms. Things arriving decelerate (`enter`), leaving accelerates.
- Only transform and opacity move. On the phone use the helpers in
  `packages/ui/src/motion.ts` (`useEntrance`, `useSheetEntrance`, `usePop`,
  `usePressScale`), which run on the native driver so cheap Androids keep
  their frames. Never animate width, height, colour or layout.
- Reduce motion in the OS means no movement: things appear in place.
- Sheets rise as the scrim dims; toasts rise in; pressed buttons shrink a
  touch; a success disc lands with a small overshoot and its tick draws in.
  A spinner is never the logo.
- Intake steps slide in from the side they come from. A new servisan number
  lands like a stamp, on its first open only.
- A money figure that changes while on screen (a balance after a QR payment,
  a total after a price change) uses `RollingText`: a rise rolls in from
  below, a drop from above. Never roll a figure the person is typing.
- A row or card another device just changed glows once (`FreshGlow`): a soft
  highlight fading out over a second, the one thing allowed past 220 ms because it
  shows a change rather than moving anything. Only what is on screen when the change
  arrives, or what it brings in (a new Kas row), glows; the person's own edits and a
  catch-up burst (first sync, back online) stay calm.

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
