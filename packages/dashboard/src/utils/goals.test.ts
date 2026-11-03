import { describe, expect, it } from 'vitest';
import type { GoalRow } from '../api/types';
import { sortGoalRows } from './goals';

const rows: GoalRow[] = [
  {
    value: 'signup',
    completions: 482,
    visitors: 391,
    pageviews: 0,
    revenue: 0,
    payments: 0,
    revenuePerVisitor: 0,
  },
  {
    value: 'demo',
    completions: 96,
    visitors: 84,
    pageviews: 0,
    revenue: 0,
    payments: 0,
    revenuePerVisitor: 0,
  },
  {
    value: 'payment',
    completions: 42,
    visitors: 42,
    pageviews: 0,
    revenue: 5310.5,
    payments: 42,
    revenuePerVisitor: 126.44,
  },
];

describe('sortGoalRows', () => {
  it('sorts by visitors descending', () => {
    expect(sortGoalRows(rows, 'visitors', 'desc').map((row) => row.value)).toEqual([
      'signup',
      'demo',
      'payment',
    ]);
  });

  it('reverses the order when ascending', () => {
    expect(sortGoalRows(rows, 'visitors', 'asc').map((row) => row.value)).toEqual([
      'payment',
      'demo',
      'signup',
    ]);
  });

  it('sorts goal names with localeCompare', () => {
    expect(sortGoalRows(rows, 'value', 'asc').map((row) => row.value)).toEqual([
      'demo',
      'payment',
      'signup',
    ]);
  });

  it('sorts by revenue', () => {
    expect(sortGoalRows(rows, 'revenue', 'desc')[0].value).toBe('payment');
  });

  it('does not mutate the input rows', () => {
    const copy = [...rows];
    sortGoalRows(rows, 'visitors', 'asc');
    expect(rows).toEqual(copy);
  });
});
