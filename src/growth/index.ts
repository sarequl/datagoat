/**
 * W6 — Growth: alerts and digests (email, Telegram, webhooks via the outbox), weekly email
 * reports, attack mode, AI-crawler bot traffic (ingest + API + settings + token), X/Reddit
 * mentions and X link attribution, GitHub commit markers, Google Search Console, Meta Ads
 * spend/ROAS, Plausible import, and the OAuth connect flows for those integrations.
 * User docs: docs/growth/.
 */
import { Hono } from "hono";
import type { JobDefinition } from "../jobs/registry";
import type { AppEnv } from "../types";
import { accountEmailRoutes } from "./alerts/account-emails";
import { runDigests } from "./alerts/digest";
import { evaluateEventAlerts } from "./alerts/evaluate";
import { alertRoutes } from "./alerts/routes";
import { evaluateTrafficSpikes } from "./alerts/spike";
import { attackRoutes, runAttackDetection } from "./attack/attack-mode";
import { botIngestRoutes } from "./bots/ingest";
import { refreshIpRanges } from "./bots/ip-ranges";
import { botRoutes } from "./bots/routes";
import { githubRoutes, syncGithub } from "./commits/github";
import { cleanupOutbox, deliverOutbox } from "./delivery/outbox";
import { gscRoutes } from "./gsc/routes";
import { syncSearchConsole } from "./gsc/sync";
import { importRoutes } from "./imports/routes";
import { integrationRoutes } from "./integrations/routes";
import { mentionRoutes } from "./mentions/routes";
import { syncMentions } from "./mentions/sync";
import { metaRoutes } from "./meta/routes";
import { syncMeta } from "./meta/sync";

export const growthRoutes = new Hono<AppEnv>();

growthRoutes.route("/", botIngestRoutes);
growthRoutes.route("/", attackRoutes);
growthRoutes.route("/", botRoutes);
growthRoutes.route("/", alertRoutes);
growthRoutes.route("/", accountEmailRoutes);
growthRoutes.route("/", mentionRoutes);
growthRoutes.route("/", githubRoutes);
growthRoutes.route("/", gscRoutes);
growthRoutes.route("/", metaRoutes);
growthRoutes.route("/", integrationRoutes);
growthRoutes.route("/", importRoutes);

export const growthJobs: JobDefinition[] = [
  {
    name: "outbox.deliver",
    schedule: { every: "minute" },
    priority: 5,
    description: "Send pending emails, Telegram messages and webhooks with retries",
    run: async (ctx) => {
      await deliverOutbox(ctx);
    },
  },
  {
    name: "alerts.evaluate",
    schedule: { every: "minute" },
    priority: 4,
    minQueries: 4,
    description: "Goal-completed and new-sale alerts",
    run: async (ctx) => {
      await evaluateEventAlerts(ctx);
    },
  },
  {
    name: "alerts.traffic-spike",
    schedule: { every: "hour", minute: 3 },
    minQueries: 5,
    description: "Traffic-spike alerts and viral traffic emails",
    run: async (ctx) => {
      await evaluateTrafficSpikes(ctx);
    },
  },
  {
    name: "alerts.digest",
    schedule: { every: "minutes", interval: 10 },
    minQueries: 8,
    description: "Daily and weekly digests, weekly email reports (Mondays)",
    run: async (ctx) => {
      await runDigests(ctx);
    },
  },
  {
    name: "outbox.cleanup",
    schedule: { every: "day", at: "03:41" },
    description: "Drop settled outbox rows (30 days) and old alert history (180 days)",
    run: async (ctx) => {
      await cleanupOutbox(ctx);
    },
  },
  {
    name: "attack.detect",
    schedule: { every: "minutes", interval: 5 },
    minQueries: 4,
    description: "Automatic attack mode on abnormal bot traffic",
    run: async (ctx) => {
      await runAttackDetection(ctx);
    },
  },
  {
    name: "bots.ip-ranges",
    schedule: { every: "day", at: "04:11" },
    description: "Refresh published crawler IP ranges",
    run: async (ctx) => {
      await refreshIpRanges(ctx);
    },
  },
  {
    name: "mentions.sync",
    schedule: { every: "minutes", interval: 30 },
    minQueries: 4,
    description: "X and Reddit mentions, X link attribution",
    run: async (ctx) => {
      await syncMentions(ctx);
    },
  },
  {
    name: "github.sync",
    schedule: { every: "hour", minute: 37 },
    description: "GitHub commit markers",
    run: async (ctx) => {
      await syncGithub(ctx);
    },
  },
  {
    name: "gsc.sync",
    schedule: { every: "hour", minute: 17 },
    description: "Google Search Console daily sync and backfill",
    run: async (ctx) => {
      await syncSearchConsole(ctx);
    },
  },
  {
    name: "meta.sync",
    schedule: { every: "hour", minute: 23 },
    description: "Meta Ads spend per campaign",
    run: async (ctx) => {
      await syncMeta(ctx);
    },
  },
];
