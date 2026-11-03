import { describe, expect, it } from 'vitest';
import {
  detectPreset,
  formatDateString,
  getPresetRange,
  presetToInterval,
  previousRange,
} from './period';

const TZ = 'UTC';

describe('period helpers', () => {
  it('builds a 7-day preset range ending today', () => {
    const range = getPresetRange('7d', TZ);
    expect(range.endAt).toBe(formatDateString(new Date()));
    const start = new Date(`${range.startAt}T00:00:00Z`).getTime();
    const end = new Date(`${range.endAt}T00:00:00Z`).getTime();
    expect((end - start) / 86_400_000).toBe(6);
  });

  it('detects a matching preset', () => {
    const range = getPresetRange('30d', TZ);
    expect(detectPreset(range.startAt, range.endAt, TZ)).toBe('30d');
  });

  it('returns custom for an unknown range', () => {
    expect(detectPreset('2020-01-01', '2020-01-02', TZ)).toBe('custom');
  });

  it('computes the previous equal-length range', () => {
    expect(previousRange('2026-01-08', '2026-01-14')).toEqual({
      startAt: '2026-01-01',
      endAt: '2026-01-07',
    });
  });

  it('maps presets to chart intervals', () => {
    expect(presetToInterval('today', '2026-01-01', '2026-01-01')).toBe('hour');
    expect(presetToInterval('7d', '2026-01-01', '2026-01-07')).toBe('day');
    expect(presetToInterval('90d', '2026-01-01', '2026-03-31')).toBe('week');
    expect(presetToInterval('custom', '2026-01-01', '2026-06-01')).toBe('week');
  });
});
