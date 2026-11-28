// Calendar-day ranges for date filters on any list (received, paid, ordered), in the store's local
// time, with the quick choices every date filter offers.

/** A date range as calendar days (yyyy-mm-dd, the store's local time), either end open. */
export interface DayRange {
  readonly from: string | null;
  readonly to: string | null;
}

/** Local midnight of a yyyy-mm-dd day, as epoch ms. */
function dayStart(day: string): number {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return new Date(year, month - 1, date).getTime();
}

/** The epoch-ms bounds of a day range: from the first day's start to the day after the last. */
export function dayRangeBounds(range: DayRange): {
  readonly from: number | undefined;
  readonly before: number | undefined;
} {
  const before =
    range.to === null
      ? undefined
      : (() => {
          const end = new Date(dayStart(range.to));
          end.setDate(end.getDate() + 1);
          return end.getTime();
        })();
  return { from: range.from === null ? undefined : dayStart(range.from), before };
}

/** A local calendar day as yyyy-mm-dd. */
export function dayOf(at: number): string {
  const date = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export const DAY_PRESETS = ['today', 'last7', 'last30', 'thisMonth'] as const;
export type DayPreset = (typeof DAY_PRESETS)[number];

/** The day range a quick choice stands for, counted from `now`. */
export function presetRange(preset: DayPreset, now: number): DayRange {
  const today = dayOf(now);
  const daysAgo = (n: number): string => {
    const date = new Date(dayStart(today));
    date.setDate(date.getDate() - n);
    return dayOf(date.getTime());
  };
  switch (preset) {
    case 'today':
      return { from: today, to: today };
    case 'last7':
      return { from: daysAgo(6), to: today };
    case 'last30':
      return { from: daysAgo(29), to: today };
    case 'thisMonth':
      return { from: `${today.slice(0, 8)}01`, to: today };
  }
}
