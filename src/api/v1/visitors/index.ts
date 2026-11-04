/** W2 — Visitors API (DataFast `/api/v1/visitors`, `/api/v1/visitors/{visitorId}`). */
import { Hono } from "hono";
import { getAccess } from "../../../auth/context";
import { requireSiteAccess } from "../../../auth/middleware";
import { paginationOf, success } from "../../../lib/response";
import { parsePagination } from "../../../lib/validate";
import { buildQueryContext } from "../../../query/context";
import {
  assertVisitorId,
  listVisitors,
  parseVisitorListParams,
  visitorProfile,
} from "../../../query/visitors";
import type { AppEnv } from "../../../types";

export const visitorsRoutes = new Hono<AppEnv>();

visitorsRoutes.get("/api/v1/visitors", requireSiteAccess("analytics:read"), async (c) => {
  const { site } = getAccess(c);
  const params = parseVisitorListParams(new URL(c.req.url).searchParams);
  const page = parsePagination(c.req.query(), { max: 250 });
  const qc = buildQueryContext(c, site, { extraFilters: params.filters });
  const { data, total } = await listVisitors(qc, params, page);
  return success(c, data, { pagination: paginationOf(page.limit, page.offset, total) });
});

visitorsRoutes.get(
  "/api/v1/visitors/:visitorId",
  requireSiteAccess("analytics:read"),
  async (c) => {
    const { site } = getAccess(c);
    const visitorId = c.req.param("visitorId");
    assertVisitorId(visitorId, site.privacyMode);
    const qc = buildQueryContext(c, site);
    return success(c, await visitorProfile({ ...qc, range: null, filters: [] }, visitorId));
  },
);
