import {
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  type ChartConfiguration,
  Legend,
  LinearScale,
  Tooltip,
} from 'chart.js';
import { useEffect, useRef } from 'react';
import type { BreakdownRow } from '../api/types';
import { useTheme } from '../hooks/useTheme';

Chart.register(BarController, BarElement, CategoryScale, LinearScale, Tooltip, Legend);

const LIMIT = 10;

function readColors() {
  const styles = getComputedStyle(document.documentElement);
  return {
    bars: styles.getPropertyValue('--chart-1').trim() || '#0072b2',
    grid: styles.getPropertyValue('--color-border').trim() || '#dfe3e8',
    text: styles.getPropertyValue('--color-text-muted').trim() || '#5c6570',
  };
}

function summarize(rows: BreakdownRow[], label: string): string {
  const parts = rows.slice(0, LIMIT).map((row) => `${row.value} ${row.visitors}`);
  return `Top ${label} by visitors. ${parts.join(', ')}.`;
}

export function SourceChart({ rows, label }: { rows: BreakdownRow[]; label: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);
  const { theme } = useTheme();
  const top = rows.slice(0, LIMIT);

  // biome-ignore lint/correctness/useExhaustiveDependencies: theme changes the CSS colors the chart reads
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const colors = readColors();
    const config: ChartConfiguration<'bar', number[], string> = {
      type: 'bar',
      data: {
        labels: top.map((row) => row.value),
        datasets: [
          {
            label,
            data: top.map((row) => row.visitors),
            backgroundColor: colors.bars,
          },
        ],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (context) => ` ${(context.parsed.x ?? 0).toLocaleString('en-US')} visitors`,
            },
          },
        },
        scales: {
          x: { beginAtZero: true, grid: { color: colors.grid }, ticks: { color: colors.text } },
          y: { grid: { display: false }, ticks: { color: colors.text } },
        },
      },
    };

    chartRef.current?.destroy();
    chartRef.current = new Chart(canvas, config);

    return () => {
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, [rows, label, theme]);

  return (
    <div className="source-chart">
      <canvas ref={canvasRef} role="img" aria-label={summarize(rows, label)} />
      <table className="visually-hidden">
        <caption>Top {label} by visitors</caption>
        <thead>
          <tr>
            <th scope="col">{label}</th>
            <th scope="col">Visitors</th>
          </tr>
        </thead>
        <tbody>
          {top.map((row) => (
            <tr key={row.value}>
              <th scope="row">{row.value}</th>
              <td>{row.visitors}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
