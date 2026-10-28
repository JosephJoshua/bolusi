// An open settings form, when the saved settings change underneath it (another device's save
// syncing in): every field the person has not touched takes the new value, and every field they
// changed keeps theirs. Saving then sends only their edits on top of the latest settings, never
// the other device's change undone.

/** `form` moved from `before` onto `after`, field by field; `same` says whether a field was touched. */
export function rebaseForm<T extends object>(
  form: T,
  before: T,
  after: T,
  same: (key: keyof T, a: T[keyof T], b: T[keyof T]) => boolean = (_key, a, b) => a === b,
): T {
  const next = { ...after };
  for (const key of Object.keys(form) as (keyof T)[]) {
    if (!same(key, form[key], before[key])) next[key] = form[key];
  }
  return next;
}
