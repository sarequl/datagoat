/** Helpers for the settings page tests (W5). */
import type { Role } from "../../../../shared/permissions";
import { server } from "../../mocks/node";
import { resetMockState, state } from "../../mocks/state";
import { renderApp } from "../render";

export const SITE = "6728f0a0a1b2c3d4e5f6a001"; // example.com, owner, cookie mode
export const SITE2 = "6728f0a0a1b2c3d4e5f6a002"; // blog.example.org, member, cookieless

/** Sign in, optionally change the demo user's role on SITE, and render `path`. */
export function openPage(path: string, options: { role?: Role } = {}) {
  resetMockState({ signedIn: true });
  if (options.role) {
    const site = state.websites.find((w) => w._id === SITE);
    if (site) site.role = options.role;
  }
  return renderApp(path);
}

export interface LoggedRequest {
  method: string;
  path: string;
  body: unknown;
}

/** Records every request the app sends (method, path, JSON body). */
export function recordRequests(): LoggedRequest[] {
  const log: LoggedRequest[] = [];
  server.events.on("request:start", async ({ request }) => {
    const url = new URL(request.url);
    let body: unknown = null;
    if (request.method !== "GET") {
      try {
        body = await request.clone().json();
      } catch {
        body = null;
      }
    }
    log.push({ method: request.method, path: url.pathname + url.search, body });
  });
  return log;
}

export function writes(log: LoggedRequest[], method: string, pathPart: string) {
  return log.filter((r) => r.method === method && r.path.includes(pathPart));
}

export function site(id = SITE) {
  const w = state.websites.find((x) => x._id === id);
  if (!w) throw new Error(`no mock site ${id}`);
  return w;
}
