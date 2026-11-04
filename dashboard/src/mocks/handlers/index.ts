/**
 * All mock handlers, in match order. Growth handlers come before the generic analytics
 * `/:breakdown` route so `/analytics/bot-traffic` and `/analytics/revenue` resolve to theirs.
 * Teams add handlers for new endpoints in their area's file, matching docs/api/contract.md.
 * settingsHandlers (W5, stateful) come first so the settings pages see their own writes.
 */
import { analyticsHandlers } from "./analytics";
import { authHandlers } from "./auth";
import { growthHandlers } from "./growth";
import { settingsHandlers } from "./settings";

export const handlers = [
  ...settingsHandlers,
  ...authHandlers,
  ...growthHandlers,
  ...analyticsHandlers,
];
