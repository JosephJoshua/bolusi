// Which captured media an operation commits to (06 §4: a capture becomes uploadable only once the
// op that references it is appended). Module payloads carry `mediaRef`s anywhere (a note's single
// photo, a ticket's six intake photos, a handover signature), so this walks the payload rather than
// asking each module to list them.
import { zAnyMediaRef, type AnyMediaRef } from '@bolusi/schemas';

/** Every complete media ref (photo, signature or video) in a payload, first-seen order, once per id. */
export function mediaRefsInPayload(payload: unknown): readonly AnyMediaRef[] {
  const found = new Map<string, AnyMediaRef>();
  const walk = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    const ref = zAnyMediaRef.safeParse(value);
    if (ref.success) {
      if (!found.has(ref.data.mediaId)) found.set(ref.data.mediaId, ref.data);
      return;
    }
    for (const child of Object.values(value)) walk(child);
  };
  walk(payload);
  return [...found.values()];
}
