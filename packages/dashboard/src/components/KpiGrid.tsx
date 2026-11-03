import type { Overview, OverviewMetrics } from '../api/types';
import { computeDelta, type Delta } from '../utils/deltas';
import { formatCurrency, formatDuration, formatNumber, formatPercent } from '../utils/format';
import { KpiCard } from './KpiCard';

const EMPTY_METRICS: OverviewMetrics = {
  visitors: 0,
  sessions: 0,
  pageviews: 0,
  bounceRate: 0,
  avgSessionDuration: 0,
  currency: 'USD',
  revenue: 0,
  payments: 0,
  revenuePerVisitor: 0,
  conversionRate: 0,
};

interface CardDefinition {
  label: string;
  pick: (metrics: OverviewMetrics) => number;
  format: (value: number, currency: string) => string;
  betterWhen: 'up' | 'down';
  tooltip: string;
}

const CARDS: CardDefinition[] = [
  {
    label: 'Visitors',
    pick: (m) => m.visitors,
    format: (v) => formatNumber(v),
    betterWhen: 'up',
    tooltip: 'Unique visitors in the selected period.',
  },
  {
    label: 'Pageviews',
    pick: (m) => m.pageviews,
    format: (v) => formatNumber(v),
    betterWhen: 'up',
    tooltip: 'Total page views in the selected period.',
  },
  {
    label: 'Sessions',
    pick: (m) => m.sessions,
    format: (v) => formatNumber(v),
    betterWhen: 'up',
    tooltip: 'Sessions in the selected period.',
  },
  {
    label: 'Revenue (est.)',
    pick: (m) => m.revenue,
    format: (v, currency) => formatCurrency(v, currency),
    betterWhen: 'up',
    tooltip: 'Attributed revenue. An estimate, not booked revenue.',
  },
  {
    label: 'Payments',
    pick: (m) => m.payments,
    format: (v) => formatNumber(v),
    betterWhen: 'up',
    tooltip: 'Payments attributed in the selected period.',
  },
  {
    label: 'Conversion rate',
    pick: (m) => m.conversionRate,
    format: (v) => formatPercent(v),
    betterWhen: 'up',
    tooltip: 'Share of visitors who completed a goal or payment.',
  },
  {
    label: 'Revenue / visitor',
    pick: (m) => m.revenuePerVisitor,
    format: (v, currency) => formatCurrency(v, currency),
    betterWhen: 'up',
    tooltip: 'Attributed revenue divided by visitors.',
  },
  {
    label: 'Bounce rate',
    pick: (m) => m.bounceRate,
    format: (v) => formatPercent(v),
    betterWhen: 'down',
    tooltip: 'Share of sessions with a single pageview.',
  },
  {
    label: 'Avg. session duration',
    pick: (m) => m.avgSessionDuration,
    format: (v) => formatDuration(v),
    betterWhen: 'up',
    tooltip: 'Average session length in seconds.',
  },
];

interface KpiGridProps {
  overview?: Overview;
  currency: string;
  loading?: boolean;
}

export function KpiGrid({ overview, currency, loading = false }: KpiGridProps) {
  const metrics = overview ?? EMPTY_METRICS;
  const previous = overview?.previous;

  return (
    <div className="kpi-grid">
      {CARDS.map((card) => {
        const value = card.pick(metrics);
        const delta: Delta | undefined = previous
          ? computeDelta(value, card.pick(previous))
          : undefined;
        return (
          <KpiCard
            key={card.label}
            label={card.label}
            value={value}
            delta={delta}
            format={(v) => card.format(v, currency)}
            betterWhen={card.betterWhen}
            tooltip={card.tooltip}
            loading={loading}
          />
        );
      })}
    </div>
  );
}
