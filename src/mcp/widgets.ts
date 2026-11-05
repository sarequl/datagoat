/**
 * Interactive charts for MCP clients that render UI (DataFast's ChatGPT app widgets): one
 * self-contained HTML view that draws a tool's result as a traffic/revenue chart, a breakdown bar
 * list, a funnel or a live visitor dot map.
 *
 * It is offered twice, with the same HTML:
 * - `ui://datagoat/chart.html` (`text/html;profile=mcp-app`, the MCP Apps extension), referenced
 *   from tools with `_meta.ui.resourceUri`. The view talks to the host over `postMessage`
 *   JSON-RPC (`ui/initialize`, then `ui/notifications/tool-result`).
 * - `ui://datagoat/chart.skybridge.html` (`text/html+skybridge`, the OpenAI Apps SDK), referenced
 *   with `_meta["openai/outputTemplate"]`; ChatGPT puts the result in `window.openai.toolOutput`.
 *
 * The view receives only the tool's structured result (the same JSON the model sees): never a
 * token. It loads nothing from the network (inline script and SVG), so it needs no CSP domains.
 */

export const WIDGET_URI = "ui://datagoat/chart.html";
export const WIDGET_SKYBRIDGE_URI = "ui://datagoat/chart.skybridge.html";
export const MCP_APP_MIME = "text/html;profile=mcp-app";
export const SKYBRIDGE_MIME = "text/html+skybridge";

/** Tools whose results the chart view can draw. */
export const WIDGET_TOOLS = new Set([
  "analytics_timeseries",
  "analytics_pages",
  "analytics_entry_pages",
  "analytics_exit_pages",
  "analytics_exit_clicks",
  "analytics_referrers",
  "analytics_channels",
  "analytics_campaigns",
  "analytics_countries",
  "analytics_regions",
  "analytics_cities",
  "analytics_devices",
  "analytics_browsers",
  "analytics_operating_systems",
  "analytics_hostnames",
  "analytics_goals_breakdown",
  "analytics_goal_properties",
  "analytics_funnel",
  "analytics_realtime_map",
]);

/** `_meta` added to a widget tool in tools/list. */
export function widgetToolMeta(): Record<string, unknown> {
  return {
    ui: { resourceUri: WIDGET_URI },
    "openai/outputTemplate": WIDGET_SKYBRIDGE_URI,
    "openai/toolInvocation/invoking": "Loading analytics…",
    "openai/toolInvocation/invoked": "Analytics ready",
    "openai/widgetAccessible": false,
  };
}

const SCRIPT = `
(function () {
  var root = document.getElementById("root");
  var LABEL_KEYS = ["channel", "referrer", "goal", "path", "page", "url", "country", "region", "city",
    "device", "browser", "operating_system", "hostname", "value", "name", "utm_source", "utm_medium",
    "utm_campaign", "utm_term", "utm_content", "ref", "source", "via"];
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function num(n) { return Number(n || 0).toLocaleString("en-US"); }
  function money(n, cur) {
    try {
      return Number(n || 0).toLocaleString("en-US", { style: "currency", currency: cur || "USD", maximumFractionDigits: 0 });
    } catch (e) { return num(n); }
  }
  function campaignLabel(r) {
    var c = r.campaign || {};
    var parts = [];
    for (var k in c) if (c[k]) parts.push(c[k]);
    return parts.join(" / ");
  }
  function labelOf(r) {
    if (r.campaign) return campaignLabel(r) || "(none)";
    for (var i = 0; i < LABEL_KEYS.length; i++) {
      var k = LABEL_KEYS[i];
      if (typeof r[k] === "string") return r[k] || "(none)";
    }
    for (var key in r) if (typeof r[key] === "string") return r[key];
    return "(row)";
  }
  function timeseries(rows, out) {
    var w = 560, h = 200, pad = 28;
    var vis = rows.map(function (r) { return Number(r.visitors || 0); });
    var rev = rows.map(function (r) { return Math.max(0, Number(r.revenue || 0)); });
    var vmax = Math.max.apply(null, [1].concat(vis));
    var rmax = Math.max.apply(null, [1].concat(rev));
    var step = (w - pad * 2) / Math.max(1, rows.length - 1);
    var bw = Math.max(2, ((w - pad * 2) / Math.max(1, rows.length)) * 0.6);
    var bars = "", line = "";
    rows.forEach(function (r, i) {
      var x = pad + i * step;
      if (out.revenue && rev[i] > 0) {
        var bh = (rev[i] / rmax) * (h - pad * 2);
        bars += '<rect class="rev" x="' + (x - bw / 2).toFixed(1) + '" y="' + (h - pad - bh).toFixed(1) +
          '" width="' + bw.toFixed(1) + '" height="' + bh.toFixed(1) + '" rx="2"><title>' +
          esc(r.name || r.timestamp) + ": " + money(rev[i], out.currency) + "</title></rect>";
      }
      var y = h - pad - (vis[i] / vmax) * (h - pad * 2);
      line += (i ? "L" : "M") + x.toFixed(1) + "," + y.toFixed(1);
    });
    var first = rows[0] ? (rows[0].name || rows[0].timestamp) : "";
    var last = rows.length ? (rows[rows.length - 1].name || rows[rows.length - 1].timestamp) : "";
    var t = out.totals || {};
    return '<div class="kpis"><div><span>Visitors</span><b>' + num(t.visitors != null ? t.visitors : vis.reduce(function (a, b) { return a + b; }, 0)) +
      "</b></div>" + (out.revenue ? "<div><span>Revenue</span><b>" + money(t.revenue != null ? t.revenue : rev.reduce(function (a, b) { return a + b; }, 0), out.currency) + "</b></div>" : "") +
      '</div><svg viewBox="0 0 ' + w + " " + h + '" role="img" aria-label="Visitors' + (out.revenue ? " and revenue" : "") + ' over time">' +
      bars + '<path class="vis" d="' + line + '"/></svg><div class="axis"><span>' + esc(first) + "</span><span>" + esc(last) + "</span></div>";
  }
  function breakdown(rows, out) {
    var key = rows[0] && rows[0].completions != null && rows[0].visitors == null ? "completions" : "visitors";
    var max = Math.max.apply(null, [1].concat(rows.map(function (r) { return Number(r[key] || 0); })));
    var html = '<ul class="rows">';
    rows.slice(0, 15).forEach(function (r) {
      var pct = (Number(r[key] || 0) / max) * 100;
      html += '<li><span class="bar" style="width:' + pct.toFixed(1) + '%"></span><span class="lbl">' + esc(labelOf(r)) +
        '</span><span class="val">' + num(r[key]) + "</span>" +
        (r.revenue != null ? '<span class="money">' + money(r.revenue, out.currency) + "</span>" : "") + "</li>";
    });
    return html + "</ul>";
  }
  function funnel(f) {
    var steps = f.data || [];
    var max = Math.max.apply(null, [1].concat(steps.map(function (s) { return Number(s.value || 0); })));
    var html = "<h2>" + esc(f.funnel && f.funnel.name) + '</h2><ol class="rows">';
    steps.forEach(function (s, i) {
      html += '<li><span class="bar" style="width:' + ((Number(s.value || 0) / max) * 100).toFixed(1) +
        '%"></span><span class="lbl">' + (i + 1) + ". " + esc(s.label) + '</span><span class="val">' + num(s.value) +
        '</span><span class="money">' + Number(s.conversionRate || 0).toFixed(1) + "%</span></li>";
    });
    return html + "</ol>";
  }
  function liveMap(m) {
    var w = 560, h = 280;
    var dots = (m.visitors || []).filter(function (v) { return v.latitude != null && v.longitude != null; })
      .map(function (v) {
        var x = ((v.longitude + 180) / 360) * w, y = ((90 - v.latitude) / 180) * h;
        return '<circle class="' + (v.isCustomer ? "cust" : "dot") + '" cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) +
          '" r="4"><title>' + esc((v.location && (v.location.city || v.location.countryCode)) || "Visitor") + "</title></circle>";
      }).join("");
    var grid = "";
    for (var gx = 1; gx < 6; gx++) grid += '<line x1="' + (gx * w / 6) + '" y1="0" x2="' + (gx * w / 6) + '" y2="' + h + '"/>';
    for (var gy = 1; gy < 3; gy++) grid += '<line x1="0" y1="' + (gy * h / 3) + '" x2="' + w + '" y2="' + (gy * h / 3) + '"/>';
    return '<div class="kpis"><div><span>Visitors online</span><b>' + num(m.count) + '</b></div></div><svg class="map" viewBox="0 0 ' + w + " " + h +
      '" role="img" aria-label="Live visitors by location"><g class="grid">' + grid + "</g>" + dots + "</svg>";
  }
  function render(result) {
    if (!result || typeof result !== "object") return;
    if (result.error) { root.innerHTML = '<p class="muted">' + esc(result.error.message || "Error") + "</p>"; return; }
    var data = result.data;
    var html;
    if (Array.isArray(data) && data[0] && data[0].funnel) html = funnel(data[0]);
    else if (data && !Array.isArray(data) && Array.isArray(data.visitors)) html = liveMap(data);
    else if (Array.isArray(data) && data[0] && data[0].timestamp) {
      html = timeseries(data, { totals: result.totals, currency: result.currency,
        revenue: data.some(function (r) { return r.revenue != null; }) });
    } else if (Array.isArray(data) && data.length) {
      html = breakdown(data, { currency: result.currency || (data[0] && data[0].currency) });
    } else html = '<p class="muted">No data for this period.</p>';
    root.innerHTML = html;
    root.setAttribute("data-rendered", "true");
  }
  window.datagoatRender = render;
  // OpenAI Apps SDK (ChatGPT): the result is a global, updated with an event.
  if (window.openai && window.openai.toolOutput) render(window.openai.toolOutput);
  window.addEventListener("openai:set_globals", function () {
    if (window.openai && window.openai.toolOutput) render(window.openai.toolOutput);
  });
  // MCP Apps: JSON-RPC over postMessage with the host.
  window.addEventListener("message", function (e) {
    var msg = e.data;
    if (!msg || msg.jsonrpc !== "2.0") return;
    if (msg.id === 1 && msg.result) {
      window.parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} }, "*");
    }
    if (msg.method === "ui/notifications/tool-result" && msg.params) {
      render(msg.params.structuredContent || msg.params);
    }
  });
  if (window.parent && window.parent !== window) {
    window.parent.postMessage({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: {
      protocolVersion: "2025-11-21", appInfo: { name: "DataGoat", version: "1" }, appCapabilities: {} } }, "*");
  }
})();
`;

const STYLE = `
:root { color-scheme: light dark; --fg: #262626; --muted: #5c5c5c; --bar: rgba(59,130,246,.14);
  --vis: #2f7fd8; --rev: #e16540; --line: rgba(0,0,0,.08); }
@media (prefers-color-scheme: dark) { :root { --fg: #dedddc; --muted: #a3a3a3;
  --bar: rgba(141,205,255,.16); --vis: #8dcdff; --rev: #e78468; --line: rgba(255,255,255,.1); } }
body { margin: 0; font: 13px/1.4 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  color: var(--fg); background: transparent; }
#root { padding: 12px; }
h2 { font-size: 14px; margin: 0 0 8px; }
svg { width: 100%; height: auto; display: block; }
.vis { fill: none; stroke: var(--vis); stroke-width: 2; stroke-linejoin: round; }
.rev { fill: var(--rev); opacity: .85; }
.kpis { display: flex; gap: 24px; margin-bottom: 8px; }
.kpis span { display: block; color: var(--muted); font-size: 12px; }
.kpis b { font-size: 20px; font-variant-numeric: tabular-nums; }
.axis { display: flex; justify-content: space-between; color: var(--muted); font-size: 11px; }
.rows { list-style: none; margin: 0; padding: 0; }
.rows li { position: relative; display: flex; gap: 8px; padding: 5px 8px; border-radius: 4px; }
.rows .bar { position: absolute; inset: 0 auto 0 0; background: var(--bar); border-radius: 4px; }
.rows .lbl { position: relative; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rows .val, .rows .money { position: relative; font-variant-numeric: tabular-nums; }
.rows .money { color: var(--rev); min-width: 64px; text-align: right; }
.map { border: 1px solid var(--line); border-radius: 8px; }
.grid line { stroke: var(--line); }
.dot { fill: var(--vis); opacity: .85; } .cust { fill: var(--rev); }
.muted { color: var(--muted); }
`;

export const WIDGET_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>DataGoat</title><style>${STYLE}</style></head>
<body><div id="root" class="muted">Loading…</div><script>${SCRIPT}</script></body></html>`;

const RESOURCE_META = {
  "openai/widgetDescription":
    "An interactive chart of the DataGoat analytics the tool returned (traffic and revenue over time, a breakdown, a funnel or live visitors).",
  "openai/widgetPrefersBorder": true,
  ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } },
};

export function listWidgetResources() {
  return [
    {
      uri: WIDGET_URI,
      name: "datagoat-chart",
      title: "DataGoat chart",
      description: "Interactive chart for analytics tool results (MCP Apps).",
      mimeType: MCP_APP_MIME,
    },
    {
      uri: WIDGET_SKYBRIDGE_URI,
      name: "datagoat-chart-chatgpt",
      title: "DataGoat chart (ChatGPT)",
      description: "Interactive chart for analytics tool results (OpenAI Apps SDK).",
      mimeType: SKYBRIDGE_MIME,
    },
  ];
}

export function readWidgetResource(uri: string) {
  if (uri !== WIDGET_URI && uri !== WIDGET_SKYBRIDGE_URI) return null;
  return {
    contents: [
      {
        uri,
        mimeType: uri === WIDGET_URI ? MCP_APP_MIME : SKYBRIDGE_MIME,
        text: WIDGET_HTML,
        _meta: RESOURCE_META,
      },
    ],
  };
}
