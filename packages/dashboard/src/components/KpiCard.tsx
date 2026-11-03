import type { Delta } from '../utils/deltas';
import { formatDelta } from '../utils/format';
import { Skeleton } from './Skeleton';

interface KpiCardProps {
  label: string;
  value: number;
  delta?: Delta;
  format: (value: number) => string;
  betterWhen?: 'up' | 'down';
  tooltip?: string;
  loading?: boolean;
}

export function KpiCard({
  label,
  value,
  delta,
  format,
  betterWhen = 'up',
  tooltip,
  loading = false,
}: KpiCardProps) {
  if (loading) {
    return (
      <div className="kpi-card">
        <span className="kpi-card__label">{label}</span>
        <Skeleton className="kpi-card__value" />
      </div>
    );
  }

  const direction = delta?.direction ?? 'flat';
  const good = delta && direction !== 'flat' ? direction === betterWhen : null;

  return (
    <div className="kpi-card" title={tooltip}>
      <span className="kpi-card__label">{label}</span>
      <span className="kpi-card__value">{format(value)}</span>
      {delta && delta.change !== null ? (
        <span
          className={`kpi-card__delta${good === null ? '' : good ? ' kpi-card__delta--good' : ' kpi-card__delta--bad'}`}
        >
          <span aria-hidden="true">
            {direction === 'up' ? '▲' : direction === 'down' ? '▼' : '•'}
          </span>{' '}
          {formatDelta(delta.change)}
        </span>
      ) : delta ? (
        <span className="kpi-card__delta muted">new</span>
      ) : null}
    </div>
  );
}
