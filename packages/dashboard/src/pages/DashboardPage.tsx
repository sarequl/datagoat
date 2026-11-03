import { Skeleton } from '../components/Skeleton';

const KPI_PLACEHOLDERS = ['Visitors', 'Revenue', 'Conversion', 'Revenue / visitor'];

export function DashboardPage() {
  return (
    <section aria-label="Overview">
      <h1>Overview</h1>
      <div className="kpi-grid">
        {KPI_PLACEHOLDERS.map((label) => (
          <div className="kpi-card" key={label}>
            <span className="kpi-card__label">{label}</span>
            <Skeleton className="kpi-card__value" />
          </div>
        ))}
      </div>
    </section>
  );
}
