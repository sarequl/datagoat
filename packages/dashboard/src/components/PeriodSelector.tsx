import { useEffect, useState } from 'react';
import { usePeriod } from '../hooks/usePeriod';
import { PERIOD_PRESETS } from '../utils/period';

export function PeriodSelector({ timezone }: { timezone: string }) {
  const { startAt, endAt, preset, compare, selectPreset, setCustomRange, setCompare } =
    usePeriod(timezone);
  const [customStart, setCustomStart] = useState(startAt);
  const [customEnd, setCustomEnd] = useState(endAt);

  useEffect(() => {
    setCustomStart(startAt);
    setCustomEnd(endAt);
  }, [startAt, endAt]);

  return (
    <div className="period-selector">
      <fieldset className="period-presets">
        <legend className="visually-hidden">Period</legend>
        {PERIOD_PRESETS.filter((item) => item.id !== 'custom').map((item) => (
          <button
            key={item.id}
            type="button"
            className={`period-preset${preset === item.id ? ' period-preset--active' : ''}`}
            aria-pressed={preset === item.id}
            onClick={() => selectPreset(item.id)}
          >
            {item.label}
          </button>
        ))}
      </fieldset>

      <label className="period-compare">
        <input
          type="checkbox"
          checked={compare}
          onChange={(event) => setCompare(event.target.checked)}
        />
        Compare to previous
      </label>

      <div className="period-custom">
        <label>
          From
          <input
            type="date"
            value={customStart}
            onChange={(event) => setCustomStart(event.target.value)}
          />
        </label>
        <label>
          To
          <input
            type="date"
            value={customEnd}
            onChange={(event) => setCustomEnd(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="period-custom__apply"
          disabled={!customStart || !customEnd || customStart > customEnd}
          onClick={() => setCustomRange(customStart, customEnd)}
        >
          Apply
        </button>
      </div>
    </div>
  );
}
