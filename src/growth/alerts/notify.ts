/** Turning an alert rule plus event variables into an outbox payload for its channel. */
import type { Site } from "../../lib/sites";
import type { AlertRef, OutboxPayload } from "../delivery/outbox";
import { emailLayout, renderTemplate, type TemplateVars, textToHtml } from "../delivery/templates";
import { dashboardUrl } from "../shared/site-info";
import { type AlertRow, defaultTemplate, destinationOf, triggerOf } from "./model";

export const DEFAULT_DAILY_LIMIT = 100;

export function alertLimit(env: Cloudflare.Env): number {
  const n = Number.parseInt(env.ALERT_DAILY_LIMIT ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DAILY_LIMIT;
}

export function siteLabel(site: Pick<Site, "name" | "domain">): string {
  return site.name?.trim() || site.domain;
}

/** Variables every template can use. */
export function baseVars(
  site: Pick<Site, "id" | "name" | "domain">,
  base: string | null,
  page = "overview",
): TemplateVars {
  return {
    website: siteLabel(site),
    domain: site.domain,
    dashboard_url: dashboardUrl(base, site.id, page),
  };
}

/** Plausible example values for test sends and previews. */
export function sampleVars(
  row: AlertRow,
  site: Pick<Site, "id" | "name" | "domain" | "currency">,
  base: string | null,
): TemplateVars {
  return {
    ...baseVars(site, base),
    goal: triggerOf(row).goalName ?? "signup",
    amount: "$49.00",
    currency: site.currency,
    kind: "payment",
    country: "United States",
    city: "San Francisco",
    region: "California",
    device: "desktop",
    browser: "Chrome",
    os: "Mac OS",
    referrer: "Google",
    source: "Google",
    channel: "Organic Search",
    page: "/pricing",
    utm_source: "",
    utm_campaign: "",
    visitor_id: "00000000-0000-4000-8000-000000000000",
    visitors: 240,
    baseline: 5,
    time: new Date().toISOString(),
    summary: "This is a test notification from DataGoat.",
  };
}

export interface PayloadMeta {
  summary: string;
  visitorId: string | null;
  goalName: string | null;
  test?: boolean;
  /** Pre-rendered bodies (digests) that replace the template message. */
  text?: string;
  html?: string;
  data?: unknown;
}

export function buildPayload(
  row: AlertRow,
  site: Pick<Site, "id" | "name" | "domain">,
  vars: TemplateVars,
  ownerRecipients: string[],
  meta: PayloadMeta,
): OutboxPayload | null {
  const defaults = defaultTemplate(row.trigger_type);
  const subjectRaw = renderTemplate(row.template_subject || defaults.subject, vars).trim();
  const subject = `${meta.test ? "[Test] " : ""}${subjectRaw || defaults.subject}`.slice(0, 200);
  const message =
    meta.text ?? renderTemplate(row.template_message || defaults.message, vars).trim();
  const url = typeof vars.dashboard_url === "string" ? vars.dashboard_url : null;
  const alert: AlertRef = {
    id: meta.test ? `test:${row.id}` : row.id,
    name: row.name,
    triggerType: row.trigger_type,
    goalName: meta.goalName,
    visitorId: meta.visitorId,
    summary: meta.summary,
  };
  const dest = destinationOf(row);
  switch (row.channel) {
    case "email": {
      const to = dest.email ? [dest.email] : ownerRecipients;
      if (to.length === 0) return null;
      return {
        channel: "email",
        to,
        subject,
        text: url ? `${message}\n\n${url}` : message,
        html:
          meta.html ??
          emailLayout({
            title: subjectRaw || subject,
            bodyHtml: textToHtml(message),
            actionUrl: url,
            footer: `You receive this because of the alert "${row.name}" on ${siteLabel(site)}.`,
          }),
        alert,
      };
    }
    case "telegram":
      if (!dest.chatId) return null;
      return {
        channel: "telegram",
        chatId: dest.chatId,
        text: [subject, message, url].filter(Boolean).join("\n\n"),
        alert,
      };
    case "webhook":
      if (!dest.url) return null;
      return {
        channel: "webhook",
        url: dest.url,
        body: {
          event: `alert.${row.trigger_type}`,
          test: meta.test === true,
          alert: {
            id: row.id,
            name: row.name,
            trigger: { type: row.trigger_type, ...triggerOf(row) },
          },
          website: { id: site.id, domain: site.domain, name: site.name },
          subject,
          message,
          data: meta.data ?? vars,
        },
        alert,
      };
  }
}
