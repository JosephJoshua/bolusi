/**
 * The shell↔surface back/leave contract (design-system §8.1; task 145).
 *
 * WHY THIS EXISTS. `resolveZone` (zone.ts) is a pure GATE: it decides which top-level surface shows
 * from auth truth, and it deliberately cannot see a module surface's OWN navigation — `NotesHome`
 * owns its list→detail→editor stack privately, exactly as the enrollment wizard owns its steps. That
 * privacy is what left two ways to destroy a half-written note: Android hardware back read `home` as
 * top-of-stack and EXITED THE APP past the open editor, and any header-chrome tap unmounted the
 * surface (dropping the draft) because the shell had no way to ask "is there unsaved work down there?"
 *
 * A `SurfaceNav` is that missing question. A module surface mounted at a shell route publishes one
 * while it has somewhere to go back to internally; the shell routes hardware back and header-chrome
 * taps through it, so §8.1's "hardware back equals the header back action" holds ACROSS the module's
 * own screens and the editor's discard gate guards every leave — without a navigation library or a
 * second source of truth for "where am I" that could disagree with the auth gate.
 */

/**
 * A live module surface's back/leave delegate, registered with the shell while the surface is off its
 * root (an editor or detail is open) and cleared (`null`) when it returns to root.
 */
export interface SurfaceNav {
  /**
   * Android hardware back landed on this surface. Run the surface's OWN back — which, for an open
   * editor, is the discard gate (dirty ⇒ ConfirmSheet, clean ⇒ return one step). Returns `true`: the
   * surface consumed the press, so the shell must NOT fall through to an app exit (design-system §8.1).
   */
  readonly handleBack: () => boolean;
  /**
   * A header-chrome tap wants to navigate AWAY from this surface toward `proceed`. Run the discard
   * gate first: a dirty editor raises its ConfirmSheet and calls `proceed` only on confirm; anything
   * clean calls `proceed` at once. This is what stops a chip/avatar/sync-chip tap from unmounting a
   * half-written draft with no confirm.
   */
  readonly requestLeave: (proceed: () => void) => void;
}
