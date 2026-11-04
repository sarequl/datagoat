/**
 * Test harness: a mock DataGoat HTTP server (node:http on 127.0.0.1) that records requests, and
 * an in-memory Io so `main()` runs in-process with a temporary home directory.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Io } from "../src/io";
import { main } from "../src/main";

export interface Recorded {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: IncomingMessage["headers"];
  // biome-ignore lint/suspicious/noExplicitAny: request bodies are arbitrary JSON
  body: any;
}

export interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type Route = (req: Recorded) => Reply | undefined;

export class MockServer {
  readonly requests: Recorded[] = [];
  private routes: Array<{ method: string; path: string | RegExp; reply: Route | Reply }> = [];
  private server: Server | undefined;
  url = "";

  on(method: string, path: string | RegExp, reply: Route | Reply): this {
    this.routes.unshift({ method, path, reply });
    return this;
  }

  /** `{status: "success", data}` for a route. */
  data(method: string, path: string | RegExp, data: unknown, extra: Record<string, unknown> = {}) {
    return this.on(method, path, { body: { status: "success", ...extra, data } });
  }

  last(method?: string, path?: string): Recorded {
    const list = this.requests.filter(
      (r) => (!method || r.method === method) && (!path || r.path === path),
    );
    const hit = list[list.length - 1];
    if (!hit) throw new Error(`no ${method ?? ""} ${path ?? ""} request recorded`);
    return hit;
  }

  async start(): Promise<void> {
    this.server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const text = Buffer.concat(chunks).toString("utf8");
      let body: unknown = text || undefined;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        // keep text
      }
      const rec: Recorded = {
        method: req.method ?? "GET",
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: req.headers,
        body,
      };
      this.requests.push(rec);
      const route = this.routes.find(
        (r) =>
          r.method === rec.method &&
          (typeof r.path === "string" ? r.path === rec.path : r.path.test(rec.path)),
      );
      const reply = (route &&
        (typeof route.reply === "function" ? route.reply(rec) : route.reply)) ?? {
        status: 404,
        body: {
          status: "error",
          error: { code: 404, message: `No route for ${rec.method} ${rec.path}` },
        },
      };
      res.writeHead(reply.status ?? 200, {
        "content-type": "application/json",
        ...(reply.headers ?? {}),
      });
      res.end(reply.body === undefined ? "" : JSON.stringify(reply.body));
    });
    const server = this.server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  // biome-ignore lint/suspicious/noExplicitAny: parsed --json output
  json: () => any;
}

export interface Sandbox {
  home: string;
  env: Record<string, string | undefined>;
  run(
    argv: string[],
    options?: { stdin?: string; answers?: string[]; env?: Record<string, string> },
  ): Promise<RunResult>;
  cleanup(): Promise<void>;
  opened: string[];
}

export const NOW = Date.parse("2026-11-04T15:00:00Z");

export async function sandbox(): Promise<Sandbox> {
  const home = await mkdtemp(join(tmpdir(), "datagoat-cli-"));
  const env: Record<string, string | undefined> = { XDG_CONFIG_HOME: join(home, ".config") };
  const opened: string[] = [];
  return {
    home,
    env,
    opened,
    async run(argv, options = {}) {
      let stdout = "";
      let stderr = "";
      const answers = options.answers ? [...options.answers] : null;
      const io: Io = {
        stdout: (t) => {
          stdout += t;
        },
        stderr: (t) => {
          stderr += t;
        },
        readStdin: async () => options.stdin ?? "",
        prompt: answers
          ? async (question) => {
              stderr += question;
              const next = answers.shift();
              if (next === undefined) throw new Error(`unexpected prompt: ${question}`);
              return next;
            }
          : null,
        interactive: answers !== null,
        tty: false,
        env: { ...env, ...(options.env ?? {}) },
        homedir: home,
        platform: "linux",
        fetch: (input, init) => fetch(input, init),
        now: () => NOW,
        openUrl: (url) => opened.push(url),
      };
      const code = await main(argv, io);
      return { code, stdout, stderr, json: () => JSON.parse(stdout) };
    },
    async cleanup() {
      await rm(home, { recursive: true, force: true });
    },
  };
}
