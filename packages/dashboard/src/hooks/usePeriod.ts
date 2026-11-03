import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { detectPreset, getPresetRange, type PeriodPreset, type PeriodRange } from '../utils/period';

export function usePeriod(timezone: string) {
  const [searchParams, setSearchParams] = useSearchParams();
  const startAt = searchParams.get('startAt') ?? undefined;
  const endAt = searchParams.get('endAt') ?? undefined;
  const compare = searchParams.get('compare') === 'previous';

  const preset: PeriodPreset = useMemo(() => {
    if (startAt && endAt) {
      return detectPreset(startAt, endAt, timezone);
    }
    return '7d';
  }, [startAt, endAt, timezone]);

  const range: PeriodRange = useMemo(() => {
    if (startAt && endAt) {
      return { startAt, endAt, preset };
    }
    return { ...getPresetRange('7d', timezone), preset: '7d' };
  }, [startAt, endAt, preset, timezone]);

  const selectPreset = useCallback(
    (next: PeriodPreset) => {
      if (next === 'custom') return;
      const nextRange = getPresetRange(next, timezone);
      const params = new URLSearchParams(searchParams);
      params.set('startAt', nextRange.startAt);
      params.set('endAt', nextRange.endAt);
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams, timezone],
  );

  const setCustomRange = useCallback(
    (nextStart: string, nextEnd: string) => {
      const params = new URLSearchParams(searchParams);
      params.set('startAt', nextStart);
      params.set('endAt', nextEnd);
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const setCompare = useCallback(
    (enabled: boolean) => {
      const params = new URLSearchParams(searchParams);
      if (enabled) {
        params.set('compare', 'previous');
      } else {
        params.delete('compare');
      }
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  return {
    startAt: range.startAt,
    endAt: range.endAt,
    preset,
    compare,
    selectPreset,
    setCustomRange,
    setCompare,
  };
}
