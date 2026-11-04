/** The Hono application: request ids, error envelopes, security headers, route table. */
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import { ensureSchema, SchemaNotReadyError } from "./db/migrate";
import { ApiError } from "./lib/errors";
import { errorFields, log } from "./lib/log";
import { errorResponse } from "./lib/response";
import { formatZodError } from "./lib/validate";
import { mountRoutes } from "./routes";
import type { AppEnv } from "./types";

export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    const requestId = c.req.header("cf-ray") ?? crypto.randomUUID();
    c.set("requestId", requestId);
    await next();
    c.res.headers.set("X-Request-Id", requestId);
    const path = new URL(c.req.url).pathname;
    if (path.startsWith("/api/") || path.startsWith("/oauth/") || path === "/mcp") {
      c.res.headers.set("X-Content-Type-Options", "nosniff");
      if (!c.res.headers.has("Cache-Control")) c.res.headers.set("Cache-Control", "no-store");
    }
  });

  // Bring the D1 schema up to date on the first request of each isolate (see src/db/migrate.ts).
  app.use("*", async (c, next) => {
    await ensureSchema(c.env.DB);
    return next();
  });

  app.onError((err, c) => {
    if (err instanceof SchemaNotReadyError) {
      return errorResponse(503, `Database is not initialised: ${err.message}`, {
        "Retry-After": "5",
      });
    }
    if (err instanceof ApiError)
      return errorResponse(err.status, err.message, err.headers, err.extra);
    if (err instanceof ZodError) return errorResponse(400, formatZodError(err));
    if (err instanceof HTTPException) {
      const status = err.status as Parameters<typeof errorResponse>[0];
      return errorResponse(status, err.message || "Request failed");
    }
    log.error("request.failed", {
      path: new URL(c.req.url).pathname,
      requestId: c.get("requestId"),
      ...errorFields(err),
    });
    return errorResponse(500, "Internal server error");
  });

  mountRoutes(app);

  app.notFound((c) => {
    const path = new URL(c.req.url).pathname;
    const isApi = ["/api/", "/webhooks/", "/oauth/", "/.well-known/", "/mcp"].some((p) =>
      path.startsWith(p),
    );
    if (isApi) return errorResponse(404, `No route for ${c.req.method} ${path}`);
    // Anything else falls back to the static assets (dashboard SPA).
    return c.env.ASSETS.fetch(c.req.raw);
  });

  return app;
}
