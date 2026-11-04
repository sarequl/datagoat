/**
 * @datagoat/ai-crawl (packages/ai-crawl) in workerd: the Workers wrapper, request/response
 * helpers and the Express middleware, end to end into the real /api/ai-crawls endpoint.
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type AICrawlOptions,
  buildReport,
  crawlerCategory,
  createExpressAICrawlerMiddleware,
  isTrackablePath,
  trackAICrawlerRequest,
  trackAICrawlerResponse,
  withAICrawlerTracking,
} from "../../../packages/ai-crawl/src/index";
import { createApp } from "../../../src/app";
import { invalidateBotConfig } from "../../../src/growth/bots/settings";
import { resetDb } from "../../helpers/db";
import { createSite, createUser } from "../../helpers/factories";
import { mockFetch } from "./helpers";

beforeEach(async () => {
  await resetDb();
  invalidateBotConfig();
});

const GPTBOT =
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.1; +https://openai.com/gptbot)";
const CHATGPT = "Mozilla/5.0 (compatible; ChatGPT-User/1.0; +https://openai.com/bot)";
const HUMAN =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15";

const app = createApp();
/** A fetch that delivers the package's reports straight into the DataGoat Worker. */
function intoWorker() {
  const sent: unknown[] = [];
  const doFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as RequestInfo, init);
    sent.push(JSON.parse(await req.clone().text()));
    const ctx = createExecutionContext();
    const res = await app.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  }) as typeof fetch;
  return { doFetch, sent };
}

function waitUntilCollector() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<unknown>) => void pending.push(p) },
    pending,
    all: () => Promise.all(pending),
  };
}

describe("pre-filtering", () => {
  it("classifies hints, keeps discovery files and skips assets and internals", () => {
    expect(crawlerCategory(CHATGPT)).toBe("answer_fetch");
    expect(crawlerCategory(GPTBOT)).toBe("training");
    expect(crawlerCategory("Mozilla/5.0 (compatible; Googlebot/2.1)")).toBe("search_index");
    expect(crawlerCategory("SomeRandomBot/1.0")).toBe("other");
    expect(crawlerCategory(HUMAN)).toBeNull();
    for (const p of [
      "/",
      "/docs/get-started",
      "/robots.txt",
      "/llms.txt",
      "/llms-full.txt",
      "/sitemap.xml",
      "/docs/setup.md",
      "/guide.pdf",
    ]) {
      expect(isTrackablePath(p), p).toBe(true);
    }
    for (const p of [
      "/app.js",
      "/styles.css",
      "/logo.png",
      "/favicon.ico",
      "/_next/static/x",
      "/api/users",
      "/fonts/a.woff2",
    ]) {
      expect(isTrackablePath(p), p).toBe(false);
    }
  });

  it("builds DataFast's report body, without query strings by default", () => {
    const options: AICrawlOptions = { websiteId: "dfid_x", apiUrl: "https://a.example.com" };
    const input = {
      method: "GET",
      url: "https://example.com/pricing?email=a@b.c",
      userAgent: CHATGPT,
      ip: "1.2.3.4",
      statusCode: 200,
    };
    expect(buildReport(input, options)).toEqual({
      websiteId: "dfid_x",
      domain: "example.com",
      href: "https://example.com/pricing",
      ai: { userAgent: CHATGPT, ip: "1.2.3.4", statusCode: 200, source: "server_middleware" },
    });
    expect(buildReport(input, { ...options, includeQuery: true })?.href).toBe(
      "https://example.com/pricing?email=a@b.c",
    );
    expect(
      buildReport(
        { ...input, url: "http://0.0.0.0:3000/pricing" },
        { ...options, publicOrigin: "https://example.com" },
      )?.href,
    ).toBe("https://example.com/pricing");
    expect(buildReport({ ...input, method: "POST" }, options)).toBeNull();
    expect(buildReport(input, { ...options, disableAnswerFetch: true })).toBeNull();
    expect(
      buildReport({ ...input, userAgent: GPTBOT }, { ...options, disableTrainingCrawlers: true }),
    ).toBeNull();
  });
});

describe("integrations into a real DataGoat ingest", () => {
  async function site() {
    const owner = await createUser();
    return createSite(owner.id, { domain: "example.com" });
  }

  it("withAICrawlerTracking reports after the handler, with the status code, via waitUntil", async () => {
    const s = await site();
    const { doFetch, sent } = intoWorker();
    const wrapped = withAICrawlerTracking(async () => new Response("not here", { status: 404 }), {
      websiteId: s.publicId,
      apiUrl: "https://datagoat.test",
      fetch: doFetch,
    });
    const w = waitUntilCollector();
    const res = await wrapped(
      new Request("https://example.com/free-trial", {
        headers: { "user-agent": GPTBOT, "cf-connecting-ip": "20.171.206.1" },
      }),
      {},
      w.ctx,
    );
    expect(res.status).toBe(404);
    expect(w.pending).toHaveLength(1);
    expect(await w.all()).toEqual([true]);
    expect(sent[0]).toMatchObject({
      ai: { statusCode: 404, ip: "20.171.206.1", source: "server_middleware" },
    });
    const row = await env.DB.prepare(
      "SELECT crawler_id, path, status_code FROM bot_traffic",
    ).first();
    expect(row).toEqual({
      crawler_id: "OpenAI::GPTBot::training",
      path: "/free-trial",
      status_code: 404,
    });
  });

  it("request-only tracking ignores humans and sends the auth token", async () => {
    const s = await site();
    const mock = mockFetch().on("https://datagoat.test/api/ai-crawls", () => ({ success: true }));
    const options = {
      websiteId: s.publicId,
      apiUrl: "https://datagoat.test/",
      authToken: "dfbot_secret",
      fetch: mock.fetch as typeof fetch,
    };
    expect(
      await trackAICrawlerRequest(
        new Request("https://example.com/", { headers: { "user-agent": HUMAN } }),
        null,
        options,
      ),
    ).toBe(false);
    expect(mock.calls).toHaveLength(0);
    expect(
      await trackAICrawlerRequest(
        new Request("https://example.com/llms.txt", { headers: { "user-agent": CHATGPT } }),
        undefined,
        options,
      ),
    ).toBe(true);
    expect(mock.calls[0]?.headers.get("authorization")).toBe("Bearer dfbot_secret");
    expect(JSON.parse(mock.calls[0]?.body ?? "{}").ai.statusCode).toBeUndefined();
  });

  it("never throws or rejects when DataGoat is down", async () => {
    const options = {
      websiteId: "dfid_x",
      apiUrl: "https://datagoat.test",
      fetch: (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
    };
    const req = new Request("https://example.com/", { headers: { "user-agent": GPTBOT } });
    await expect(
      trackAICrawlerResponse(
        req,
        new Response("ok"),
        {
          waitUntil: () => {
            throw new Error("x");
          },
        },
        options,
      ),
    ).resolves.toBe(false);
  });

  it("Express middleware calls next() at once and reports on finish", async () => {
    const s = await site();
    const { doFetch, sent } = intoWorker();
    const mw = createExpressAICrawlerMiddleware({
      websiteId: s.publicId,
      apiUrl: "https://datagoat.test",
      fetch: doFetch,
    });
    let finish: (() => void) | undefined;
    const res = {
      statusCode: 200,
      on: (_e: "finish", fn: () => void) => {
        finish = fn;
      },
    };
    let nextCalled = false;
    mw(
      {
        method: "GET",
        url: "/docs",
        originalUrl: "/docs?x=1",
        ip: "203.0.113.10",
        headers: { host: "example.com", "user-agent": CHATGPT, "x-forwarded-proto": "https" },
      },
      res,
      () => {
        nextCalled = true;
      },
    );
    expect(nextCalled).toBe(true);
    expect(sent).toHaveLength(0);
    finish?.();
    await new Promise((r) => setTimeout(r, 50));
    for (let i = 0; i < 20 && sent.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(sent[0]).toMatchObject({
      href: "https://example.com/docs",
      ai: { ip: "203.0.113.10", statusCode: 200 },
    });
    for (let i = 0; i < 20; i++) {
      if (await env.DB.prepare("SELECT COUNT(*) AS n FROM bot_traffic").first("n")) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(await env.DB.prepare("SELECT path FROM bot_traffic").first("path")).toBe("/docs");
  });
});
