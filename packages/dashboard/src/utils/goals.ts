import type { GoalRow } from '../api/types';

export type GoalSortKey =
  | 'value'
  | 'visitors'
  | 'completions'
  | 'revenue'
  | 'payments'
  | 'revenuePerVisitor';

export type SortDirection = 'asc' | 'desc';

/** Sorts the loaded page. The frozen API only orders by visitors, so sorting is client-side. */
export function sortGoalRows(
  rows: GoalRow[],
  key: GoalSortKey,
  direction: SortDirection,
): GoalRow[] {
  const factor = direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = a[key];
    const right = b[key];
    if (typeof left === 'string' || typeof right === 'string') {
      return factor * String(left).localeCompare(String(right));
    }
    return factor * (left - right);
  });
}
