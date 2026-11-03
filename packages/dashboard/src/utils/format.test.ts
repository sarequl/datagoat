import { describe, expect, it } from 'vitest';
import { formatCurrency, formatDelta, formatDuration, formatNumber, formatPercent } from './format';

describe('format helpers', () => {
  it('formats numbers with grouping', () => {
    expect(formatNumber(12840)).toBe('12,840');
  });

  it('formats percentages', () => {
    expect(formatPercent(0.42)).toBe('42.0%');
    expect(formatPercent(0.0333, 2)).toBe('3.33%');
  });

  it('formats durations', () => {
    expect(formatDuration(184)).toBe('3m 04s');
    expect(formatDuration(45)).toBe('45s');
  });

  it('formats currency', () => {
    expect(formatCurrency(5310.5, 'USD')).toBe('$5,311');
    expect(formatCurrency(0.41, 'USD')).toBe('$0.41');
  });

  it('formats deltas', () => {
    expect(formatDelta(12.3)).toBe('+12.3%');
    expect(formatDelta(-4.2)).toBe('-4.2%');
  });
});
