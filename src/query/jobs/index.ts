/** W2 cron jobs, registered through `queryJobs` in src/api/v1/admin/index.ts. */
import type { JobDefinition } from "../../jobs/registry";
import { predictionJob } from "./predictions";
import { retentionJob } from "./retention";
import { rollupJob } from "./rollups";

export const QUERY_JOBS: readonly JobDefinition[] = [rollupJob, retentionJob, predictionJob];
