import { describe, expect, it } from 'vitest';
import { computeDelta } from './deltas';

describe('computeDelta', () => {
  it('computes a positive percent change', () => {
    expect(computeDelta(110, 100)).toMatchObject({ change: 10, direction: 'up' });
  });

  it('computes a negative percent change', () => {
    expect(computeDelta(90, 100)).toMatchObject({ change: -10, direction: 'down' });
  });

  it('returns flat for equal values', () => {
    expect(computeDelta(100, 100)).toMatchObject({ change: 0, direction: 'flat' });
  });

  it('returns a null change when the previous value was zero', () => {
    expect(computeDelta(5, 0)).toMatchObject({ change: null, direction: 'up' });
  });
});
