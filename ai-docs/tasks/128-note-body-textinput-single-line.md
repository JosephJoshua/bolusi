# TASK 128 — the note BODY is a single-line input that clips: the shared `TextInput` never sets `multiline`

**Status:** in-review
**Priority:** **HIGH — the reference module's core content is unusable.** On a 360dp phone the body shows ~35 characters at a time with no wrap and no scroll affordance. This is not an RNW artifact: a single-line RN `TextInput` clips identically on Android.
**Depends on:** 96 (notes screens), the `@bolusi/ui` kit
**Blocks:** —
**SEC ids owned by THIS task:** none.
**Filed by:** QA visual state-map sweep, 2026-07-22.

## The finding (verified)
`packages/ui/src/components/TextInput.tsx` never sets `multiline`; RN defaults it to `false`. `design-system.md` §8.6 specifies "title + body TextInputs" for a free-form note body. Rendered proof: the editor shows "Sisa 4 karung di gudang belakang. Pesan" with the remainder cut off. Repro: `?screen=app&state=shell` → `notes.list.row.note-demo-1` → `notes.detail.edit`.

**Secondary, same screen:** the note's TITLE renders in `color.textDisabled` grey (`TextInput.tsx:94`) because edit-mode expresses read-only via `disabled`. §6.1 exempts disabled text from the 4.5:1 contrast floor so no gate fires — but the note's identifying content ends up the least readable text on screen. Decide whether read-only should be a distinct visual treatment from disabled.

## Deliverable
- Give the shared `TextInput` a `multiline` capability and use it for the note body (and any other free-form field), with sensible min/max height + scroll. Keep single-line the default so no existing field changes.
- Address the read-only-vs-disabled treatment (or record why `disabled` is right).
- **Falsify:** a render test asserting the body field is multiline and that a long value wraps rather than clips; revert → RED → restore. Regenerate the 116 screenshots and confirm the body renders in full.
