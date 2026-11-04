import { HttpResponse } from "msw";
import type { Pagination } from "../../../../shared/api-types";

export function ok<T>(data: T, extra: Record<string, unknown> = {}, pagination?: Pagination) {
  return HttpResponse.json({
    status: "success",
    ...extra,
    data,
    ...(pagination ? { pagination } : {}),
  });
}

export function list<T>(rows: T[], url: URL, max = 1000) {
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 100) || 100, max);
  const offset = Number(url.searchParams.get("offset") ?? 0) || 0;
  return ok(
    rows.slice(offset, offset + limit),
    {},
    { limit, offset, total: rows.length, hasMore: offset + limit < rows.length },
  );
}

export function fail(code: number, message: string) {
  return HttpResponse.json({ status: "error", error: { code, message } }, { status: code });
}
