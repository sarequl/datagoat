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
import type { FunnelStepResult } from '../api/types';
import { useTheme } from '../hooks/useTheme';
import { formatCurrency, formatNumber, formatPercent } from '../utils/format';

Chart.register(BarController, BarElement, CategoryScale, LinearScale, Tooltip, Legend);

function readColors() {
  const styles = getComputedStyle(document.documentElement);
  return {
    bars: styles.getPropertyValue('--chart-1').trim() || '#0072b2',
    grid: styles.getPropertyValue('--color-border').trim() || '#dfe3e8',
    text: styles.getPropertyValue('--color-text-muted').trim() || '#5c6570',
  };
}

function summarize(steps: FunnelStepResult[]): string {
  const parts = steps.map(
    (step) =>
      `${step.name}: ${step.visitors} visitors, ${formatPercent(step.conversionRate)} conversion`,
  );
  return `Funnel steps. ${parts.join(', ')}.`;
}

interface FunnelChartProps {
  steps: FunnelStepResult[];
  currency: string;
}

export function FunnelChart({ steps, currency }: FunnelChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);
  const { theme } = useTheme();

  // biome-ignore lint/correctness/useExhaustiveDependencies: theme changes the CSS colors the chart reads
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const colors = readColors();
    const config: ChartConfiguration<'bar', number[], string> = {
      type: 'bar',
      data: {
        labels: steps.map((step) => step.name),
        datasets: [
          {
            label: 'Visitors',
            data: steps.map((step) => step.visitors),
            backgroundColor: colors.bars,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (context) => {
                const step = steps[context.dataIndex];
                return ` ${formatNumber(step.visitors)} visitors · ${formatPercent(
                  step.conversionRate,
                )} conversion · ${formatCurrency(step.revenue, currency)}`;
              },
            },
          },
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: colors.text } },
          y: { beginAtZero: true, grid: { color: colors.grid }, ticks: { color: colors.text } },
        },
      },
    };

    chartRef.current?.destroy();
    chartRef.current = new Chart(canvas, config);

    return () => {
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, [steps, currency, theme]);

  return (
    <div className="funnel-chart">
      <canvas ref={canvasRef} role="img" aria-label={summarize(steps)} />
      <table className="visually-hidden">
        <caption>Funnel steps</caption>
        <thead>
          <tr>
            <th scope="col">Step</th>
            <th scope="col">Visitors</th>
            <th scope="col">Conversion</th>
            <th scope="col">Revenue</th>
          </tr>
        </thead>
        <tbody>
          {steps.map((step) => (
            <tr key={step.step}>
              <th scope="row">{step.name}</th>
              <td>{step.visitors}</td>
              <td>{formatPercent(step.conversionRate)}</td>
              <td>{formatCurrency(step.revenue, currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
