/**
 * DataGoat Worker entry point: one Hono app for HTTP and one cron multiplexer for scheduled().
 * Static assets (tracker scripts, dashboard) are served by Workers Static Assets before this
 * code runs, except for the routes in wrangler.jsonc `assets.run_worker_first`.
 */
import { createApp } from "./app";
import { JOBS } from "./jobs";
import { runScheduled } from "./jobs/scheduler";

const app = createApp();

export default {
  fetch: app.fetch,
  async scheduled(controller, env, ctx) {
    await runScheduled(JOBS, env, ctx, controller.scheduledTime);
  },
} satisfies ExportedHandler<Cloudflare.Env>;
