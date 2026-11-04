/**
 * Registration point for cron jobs. Each area exports its own `*Jobs` array from its module;
 * add new areas here with one line. The scheduler validates names and schedules at startup.
 */
import { queryJobs } from "../api/v1/admin";
import { ecosystemJobs } from "../ecosystem";
import { growthJobs } from "../growth";
import { ingestJobs } from "../ingest";
import { mcpJobs } from "../mcp";
import { providerJobs } from "../providers";
import { maintenanceJobs } from "./maintenance";
import { type JobDefinition, validateJobs } from "./registry";

export const JOBS: readonly JobDefinition[] = [
  ...maintenanceJobs, // F0
  ...ingestJobs, // W1
  ...queryJobs, // W2
  ...providerJobs, // W3
  ...growthJobs, // W6
  ...mcpJobs, // W7
  ...ecosystemJobs, // W8
];

validateJobs(JOBS);
