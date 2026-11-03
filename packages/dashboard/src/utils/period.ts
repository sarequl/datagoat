import { addDays, differenceInCalendarDays, format, parseISO, startOfDay } from 'date-fns';
import type { Interval } from '../api/analytics';

export type PeriodPreset = 'today' | 'yesterday' | '7d' | '30d' | '90d' | 'custom';

export interface PeriodRange {
  startAt: string;
  endAt: string;
  preset: PeriodPreset;
}

export const PERIOD_PRESETS: { id: PeriodPreset; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
  { id: '90d', label: 'Last 90 days' },
  { id: 'custom', label: 'Custom' },
];

/**
 * Returns the site's current wall-clock time as a UTC Date, so date-fns math
 * stays in the site timezone without pulling in a timezone dependency.
 */
export function zonedNow(timezone: string): Date {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    return part ? Number(part.value) : 0;
  };
  const hour = get('hour') % 24;
  return new Date(
    Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second')),
  );
}

export function formatDateString(date: Date): string {
  return format(date, 'yyyy-MM-dd');
}

export function getPresetRange(preset: PeriodPreset, timezone: string): PeriodRange {
  const today = startOfDay(zonedNow(timezone));
  switch (preset) {
    case 'today':
      return { startAt: formatDateString(today), endAt: formatDateString(today), preset };
    case 'yesterday': {
      const yesterday = addDays(today, -1);
      return { startAt: formatDateString(yesterday), endAt: formatDateString(yesterday), preset };
    }
    case '7d':
      return {
        startAt: formatDateString(addDays(today, -6)),
        endAt: formatDateString(today),
        preset,
      };
    case '30d':
      return {
        startAt: formatDateString(addDays(today, -29)),
        endAt: formatDateString(today),
        preset,
      };
    case '90d':
      return {
        startAt: formatDateString(addDays(today, -89)),
        endAt: formatDateString(today),
        preset,
      };
    default:
      return { startAt: '', endAt: '', preset: 'custom' };
  }
}

export function detectPreset(startAt: string, endAt: string, timezone: string): PeriodPreset {
  for (const preset of ['today', 'yesterday', '7d', '30d', '90d'] as PeriodPreset[]) {
    const range = getPresetRange(preset, timezone);
    if (range.startAt === startAt && range.endAt === endAt) {
      return preset;
    }
  }
  return 'custom';
}

/** The immediately preceding equal-length range, for the client-side delta fallback. */
export function previousRange(startAt: string, endAt: string): { startAt: string; endAt: string } {
  const start = parseISO(startAt);
  const end = parseISO(endAt);
  const length = differenceInCalendarDays(end, start) + 1;
  return {
    startAt: formatDateString(addDays(start, -length)),
    endAt: formatDateString(addDays(end, -length)),
  };
}

export function presetToInterval(preset: PeriodPreset, startAt: string, endAt: string): Interval {
  if (preset === 'today' || preset === 'yesterday') return 'hour';
  if (preset === '7d' || preset === '30d') return 'day';
  if (preset === '90d') return 'week';
  const days = differenceInCalendarDays(parseISO(endAt), parseISO(startAt)) + 1;
  if (days <= 2) return 'hour';
  if (days <= 62) return 'day';
  return 'week';
}
