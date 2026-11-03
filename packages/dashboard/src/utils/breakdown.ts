import type { BreakdownRow } from '../api/types';

export type BreakdownSortKey =
  | 'value'
  | 'visitors'
  | 'pageviews'
  | 'revenue'
  | 'payments'
  | 'revenuePerVisitor'
  | 'conversionRate';

export type SortDirection = 'asc' | 'desc';

/** Sorts the loaded page. The frozen API only orders by visitors, so sorting is client-side. */
export function sortBreakdownRows(
  rows: BreakdownRow[],
  key: BreakdownSortKey,
  direction: SortDirection,
): BreakdownRow[] {
  const factor = direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = a[key];
    const right = b[key];
    if (left === undefined || right === undefined) {
      return 0;
    }
    if (typeof left === 'string' || typeof right === 'string') {
      return factor * String(left).localeCompare(String(right));
    }
    return factor * (left - right);
  });
}
