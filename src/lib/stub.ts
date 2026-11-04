/**
 * Route-table helper for feature areas that are not built yet: every listed route answers
 * `501 Not Implemented` with the owning team in the message. Teams replace a stub by deleting
 * its line here and registering the real handler on the same router.
 */
import type { Hono } from "hono";
import type { AppEnv } from "../types";
import { notImplemented } from "./response";

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";

export function stubRoutes(
  router: Hono<AppEnv>,
  owner: string,
  routes: ReadonlyArray<readonly [Method, string]>,
): void {
  const handler = notImplemented(owner);
  for (const [method, path] of routes) router.on(method, path, handler);
}
