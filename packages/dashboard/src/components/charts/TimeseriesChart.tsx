import {
  BarController,
  BarElement,
  Chart,
  type ChartConfigurationCustomTypesPerDataset,
  type ChartDatasetCustomTypesPerDataset,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  TimeScale,
  Tooltip,
} from 'chart.js';
import { useEffect, useRef } from 'react';
import 'chartjs-adapter-date-fns';
import type { Timeseries } from '../../api/types';
import { useTheme } from '../../hooks/useTheme';

Chart.register(
  BarController,
  BarElement,
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  TimeScale,
  Tooltip,
  Legend,
);

interface ChartColors {
  visitors: string;
  pageviews: string;
  revenue: string;
  grid: string;
  text: string;
}

function readColors(): ChartColors {
  const styles = getComputedStyle(document.documentElement);
  return {
    visitors: styles.getPropertyValue('--chart-1').trim() || '#0072b2',
    pageviews: styles.getPropertyValue('--chart-3').trim() || '#009e73',
    revenue: styles.getPropertyValue('--chart-2').trim() || '#e69f00',
    grid: styles.getPropertyValue('--color-border').trim() || '#dfe3e8',
    text: styles.getPropertyValue('--color-text-muted').trim() || '#5c6570',
  };
}

function summarize(data: Timeseries): string {
  const visitors = data.points.reduce((sum, point) => sum + point.visitors, 0);
  const pageviews = data.points.reduce((sum, point) => sum + point.pageviews, 0);
  const revenue = data.points.reduce((sum, point) => sum + point.revenue, 0);
  return `${data.points.length} ${data.interval} buckets. Visitors ${visitors}, pageviews ${pageviews}, revenue ${revenue.toFixed(2)}.`;
}

export function TimeseriesChart({ data, currency }: { data: Timeseries; currency: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);
  const { theme } = useTheme();

  // biome-ignore lint/correctness/useExhaustiveDependencies: theme changes the CSS colors the chart reads
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const colors = readColors();
    const labels = data.points.map((point) => point.timestamp);
    const datasets: ChartDatasetCustomTypesPerDataset<'line' | 'bar', number[]>[] = [];

    if (data.fields.includes('visitors')) {
      datasets.push({
        type: 'line',
        label: 'Visitors',
        data: data.points.map((point) => point.visitors),
        borderColor: colors.visitors,
        backgroundColor: colors.visitors,
        fill: false,
        tension: 0.3,
        pointRadius: 0,
        yAxisID: 'y',
      });
    }
    if (data.fields.includes('pageviews')) {
      datasets.push({
        type: 'line',
        label: 'Pageviews',
        data: data.points.map((point) => point.pageviews),
        borderColor: colors.pageviews,
        backgroundColor: colors.pageviews,
        fill: false,
        tension: 0.3,
        pointRadius: 0,
        yAxisID: 'y',
      });
    }
    if (data.fields.includes('revenue')) {
      datasets.push({
        type: 'bar',
        label: `Revenue (${currency})`,
        data: data.points.map((point) => point.revenue),
        backgroundColor: colors.revenue,
        yAxisID: 'y1',
      });
    }

    const config: ChartConfigurationCustomTypesPerDataset<'line' | 'bar', number[], string> = {
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { labels: { color: colors.text } },
          tooltip: {
            callbacks: {
              label: (context) => {
                const value = context.parsed.y;
                const formatted =
                  typeof value === 'number' ? value.toLocaleString('en-US') : String(value);
                return ` ${context.dataset.label ?? ''}: ${formatted}`;
              },
            },
          },
        },
        scales: {
          x: {
            type: 'time',
            time: { unit: data.interval },
            grid: { color: colors.grid },
            ticks: { color: colors.text },
          },
          y: {
            beginAtZero: true,
            grid: { color: colors.grid },
            ticks: { color: colors.text },
          },
          y1: {
            position: 'right',
            beginAtZero: true,
            grid: { drawOnChartArea: false },
            ticks: { color: colors.text },
          },
        },
      },
    };

    chartRef.current?.destroy();
    chartRef.current = new Chart(canvas, config);

    return () => {
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, [data, currency, theme]);

  return (
    <div className="chart-container">
      <canvas ref={canvasRef} role="img" aria-label={summarize(data)} />
      <table className="visually-hidden">
        <caption>Timeseries values</caption>
        <thead>
          <tr>
            <th scope="col">Time</th>
            <th scope="col">Visitors</th>
            <th scope="col">Pageviews</th>
            <th scope="col">Revenue</th>
            <th scope="col">Payments</th>
          </tr>
        </thead>
        <tbody>
          {data.points.map((point) => (
            <tr key={point.timestamp}>
              <th scope="row">{point.timestamp}</th>
              <td>{point.visitors}</td>
              <td>{point.pageviews}</td>
              <td>{point.revenue}</td>
              <td>{point.payments}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
