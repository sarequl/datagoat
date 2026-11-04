/**
 * Message templates. Alert templates are plain text with `{{variable}}` placeholders (unknown
 * names render empty), so an operator can write "New sale from {{country}} via {{referrer}}".
 * HTML emails share one small, inline-styled layout using the dashboard palette.
 */
import { currencyExponent } from "../../lib/money";

export type TemplateVars = Record<string, string | number | null | undefined>;

export const TEMPLATE_VARIABLES = [
  "website",
  "domain",
  "goal",
  "amount",
  "currency",
  "kind",
  "country",
  "city",
  "region",
  "device",
  "browser",
  "os",
  "referrer",
  "source",
  "channel",
  "page",
  "utm_source",
  "utm_campaign",
  "visitor_id",
  "visitors",
  "baseline",
  "time",
  "dashboard_url",
  "summary",
] as const;

export function renderTemplate(template: string, vars: TemplateVars): string {
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, name: string) => {
    const v = vars[name.toLowerCase()];
    return v === null || v === undefined ? "" : String(v);
  });
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Plain text → minimal HTML paragraphs (escaped). */
export function textToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 12px">${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

export function emailLayout(options: {
  title: string;
  bodyHtml: string;
  footer?: string;
  actionUrl?: string | null;
  actionLabel?: string;
}): string {
  const action = options.actionUrl
    ? `<p style="margin:20px 0 0"><a href="${escapeHtml(options.actionUrl)}" style="display:inline-block;background:#e16540;color:#171717;text-decoration:none;font-weight:600;padding:10px 16px;border-radius:6px">${escapeHtml(options.actionLabel ?? "Open dashboard")}</a></p>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(options.title)}</title></head>
<body style="margin:0;padding:24px;background:#fcfbfa;color:#262626;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.5">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid rgba(0,0,0,.08);border-radius:10px;padding:24px">
<h1 style="margin:0 0 16px;font-size:18px">${escapeHtml(options.title)}</h1>
${options.bodyHtml}${action}
</div>
<p style="max-width:560px;margin:12px auto 0;color:#5c5c5c;font-size:12px">${escapeHtml(options.footer ?? "Sent by your DataGoat analytics.")}</p>
</body></html>`;
}

export function formatMoney(amountMinor: number, currency: string): string {
  const exponent = currencyExponent(currency);
  const major = amountMinor / 10 ** exponent;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(major);
  } catch {
    return `${major.toFixed(exponent)} ${currency}`;
  }
}
