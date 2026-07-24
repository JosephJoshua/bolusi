/**
 * The User Switcher (design-system §8.2; api/02-auth §5.1; PRD-011 §6.1).
 *
 * ── THE USE CASE IS A SHARED COUNTER, AND THE BUDGET IS 5 SECONDS ───────────────────────────────
 * One phone, several staff, all day, every handover mid-conversation with a customer. NFR-1003 caps
 * the whole switch at 5 s, which rules out anything clever: no animation, no confirmation screen, no
 * search box. Speed here is not polish — a switcher slower than the task makes staff share one login
 * instead, and then every op in the log is attributed to the wrong person and the entire audit trail
 * (PRD-011 §5) is fiction. The switcher's speed IS the attribution control.
 *
 * ── WHY THE LIST IS SORTED BY RECENCY AND NOT ALPHABETICALLY ────────────────────────────────────
 * Alphabetical is stable, which sounds like a virtue and is not. The people who use this device are
 * the same two or three people all day; recency puts them in the first row, every time, so the
 * switch is a single glance and one tap. §8.2 says "sorted by most-recently-active" for exactly this.
 * Ties break on name so the order is deterministic (a list that reshuffles between renders defeats
 * the muscle memory it exists to build).
 *
 * ── AND WHY DEACTIVATED USERS ARE ABSENT, NOT GREYED ────────────────────────────────────────────
 * api/02-auth §5.1: only `active` users are switcher-usable. Task 14's `listSwitcherUsers` already
 * filters them, and this model does NOT re-filter — one implementation (CLAUDE.md §2.8). A greyed
 * row would advertise a colleague's deactivation to the whole shop and invite tapping something that
 * cannot work; absence is both kinder and correct. Their name still resolves on historical ops
 * (14's `resolveUserName`) — authentication is gated on status, name resolution is not.
 */

/** A switcher card. Shape mirrors 14's `listSwitcherUsers` plus the shell's ordering input. */
export interface SwitcherUser {
  readonly id: string;
  readonly name: string;
  /** Carried from day one (api/02-auth §5.2); v0 renders initials — a photo slots in unchanged. */
  readonly photoMediaId: string | null;
  /** ms epoch of this user's last session on this device; null ⇒ never used it here. */
  readonly lastActiveAt: number | null;
  /** True when the bundle row has `pinVerifier: null` — the §6.6 first-PIN flow. */
  readonly needsFirstPin: boolean;
}

/**
 * The four mandatory states (design-system §5), as a discriminated union so the screen cannot render
 * items-while-meaning-denied (FR-1036) and cannot forget one.
 *
 * `unauthorized` is present and deliberately unreachable in v0: §8.2 says this pre-auth surface has
 * no unauthorized case and renders `error` instead — there is no signed-in user to deny. Keeping the
 * arm in the union costs nothing and means the notes screens (task 25), which DO have one, inherit
 * the same shape rather than inventing a second one.
 */
export type SwitcherState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'empty' }
  | { readonly kind: 'error'; readonly code: string }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'ready'; readonly users: readonly SwitcherUser[] };

/**
 * §8.2's ordering: most-recently-active first, never-used last, ties by name.
 *
 * Pure and total — a copy is sorted, never the caller's array, so a re-render cannot mutate the
 * query result underneath a virtualized list mid-scroll.
 */
export function sortByRecency(users: readonly SwitcherUser[]): readonly SwitcherUser[] {
  return [...users].sort((a, b) => {
    const left = a.lastActiveAt ?? -1;
    const right = b.lastActiveAt ?? -1;
    if (left !== right) return right - left;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Build the screen state from a query result. `null` users ⇒ still loading; an empty array is EMPTY
 * and is a real, meaningful state — a device enrolled against a store with no active users, which is
 * why §8.2 gives it a CTA to enrollment rather than an apology.
 */
export function switcherState(
  users: readonly SwitcherUser[] | null,
  error: string | null,
): SwitcherState {
  if (error !== null) return { kind: 'error', code: error };
  if (users === null) return { kind: 'loading' };
  if (users.length === 0) return { kind: 'empty' };
  return { kind: 'ready', users: sortByRecency(users) };
}

/** §8.2's grid is 2 columns. Named once, here, because the chunking and the layout must agree. */
export const SWITCHER_COLUMNS = 2;

/** A rendered grid row: up to `SWITCHER_COLUMNS` cards, keyed for the virtualized list. */
export interface SwitcherGridRow {
  readonly key: string;
  readonly users: readonly SwitcherUser[];
}

/**
 * Chunk the users into grid rows — how this screen gets §8.2's TWO-COLUMN GRID out of a
 * ONE-COLUMN virtualized primitive, without touching a contended package.
 *
 * The problem: design-system §8.2 specifies a 2-column grid of 96 dp avatars, but `@bolusi/ui`'s
 * `List` (§3.13, the only sanctioned collection primitive) wraps `FlatList` with fixed-height rows
 * and exposes no `numColumns`. `packages/ui` is CONTENDED this wave (CLAUDE.md §4), so adding the
 * prop is a coordinated design-system change, not an inline edit.
 *
 * The answer: make each LIST ITEM a grid ROW. The list windows, and the screen gets its grid. A
 * `.map()` over all users inside one ScrollView would have been the easy alternative and is
 * precisely the defect the 2 GB target cannot afford (§0/§3.13); the `bolusi/list-primitive-only`
 * rule this task ships would not have caught that (it guards the import, not a hand-rolled map).
 *
 * ── KNOWN DEFECT: THE SCROLL GEOMETRY IS WRONG (task 33) ────────────────────────────────────────
 * State plainly, because an earlier version of this comment claimed the opposite and a false
 * "verified" claim is what silently retires a concern:
 *
 *   `List` hardcodes `getItemLayout` to `length: touch.row` (**64**) with no override prop. A grid
 *   row here actually renders `space.lg`×2 padding (32) + `Avatar size="switcher"` (96) +
 *   `space.sm` gap (8) + a name at `type.body` lineHeight 26 — and the name is `numberOfLines={2}`.
 *   So a row is **162 dp** with a one-line name and **188 dp** when it wraps. (`minHeight:
 *   touch.row` is a floor that never binds.)
 *
 * Two things follow, and both are true:
 *   1. Rows are uniform ONLY while no name wraps — a wrapping name adds 26 dp, so uniformity is a
 *      property of the DATA here, not of the construction.
 *   2. The reported length is ~2.5× short of the real one. `getItemLayout` exists precisely to SKIP
 *      measurement, so FlatList never discovers the error and never self-corrects: scroll extent and
 *      every computed offset are wrong, and `removeClippedSubviews` (on by default on Android)
 *      compounds it by unmounting against those offsets.
 *
 * Windowing still happens — this is not a `.map()`, and memory is still bounded. What is broken is
 * where the list thinks its rows ARE.
 *
 * The irony is worth absorbing rather than hiding: the scenario invoked above to justify this design
 * — a shop with 30 staff — is exactly the one where it breaks. At the typical 2–3 staff nothing
 * scrolls and the defect is invisible. Uniformity was also never sufficient on its own; the value
 * has to be RIGHT, and it is not.
 *
 * The fix is `ListProps.itemHeight` (or a measured layout) in `@bolusi/ui`, which is contended this
 * wave — so it is FILED, not patched here. Do not "fix" it by shrinking the card to 64 dp: §8.2
 * specifies a 96 dp avatar precisely so a face is recognisable, and that is the point of the screen.
 *
 * The trailing row is short rather than padded with a placeholder: the screen renders an empty
 * flex spacer, so an odd user count leaves a gap instead of a phantom card.
 */
export function toGridRows(
  users: readonly SwitcherUser[],
  columns: number = SWITCHER_COLUMNS,
): readonly SwitcherGridRow[] {
  const rows: SwitcherGridRow[] = [];
  for (let index = 0; index < users.length; index += columns) {
    const slice = users.slice(index, index + columns);
    // Keyed by the row's FIRST user id, not the index: an index key would make React reuse a card
    // for a different person when the recency order changes underneath a re-render — on a switcher,
    // that is the wrong face under the right name.
    rows.push({ key: slice[0]!.id, users: slice });
  }
  return rows;
}

/** Initials for the Avatar (design-system §3.12) — 1–2 characters, uppercased. */
export function initialsOf(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  if (words.length === 0) return '?';
  if (words.length === 1) return (words[0]![0] ?? '?').toUpperCase();
  return `${words[0]![0]}${words[words.length - 1]![0]}`.toUpperCase();
}

/**
 * What tapping a card does. A user whose verifier is null goes to PIN SETUP, not to a PIN pad they
 * cannot satisfy (§6.6 first-PIN). Sending them to the pad would be a locked door with no key: they
 * would type guesses against a verifier that does not exist and — since a wrong-length guess still
 * burns an attempt (14's `assertPinFormat` comment) — could lock themselves out of an account they
 * have never used.
 */
export type SwitcherTap =
  | { readonly kind: 'pin'; readonly userId: string }
  | { readonly kind: 'firstPinSetup'; readonly userId: string };

export function tapTarget(user: SwitcherUser): SwitcherTap {
  return user.needsFirstPin
    ? { kind: 'firstPinSetup', userId: user.id }
    : { kind: 'pin', userId: user.id };
}

// NO per-state headline label map here (task 65). A `SWITCHER_KEY` mirror once existed and was a
// decoy: `SwitcherScreen` renders each state's headline at its own site — `ListState.empty.title`,
// `.error.title`, `.unauthorized.title`, and the always-present AppShell title — never from a map,
// so the map shipped nowhere while its tests asserted it (the `canAttempt` shape, task 60). It also
// fit the UI badly: `loading` has no headline (a spinner) and `ready`'s "headline" is the screen
// title shown in every state. The one property worth guarding — empty ≠ error, so `[]` never reads
// as "we could not ask" (FR-1036) — lives in `switcherState`'s `kind` (its test), which is the
// shipping path the screen renders from; that is where the guard belongs (§2.8).

/** §8.2: the empty state's CTA goes to Device Enrollment. */
/**
 * The empty roster's GUIDANCE line (design-system §5; owner ruling D23 §3, 2026-07-23).
 *
 * It was `SWITCHER_EMPTY_CTA_KEY = 'auth.switcher.addUser'` — the label of a create-CTA whose
 * `onCreate` the composition root wired to `noop`, so the one control on the one screen a shop sees
 * when its roster is empty rendered, took a press, and did nothing (task 130). D23 §3 ruled the CTA
 * OUT of v0 rather than wiring it: reaching Device Enrollment from an `active` device needs a new
 * input on the `resolveZone` security gate, and completing it runs api/02-auth §7.4 re-enrollment —
 * a new `deviceId`, a new keypair, a fresh chain at seq 1, with the old registration left `active`
 * server-side (03 §5 has no `active → re-enroll` transition). Task 168 carries that to v1.
 *
 * §5 still requires the Empty state to say what to do, so the CTA is replaced by TEXT naming the
 * real-world action — the store owner enrols the device — rather than a button this build cannot
 * honour. `auth.switcher.addUser` stays in the catalog for 168 to use.
 */
export const SWITCHER_EMPTY_HINT_KEY = 'auth.switcher.emptyUsers';

/** §8.2 / §6.4: the lock's explanation — "Layar terkunci… Pekerjaanmu aman." (your work is safe). */
export const SWITCHER_LOCK_KEY = 'auth.switcher.idleLocked';
