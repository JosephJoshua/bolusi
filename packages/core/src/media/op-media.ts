// Which captured media an operation commits to (06 §4: a capture becomes uploadable only once the
// op that references it is appended). Module payloads carry `mediaRef`s anywhere (a note's single
// photo, a ticket's six intake photos, a handover signature), so this walks the payload rather than
// asking each module to list them.
import { zMediaRef, type MediaRef } from '@bolusi/schemas';

/** Every complete `mediaRef` in a payload, in first-seen order, once per media id. */
export function mediaRefsInPayload(payload: unknown): readonly MediaRef[] {
  const found = new Map<string, MediaRef>();
  const walk = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    const ref = zMediaRef.safeParse(value);
    if (ref.success) {
      if (!found.has(ref.data.mediaId)) found.set(ref.data.mediaId, ref.data);
      return;
    }
    for (const child of Object.values(value)) walk(child);
  };
  walk(payload);
  return [...found.values()];
}
