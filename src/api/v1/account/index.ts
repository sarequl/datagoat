/** F0 — Account API: account, access tokens, websites, website keys, team. */
import { Hono } from "hono";
import type { AppEnv } from "../../../types";
import { accountRoutes } from "./tokens";
import { websiteRoutes } from "./websites";

export const accountAdminRoutes = new Hono<AppEnv>();
accountAdminRoutes.route("/api/v1/admin", accountRoutes);
accountAdminRoutes.route("/api/v1/admin", websiteRoutes);
