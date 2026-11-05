/**
 * API playground (DataFast's Docs → API → Playground): pick an endpoint, set the period, filters
 * and other parameters, send the request with your dashboard session and see the JSON, plus the
 * equivalent curl command for a `df_` website key.
 */
import { useState } from "react";
import { Button, Card, Input } from "../../components/ui";
import { useSiteId } from "./lib/hooks";
import { CodeBlock, Field, PageHeader, Select } from "./lib/ui";

interface EndpointDef {
  path: string;
  label: string;
  /** Default extra parameters (one `key=value` per line). */
  params?: string;
  /** No date range (realtime, metadata). */
  noRange?: boolean;
}

const ENDPOINTS: Array<{ group: string; items: EndpointDef[] }> = [
  {
    group: "Analytics",
    items: [
      { path: "/api/v1/analytics/overview", label: "Overview" },
      {
        path: "/api/v1/analytics/timeseries",
        label: "Time series",
        params: "interval=day\nfields=visitors,revenue",
      },
      { path: "/api/v1/analytics/metadata", label: "Metadata", noRange: true },
      { path: "/api/v1/analytics/realtime", label: "Realtime", noRange: true },
      { path: "/api/v1/analytics/realtime/map", label: "Realtime map", noRange: true },
      { path: "/api/v1/analytics/goals", label: "Goals" },
      {
        path: "/api/v1/analytics/goals/properties",
        label: "Goal properties",
        params: "eventName=signup",
      },
      { path: "/api/v1/analytics/heatmap", label: "Heatmap" },
    ],
  },
  {
    group: "Breakdowns",
    items: [
      "pages",
      "entry-pages",
      "exit-pages",
      "exit-clicks",
      "referrers",
      "channels",
      "campaigns",
      "countries",
      "regions",
      "cities",
      "devices",
      "browsers",
      "operating-systems",
      "hostnames",
    ].map((b) => ({ path: `/api/v1/analytics/${b}`, label: b, params: "limit=10" })),
  },
  {
    group: "Revenue",
    items: [
      { path: "/api/v1/analytics/revenue", label: "Revenue summary" },
      {
        path: "/api/v1/analytics/revenue/sources",
        label: "Revenue by source",
        params: "groupBy=channel",
      },
      { path: "/api/v1/analytics/revenue/mrr", label: "MRR", noRange: true },
      { path: "/api/v1/payments", label: "Payments", params: "limit=10" },
    ],
  },
  {
    group: "Visitors and mentions",
    items: [
      { path: "/api/v1/visitors", label: "Visitors", params: "limit=10" },
      { path: "/api/v1/mentions", label: "Mentions" },
    ],
  },
];

const ALL = ENDPOINTS.flatMap((g) => g.items);
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

export function buildQuery(
  def: EndpointDef,
  range: { startAt: string; endAt: string },
  extra: string,
): URLSearchParams {
  const q = new URLSearchParams();
  if (!def.noRange && range.startAt && range.endAt) {
    q.set("startAt", range.startAt);
    q.set("endAt", range.endAt);
  }
  for (const line of extra.split(/\n|&/)) {
    const t = line.trim();
    if (!t) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    q.set(t.slice(0, i).trim(), t.slice(i + 1).trim());
  }
  return q;
}

export default function ApiPlaygroundPage() {
  const siteId = useSiteId();
  const [path, setPath] = useState(ALL[0]?.path ?? "");
  const def = ALL.find((e) => e.path === path) ?? (ALL[0] as EndpointDef);
  const [startAt, setStartAt] = useState(daysAgo(6));
  const [endAt, setEndAt] = useState(today());
  const [extra, setExtra] = useState(def.params ?? "");
  const [result, setResult] = useState<{ status: number; ms: number; body: string } | null>(null);
  const [pending, setPending] = useState(false);
  const q = buildQuery(def, { startAt, endAt }, extra);
  const publicQuery = q.toString();
  const origin = window.location.origin;
  const curl = `curl "${origin}${def.path}${publicQuery ? `?${publicQuery}` : ""}" \\\n  -H "Authorization: Bearer df_YOUR_WEBSITE_KEY"`;

  const send = async () => {
    setPending(true);
    const withSite = new URLSearchParams(q);
    withSite.set("websiteId", siteId);
    const started = performance.now();
    try {
      const res = await fetch(`${def.path}?${withSite.toString()}`, {
        credentials: "same-origin",
        headers: { accept: "application/json" },
      });
      const text = await res.text();
      let body = text;
      try {
        body = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        // not JSON
      }
      setResult({ status: res.status, ms: Math.round(performance.now() - started), body });
    } catch (err) {
      setResult({ status: 0, ms: 0, body: err instanceof Error ? err.message : String(err) });
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="API playground"
        description="Try the analytics API on this website without writing code. Requests use your dashboard session; scripts use a df_ website key or a dft_ account token (API keys page)."
      />
      <Card title="Request">
        <div className="space-y-3 text-sm">
          <Field label="Endpoint">
            <Select
              value={path}
              onChange={(e) => {
                setPath(e.target.value);
                setExtra(ALL.find((x) => x.path === e.target.value)?.params ?? "");
                setResult(null);
              }}
            >
              {ENDPOINTS.map((g) => (
                <optgroup key={g.group} label={g.group}>
                  {g.items.map((e) => (
                    <option key={e.path} value={e.path}>
                      {e.label} · GET {e.path}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
          </Field>
          {def.noRange ? null : (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="startAt">
                <Input type="date" value={startAt} onChange={(e) => setStartAt(e.target.value)} />
              </Field>
              <Field label="endAt">
                <Input type="date" value={endAt} onChange={(e) => setEndAt(e.target.value)} />
              </Field>
            </div>
          )}
          <Field
            label="Parameters"
            hint="One key=value per line: fields, interval, limit, offset, timezone, filter_country=US, filter_page=contains:/blog …"
          >
            <textarea
              value={extra}
              rows={4}
              spellCheck={false}
              onChange={(e) => setExtra(e.target.value)}
              className="w-full rounded-md border border-line bg-surface px-3 py-2 font-mono text-xs"
            />
          </Field>
          <Button onClick={send} disabled={pending}>
            {pending ? "Sending…" : "Send request"}
          </Button>
          <CodeBlock code={curl} label="curl command" wrap />
        </div>
      </Card>
      {result ? (
        <Card title="Response">
          <p className="mb-2 text-xs text-muted" data-testid="playground-status">
            HTTP {result.status} · {result.ms} ms
          </p>
          <CodeBlock code={result.body} label="response" />
        </Card>
      ) : null}
    </div>
  );
}
