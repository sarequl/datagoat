export interface Delta {
  current: number;
  previous: number;
  /** Percent change, or null when the previous value was 0 and there is no meaningful ratio. */
  change: number | null;
  direction: 'up' | 'down' | 'flat';
}

export function computeDelta(current: number, previous: number): Delta {
  if (previous === 0) {
    return {
      current,
      previous,
      change: current === 0 ? 0 : null,
      direction: current === 0 ? 'flat' : 'up',
    };
  }
  const change = ((current - previous) / previous) * 100;
  const direction = change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
  return { current, previous, change, direction };
}
