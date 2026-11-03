import { describe, expect, it } from 'vitest';
import type { BreakdownRow } from '../api/types';
import { sortBreakdownRows } from './breakdown';

const rows: BreakdownRow[] = [
  {
    value: 'google.com',
    visitors: 20,
    pageviews: 40,
    revenue: 100,
    payments: 1,
    revenuePerVisitor: 5,
  },
  {
    value: 'a Twitter',
    visitors: 50,
    pageviews: 60,
    revenue: 60,
    payments: 2,
    revenuePerVisitor: 1.2,
  },
  {
    value: 'bing.com',
    visitors: 30,
    pageviews: 90,
    revenue: 90,
    payments: 3,
    revenuePerVisitor: 3,
  },
];

describe('sortBreakdownRows', () => {
  it('sorts numeric columns descending', () => {
    expect(sortBreakdownRows(rows, 'visitors', 'desc').map((row) => row.value)).toEqual([
      'a Twitter',
      'bing.com',
      'google.com',
    ]);
  });

  it('sorts numeric columns ascending', () => {
    expect(sortBreakdownRows(rows, 'revenue', 'asc').map((row) => row.value)).toEqual([
      'a Twitter',
      'bing.com',
      'google.com',
    ]);
  });

  it('sorts the value column with locale order', () => {
    expect(sortBreakdownRows(rows, 'value', 'asc').map((row) => row.value)).toEqual([
      'a Twitter',
      'bing.com',
      'google.com',
    ]);
  });

  it('does not mutate the input rows', () => {
    const copy = [...rows];
    sortBreakdownRows(rows, 'visitors', 'asc');
    expect(rows).toEqual(copy);
  });

  it('leaves rows with missing values in place', () => {
    const withMissing: BreakdownRow[] = [
      rows[0],
      {
        value: 'direct',
        visitors: 10,
        pageviews: 10,
        revenue: 10,
        payments: 1,
        revenuePerVisitor: 1,
      },
    ];
    const sorted = sortBreakdownRows(withMissing, 'conversionRate', 'desc');
    expect(sorted.map((row) => row.value)).toEqual(['google.com', 'direct']);
  });
});
