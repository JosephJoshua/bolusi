/**
 * The "type a new PIN, then repeat it" sub-flow (api/02-auth §6.6; design-system §8.3).
 *
 * Shared by BOTH the change-PIN screen (the user sets their own new PIN) and the owner-reset screen
 * (the target user types their new PIN) — one implementation, not two (CLAUDE.md §2.8). The two
 * screens wrap it differently (change verifies a current PIN first; reset picks a target and hands
 * the device over first), but the "enter → repeat → they must match" core is identical, and the
 * MATCH CHECK is the one security-relevant decision this file owns.
 *
 * WHY `matched` IS UNREACHABLE WITHOUT AN EQUAL REPEAT. `advanceNewPin` yields `matched` from exactly
 * one place — the `repeat` arm, guarded by `pin === entry.first`. There is no other producer. So a
 * screen built on this reducer cannot submit a PIN the user did not confirm: a mistyped repeat falls
 * back to `first` (both digits re-typed from scratch, never a partially-remembered first), and the
 * submit step keys off `matched`. That property is asserted directly in the model tests (T-6) rather
 * than hoped for through a rendered PIN pad.
 *
 * The PIN itself lives only in this in-memory value while it is being typed — never persisted, never
 * logged (this module has no I/O). It leaves as `matched.pin` for the caller to hand to the flow.
 */

/** PIN entry sub-state. A discriminated union so the screen's switch is exhaustive (no blank pad). */
export type NewPinEntry =
  /** Awaiting the new PIN. `afterMismatch` drives the one-shot "PINs don’t match" message. */
  | { readonly kind: 'first'; readonly afterMismatch: boolean }
  /** Awaiting the repeat of `first`. */
  | { readonly kind: 'repeat'; readonly first: string }
  /** The repeat equalled `first` — the caller may now submit `pin`. Terminal. */
  | { readonly kind: 'matched'; readonly pin: string };

/** A fresh entry: awaiting the first new PIN, no mismatch yet. */
export const NEW_PIN_START: NewPinEntry = { kind: 'first', afterMismatch: false };

/**
 * Advance the sub-flow on a completed 6-digit `pin` (PinPad only fires `onComplete` at length 6, so
 * format is the pad's guarantee — this reducer decides only the match, never re-validates digits).
 *
 * `first`   → capture it, ask for the repeat.
 * `repeat`  → equal ⇒ `matched`; unequal ⇒ back to `first` with `afterMismatch` set (re-type both).
 * `matched` → terminal; a stray late completion is ignored rather than re-opening a settled entry.
 */
export function advanceNewPin(entry: NewPinEntry, pin: string): NewPinEntry {
  switch (entry.kind) {
    case 'first':
      return { kind: 'repeat', first: pin };
    case 'repeat':
      // The ONLY producer of `matched`, and it is gated on equality. Break this and a mismatched
      // confirmation would submit — new-pin.test.ts exercises exactly the unequal case.
      return pin === entry.first
        ? { kind: 'matched', pin }
        : { kind: 'first', afterMismatch: true };
    case 'matched':
      return entry;
  }
}

/**
 * The label key the PIN pad's message slot shows for an entry state (keys only — copy lives in the
 * catalog, 07-i18n). `first` normally invites a new PIN; after a mismatch it says so; `repeat` asks
 * for the repeat. `matched` renders no message (the caller has moved on to submit).
 */
export function newPinMessageKey(
  entry: NewPinEntry,
): 'auth.pin.setup.title' | 'auth.pin.setup.repeat' | 'auth.pin.setup.mismatch' | null {
  switch (entry.kind) {
    case 'first':
      return entry.afterMismatch ? 'auth.pin.setup.mismatch' : 'auth.pin.setup.title';
    case 'repeat':
      return 'auth.pin.setup.repeat';
    case 'matched':
      return null;
  }
}
