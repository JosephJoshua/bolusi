// Which captured media an operation commits to (06 §4: a capture becomes uploadable only once the
// op that references it is appended). Module payloads carry `mediaRef`s anywhere (a note's single
// photo, a ticket's six intake photos, a handover signature), so this walks the payload rather than
// asking each module to list them.
import { zMediaRef } from '@bolusi/schemas';

/** The ids of every complete `mediaRef` in a payload, in first-seen order, without duplicates. */
export function mediaIdsInPayload(payload: unknown): readonly string[] {
  const found = new Set<string>();
  const walk = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    const ref = zMediaRef.safeParse(value);
    if (ref.success) {
      found.add(ref.data.mediaId);
      return;
    }
    for (const child of Object.values(value)) walk(child);
  };
  walk(payload);
  return [...found];
}
