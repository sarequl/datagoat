/**
 * Transactional email through an operator-supplied provider HTTP API (plan §15):
 *
 * - Resend: `POST https://api.resend.com/emails` with `Authorization: Bearer <RESEND_API_KEY>`
 *   (https://resend.com/docs/api-reference/emails/send-email). Supports `Idempotency-Key`.
 * - Postmark: `POST https://api.postmarkapp.com/email` with `X-Postmark-Server-Token`
 *   (https://postmarkapp.com/developer/api/email-api).
 *
 * EMAIL_FROM is required with either. Without a provider, email features are reported as not
 * configured and the dashboard hides email destinations.
 */
import { type Fetcher, ProviderError, requestJson } from "../shared/http";

export interface EmailMessage {
  to: string[];
  subject: string;
  text: string;
  html?: string;
  /** Stable key so a retried delivery is not sent twice (Resend honours it for 24 h). */
  idempotencyKey?: string;
}

export type EmailProvider = "resend" | "postmark";

export function emailProvider(env: Cloudflare.Env): EmailProvider | null {
  if (!env.EMAIL_FROM?.trim()) return null;
  if (env.RESEND_API_KEY?.trim()) return "resend";
  if (env.POSTMARK_SERVER_TOKEN?.trim()) return "postmark";
  return null;
}

export function emailConfigured(env: Cloudflare.Env): boolean {
  return emailProvider(env) !== null;
}

export async function sendEmail(
  env: Cloudflare.Env,
  fetcher: Fetcher,
  message: EmailMessage,
): Promise<{ id: string | null }> {
  const provider = emailProvider(env);
  const from = env.EMAIL_FROM?.trim() ?? "";
  if (!provider) throw new ProviderError("Email", 424, "Email is not configured on this server");
  if (message.to.length === 0) throw new ProviderError("Email", 400, "Email has no recipients");
  if (provider === "resend") {
    const headers: Record<string, string> = {
      authorization: `Bearer ${env.RESEND_API_KEY?.trim()}`,
    };
    if (message.idempotencyKey) headers["idempotency-key"] = message.idempotencyKey.slice(0, 256);
    const res = await requestJson<{ id?: string }>(
      fetcher,
      "Resend",
      "https://api.resend.com/emails",
      {
        method: "POST",
        headers,
        json: {
          from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          ...(message.html ? { html: message.html } : {}),
        },
      },
    );
    return { id: res?.id ?? null };
  }
  const res = await requestJson<{ MessageID?: string; ErrorCode?: number; Message?: string }>(
    fetcher,
    "Postmark",
    "https://api.postmarkapp.com/email",
    {
      method: "POST",
      headers: { "x-postmark-server-token": env.POSTMARK_SERVER_TOKEN?.trim() ?? "" },
      json: {
        From: from,
        To: message.to.join(", "),
        Subject: message.subject,
        TextBody: message.text,
        ...(message.html ? { HtmlBody: message.html } : {}),
        MessageStream: "outbound",
      },
    },
  );
  if (res?.ErrorCode)
    throw new ProviderError("Postmark", 422, `Postmark: ${res.Message ?? "error"}`);
  return { id: res?.MessageID ?? null };
}
