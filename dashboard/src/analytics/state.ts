/**
 * Dashboard view state lives in the URL (period, custom range, granularity, comparison, chart
 * metric and `filter_*`), so every view is a link. `useDashboardState()` parses it and resolves
 * API params in the website timezone; `update()` writes it back with `replace` navigation.
 */
import { useNavigate, useRouterState, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type ActiveFilter, filtersFromSearch, filtersToParams } from "./lib/filters";
import {
  allowedIntervals,
  type ChartInterval,
  DEFAULT_PERIOD,
  defaultInterval,
  PERIOD_OPTIONS,
  type Period,
  type PeriodKey,
  previousRange,
  type ResolvedRange,
  resolvePeriod,
} from "./lib/period";
import { isYmd } from "./lib/tz";
import { useSource } from "./source";

export type SearchState = Record<string, unknown>;

export function parsePeriod(search: SearchState, fallback: Period = DEFAULT_PERIOD): Period {
  const key = String(search.period ?? "");
  if (key === "custom" && isYmd(search.from) && isYmd(search.to)) {
    return { key: "custom", from: search.from, to: search.to };
  }
  if (PERIOD_OPTIONS.some((o) => o.key === key)) return { key: key as PeriodKey };
  return fallback;
}

/** Current time rounded to the minute; ticks every minute while `live`. */
export function useMinuteClock(live: boolean): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 60_000) * 60_000);
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setNow(Math.floor(Date.now() / 60_000) * 60_000), 60_000);
    return () => clearInterval(id);
  }, [live]);
  return now;
}

export function useSearchState() {
  const search = useSearch({ strict: false }) as SearchState;
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const update = useCallback(
    (patch: SearchState | ((prev: SearchState) => SearchState)) => {
      void navigate({
        to: pathname,
        replace: true,
        search: ((prev: SearchState) => {
          const next = typeof patch === "function" ? patch(prev) : { ...prev, ...patch };
          return Object.fromEntries(
            Object.entries(next).filter(([, v]) => v !== undefined && v !== null && v !== ""),
          );
        }) as never,
      });
    },
    [navigate, pathname],
  );
  return { search, update };
}

export interface DashboardState {
  period: Period;
  range: ResolvedRange;
  prevRange: ResolvedRange | null;
  interval: ChartInterval;
  intervals: ChartInterval[];
  compare: boolean;
  metric: string | null;
  filters: ActiveFilter[];
  /** startAt/endAt/timezone for the API. */
  rangeParams: Record<string, string>;
  prevParams: Record<string, string> | null;
  filterParams: Record<string, string>;
  timezone: string;
  now: number;
  search: SearchState;
  update: (patch: SearchState | ((prev: SearchState) => SearchState)) => void;
  setPeriod: (p: Period) => void;
  setFilters: (filters: ActiveFilter[]) => void;
}

export function rangeToParams(range: ResolvedRange, timezone: string): Record<string, string> {
  const p: Record<string, string> = { timezone };
  if (range.startAt && range.endAt) {
    p.startAt = range.startAt;
    p.endAt = range.endAt;
  }
  return p;
}

export function useDashboardState(defaultPeriod: Period = DEFAULT_PERIOD): DashboardState {
  const source = useSource();
  const { search, update } = useSearchState();
  // A string key keeps the parsed period stable across renders.
  const periodKey = JSON.stringify(parsePeriod(search, defaultPeriod));
  const period = useMemo(() => JSON.parse(periodKey) as Period, [periodKey]);
  const tz = source.timezone;
  const siteStart = source.kind === "site" ? source.siteStart : undefined;
  const liveGuess = period.key !== "yesterday" && period.key !== "lastmonth";
  const now = useMinuteClock(liveGuess);
  const range = useMemo(
    () => resolvePeriod(period, tz, now, siteStart),
    [period, tz, now, siteStart],
  );
  const prevRange = useMemo(() => previousRange(range, period), [range, period]);
  const intervals = allowedIntervals(range);
  const requested = String(search.interval ?? "") as ChartInterval;
  const interval = intervals.includes(requested) ? requested : defaultInterval(range);
  const filters = useMemo(() => filtersFromSearch(search), [search]);
  const filterParams = useMemo(() => filtersToParams(filters), [filters]);
  const rangeParams = useMemo(() => rangeToParams(range, tz), [range, tz]);
  const prevParams = useMemo(
    () => (prevRange ? rangeToParams(prevRange, tz) : null),
    [prevRange, tz],
  );
  const setPeriod = useCallback(
    (p: Period) =>
      update((prev) => ({
        ...prev,
        period: p.key,
        from: p.key === "custom" ? p.from : undefined,
        to: p.key === "custom" ? p.to : undefined,
        interval: undefined,
      })),
    [update],
  );
  const setFilters = useCallback(
    (next: ActiveFilter[]) =>
      update((prev) => ({
        ...Object.fromEntries(Object.entries(prev).filter(([k]) => !k.startsWith("filter_"))),
        ...filtersToParams(next),
      })),
    [update],
  );
  const compare = search.compare === true || search.compare === 1 || search.compare === "1";
  const metric = typeof search.metric === "string" ? search.metric : null;
  return {
    period,
    range,
    prevRange,
    interval,
    intervals,
    compare,
    metric,
    filters,
    rangeParams,
    prevParams,
    filterParams,
    timezone: tz,
    now,
    search,
    update,
    setPeriod,
    setFilters,
  };
}
