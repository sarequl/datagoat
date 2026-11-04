/**
 * Alert rules: storage ↔ API shapes and validation. The API is DataFast's
 * (`/api/v1/admin/websites/:id/alerts`, docs/api/account/alerts) with DataGoat extensions: more
 * trigger types (new sale, traffic spike, daily and weekly digests) and Telegram/webhook
 * destinations next to email.
 */
import { z } from "zod";
import type { Alert, AlertChannel, AlertTriggerType } from "../../../shared/api-types";
import { encryptString, randomBytes } from "../../lib/crypto";
import { parseJsonColumn } from "../../lib/d1";
import { toHex } from "../../lib/encoding";
import { ApiError } from "../../lib/errors";
import { toIso, toIsoOrNull } from "../../lib/time";
import { zEmail, zGoalName } from "../../lib/validate";
import { isAllowedWebhookUrl } from "../delivery/channels";

export const MAX_ALERTS_PER_SITE = 25;
export const TRIGGER_TYPES: readonly AlertTriggerType[] = [
  "goal",
  "new_sale",
  "traffic_spike",
  "daily_digest",
  "weekly_digest",
];

export interface AlertRow {
  id: string;
  site_id: string;
  name: string;
  trigger_type: AlertTriggerType;
  trigger: string;
  channel: AlertChannel;
  destination: string;
  secret_enc: string | null;
  template_subject: string | null;
  template_message: string | null;
  is_enabled: number;
  trigger_count: number;
  monthly_count: number;
  monthly_count_reset_at: number | null;
  daily_count: number;
  daily_count_reset_at: number | null;
  last_triggered_at: number | null;
  last_error: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface TriggerConfig {
  goalName?: string;
  multiplier?: number;
  minSessions?: number;
  includeRenewals?: boolean;
  includeFreeTrials?: boolean;
}

export interface DestinationConfig {
  email?: string;
  chatId?: string;
  url?: string;
}

export const DEFAULT_SPIKE_MULTIPLIER = 4;
export const DEFAULT_SPIKE_MIN_SESSIONS = 20;

export function triggerOf(row: Pick<AlertRow, "trigger">): TriggerConfig {
  return parseJsonColumn<TriggerConfig>(row.trigger, {});
}

export function destinationOf(row: Pick<AlertRow, "destination">): DestinationConfig {
  return parseJsonColumn<DestinationConfig>(row.destination, {});
}

const DEFAULT_MESSAGES: Record<AlertTriggerType, { subject: string; message: string }> = {
  goal: {
    subject: "{{goal}} on {{website}}",
    message: "A visitor from {{country}} completed {{goal}} on {{page}} (via {{referrer}}).",
  },
  new_sale: {
    subject: "New sale on {{website}}: {{amount}}",
    message: "New {{kind}} of {{amount}} from {{country}} via {{referrer}}.",
  },
  traffic_spike: {
    subject: "Traffic spike on {{website}}",
    message:
      "{{visitors}} sessions in the last hour on {{website}}, about {{baseline}}x the usual hourly traffic.",
  },
  daily_digest: { subject: "Your daily report for {{website}}", message: "{{summary}}" },
  weekly_digest: { subject: "Your weekly report for {{website}}", message: "{{summary}}" },
};

export function defaultTemplate(type: AlertTriggerType) {
  return DEFAULT_MESSAGES[type];
}

const dayStart = (ms: number) => Math.floor(ms / 86_400_000) * 86_400_000;
const monthStart = (ms: number) => {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
};

export interface RecentLog {
  alert_id: string;
  status: "sent" | "failed";
  error: string | null;
  visitor_id: string | null;
  triggered_at: number;
}

export function alertDto(
  row: AlertRow,
  logs: RecentLog[] = [],
  now: number = Date.now(),
  extra: { signingSecret?: string } = {},
): Alert {
  const trigger = triggerOf(row);
  const dest = destinationOf(row);
  // Counters reset lazily: a counter whose window has passed reads as 0.
  const today = dayStart(now);
  const month = monthStart(now);
  const daily = row.daily_count_reset_at === today ? row.daily_count : 0;
  const monthly = row.monthly_count_reset_at === month ? row.monthly_count : 0;
  const destination: Alert["destination"] = { type: row.channel };
  if (row.channel === "email" && dest.email) destination.email = dest.email;
  if (row.channel === "telegram") {
    destination.chatId = dest.chatId;
    destination.hasBotToken = row.secret_enc !== null;
  }
  if (row.channel === "webhook") {
    destination.url = dest.url;
    if (extra.signingSecret) destination.signingSecret = extra.signingSecret;
  }
  const dto: Alert = {
    id: row.id,
    websiteId: row.site_id,
    name: row.name,
    trigger: { type: row.trigger_type, ...trigger },
    destination,
    template: {
      ...(row.template_subject ? { subject: row.template_subject } : {}),
      message: row.template_message ?? defaultTemplate(row.trigger_type).message,
    },
    isEnabled: row.is_enabled === 1,
    triggerCount: row.trigger_count,
    monthlyCount: monthly,
    monthlyCountResetAt: toIso(month),
    dailyCount: daily,
    dailyCountResetAt: toIso(today),
    recentLogs: logs.slice(0, 5).map((l) => ({
      status: l.status,
      error: l.error,
      visitorId: l.visitor_id,
      at: toIso(l.triggered_at),
    })),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
  if (row.last_triggered_at !== null) dto.lastTriggeredAt = toIsoOrNull(row.last_triggered_at);
  if (row.last_error !== null) dto.lastError = row.last_error;
  return dto;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const zName = z
  .string()
  .trim()
  .min(1, "must be 1-100 characters")
  .max(100, "must be 1-100 characters");
const zMessage = z
  .string()
  .trim()
  .min(10, "must be 10-2000 characters")
  .max(2000, "must be 10-2000 characters");

export const TriggerInput = z
  .object({
    type: z.enum(TRIGGER_TYPES as [AlertTriggerType, ...AlertTriggerType[]]).optional(),
    goalName: zGoalName.optional(),
    multiplier: z.number().min(1.5).max(50).optional(),
    minSessions: z.number().int().min(1).max(1_000_000).optional(),
    includeRenewals: z.boolean().optional(),
    includeFreeTrials: z.boolean().optional(),
  })
  .strict();

export const DestinationInput = z
  .object({
    type: z.enum(["email", "telegram", "webhook"]),
    email: zEmail.optional(),
    chatId: z
      .string()
      .trim()
      .regex(/^(-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/, "must be a numeric chat id or @channel")
      .optional(),
    botToken: z
      .string()
      .trim()
      .regex(/^\d+:[A-Za-z0-9_-]{20,}$/, "must be a Telegram bot token")
      .optional(),
    url: z.string().trim().max(2000).optional(),
    rotateSecret: z.boolean().optional(),
  })
  .strict();

const TemplateInput = z
  .object({ subject: z.string().trim().max(200).optional(), message: zMessage.optional() })
  .strict();

export const CreateAlertBody = z
  .object({
    name: zName,
    trigger: TriggerInput,
    template: TemplateInput.optional(),
    destination: DestinationInput.optional(),
    isEnabled: z.boolean().optional(),
  })
  .strict();

export const UpdateAlertBody = z
  .object({
    name: zName.optional(),
    trigger: TriggerInput.optional(),
    template: TemplateInput.optional(),
    destination: DestinationInput.optional(),
    isEnabled: z.boolean().optional(),
  })
  .strict();

export type TriggerInputT = z.output<typeof TriggerInput>;
export type DestinationInputT = z.output<typeof DestinationInput>;

/** Resolve a trigger input against the current one (for updates) into a stored config. */
export function resolveTrigger(
  input: TriggerInputT,
  current?: { type: AlertTriggerType; config: TriggerConfig },
): { type: AlertTriggerType; config: TriggerConfig } {
  const type = input.type ?? (input.goalName ? "goal" : (current?.type ?? "goal"));
  const base = current && current.type === type ? current.config : {};
  const config: TriggerConfig = {};
  switch (type) {
    case "goal": {
      const goalName = input.goalName ?? base.goalName;
      if (!goalName) throw new ApiError(400, "trigger.goalName: required for goal alerts");
      config.goalName = goalName;
      break;
    }
    case "new_sale":
      config.includeRenewals = input.includeRenewals ?? base.includeRenewals ?? true;
      config.includeFreeTrials = input.includeFreeTrials ?? base.includeFreeTrials ?? false;
      break;
    case "traffic_spike":
      config.multiplier = input.multiplier ?? base.multiplier ?? DEFAULT_SPIKE_MULTIPLIER;
      config.minSessions = input.minSessions ?? base.minSessions ?? DEFAULT_SPIKE_MIN_SESSIONS;
      break;
    default:
      break;
  }
  return { type, config };
}

export interface ResolvedDestination {
  channel: AlertChannel;
  config: DestinationConfig;
  /** undefined = keep the stored secret; null = clear it; string = new encrypted secret. */
  secretEnc: string | null | undefined;
  /** The plain webhook signing secret when a new one was generated (returned once). */
  signingSecret?: string;
}

export async function resolveDestination(
  env: Cloudflare.Env,
  siteId: string,
  alertId: string,
  input: DestinationInputT | undefined,
  current?: { channel: AlertChannel; config: DestinationConfig; hasSecret: boolean },
): Promise<ResolvedDestination> {
  if (!input) {
    if (current) return { channel: current.channel, config: current.config, secretEnc: undefined };
    return { channel: "email", config: {}, secretEnc: null };
  }
  const aad = `alert:${siteId}:${alertId}`;
  const sameChannel = current?.channel === input.type;
  switch (input.type) {
    case "email":
      return {
        channel: "email",
        config: input.email ? { email: input.email } : {},
        secretEnc: null,
      };
    case "telegram": {
      const chatId = input.chatId ?? (sameChannel ? current?.config.chatId : undefined);
      if (!chatId) throw new ApiError(400, "destination.chatId: required for Telegram alerts");
      let secretEnc: string | null | undefined;
      if (input.botToken) secretEnc = await encryptString(env.ENCRYPTION_KEY, input.botToken, aad);
      else if (sameChannel && current?.hasSecret) secretEnc = undefined;
      else if (env.TELEGRAM_BOT_TOKEN?.trim()) secretEnc = null;
      else
        throw new ApiError(
          400,
          "destination.botToken: required (no default bot token is configured)",
        );
      return { channel: "telegram", config: { chatId }, secretEnc };
    }
    case "webhook": {
      const url = input.url ?? (sameChannel ? current?.config.url : undefined);
      if (!url || !isAllowedWebhookUrl(url)) {
        throw new ApiError(400, "destination.url: must be a public https:// URL");
      }
      if (sameChannel && current?.hasSecret && !input.rotateSecret) {
        return { channel: "webhook", config: { url }, secretEnc: undefined };
      }
      const signingSecret = `whsec_${toHex(randomBytes(24))}`;
      return {
        channel: "webhook",
        config: { url },
        secretEnc: await encryptString(env.ENCRYPTION_KEY, signingSecret, aad),
        signingSecret,
      };
    }
  }
}
