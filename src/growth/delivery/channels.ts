/**
 * Telegram and webhook delivery.
 *
 * Telegram Bot API `sendMessage` (https://core.telegram.org/bots/api#sendmessage): free, needs only
 * a bot token from @BotFather and the chat id. Errors come back as `{ok: false, description}`;
 * 429 answers carry `parameters.retry_after`.
 *
 * Webhooks: `POST <url>` with a JSON body and `X-DataGoat-Signature: t=<unix>,v1=<hex>` where v1 is
 * HMAC-SHA256(secret, "<t>.<raw body>"), the same construction Stripe uses, so receivers can
 * verify origin and freshness.
 */
import { hmacSha256Hex } from "../../lib/crypto";
import { type Fetcher, ProviderError, requestJson } from "../shared/http";

export async function sendTelegram(
  fetcher: Fetcher,
  botToken: string,
  chatId: string,
  text: string,
): Promise<void> {
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(botToken)) {
    throw new ProviderError("Telegram", 400, "Telegram: invalid bot token");
  }
  try {
    const res = await requestJson<{ ok?: boolean; description?: string }>(
      fetcher,
      "Telegram",
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: "POST",
        json: { chat_id: chatId, text: text.slice(0, 4096), disable_web_page_preview: true },
      },
    );
    if (res && res.ok === false) {
      throw new ProviderError("Telegram", 400, `Telegram: ${res.description ?? "send failed"}`);
    }
  } catch (err) {
    // Never echo the bot token (it is part of the URL) in stored errors.
    if (err instanceof ProviderError) {
      throw new ProviderError(
        err.provider,
        err.status,
        err.message.split(botToken).join("<token>"),
        err.retryAfter,
      );
    }
    throw err;
  }
}

export function isAllowedWebhookUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  // Workers cannot reach private networks, but refuse obvious internal targets anyway.
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal"))
    return false;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  if (host.startsWith("[")) return false;
  return true;
}

export async function webhookSignature(secret: string, timestamp: number, body: string) {
  return `t=${timestamp},v1=${await hmacSha256Hex(secret, `${timestamp}.${body}`)}`;
}

export async function sendWebhook(
  fetcher: Fetcher,
  url: string,
  secret: string | null,
  payload: unknown,
  nowMs: number,
): Promise<void> {
  if (!isAllowedWebhookUrl(url))
    throw new ProviderError("Webhook", 400, "Webhook: URL not allowed");
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "DataGoat-Webhooks/1.0",
  };
  if (secret)
    headers["x-datagoat-signature"] = await webhookSignature(
      secret,
      Math.floor(nowMs / 1000),
      body,
    );
  let res: Response;
  try {
    res = await fetcher(url, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new ProviderError(
      "Webhook",
      0,
      `Webhook: request failed (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  await res.body?.cancel();
  if (res.status < 200 || res.status >= 300) {
    throw new ProviderError("Webhook", res.status, `Webhook: endpoint answered HTTP ${res.status}`);
  }
}
