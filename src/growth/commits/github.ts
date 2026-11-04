/**
 * GitHub commit markers (DataFast docs/github-integration): commit messages, authors, +/- line
 * stats, branch and time, shown on the analytics chart.
 *
 * Sources:
 * - REST API: list commits `GET /repos/{owner}/{repo}/commits` and get a commit (for `stats`)
 *   `GET /repos/{owner}/{repo}/commits/{ref}` (https://docs.github.com/en/rest/commits/commits).
 *   Public repositories work without a token (60 requests/hour per IP).
 * - Push webhooks, verified with `X-Hub-Signature-256` (HMAC-SHA256 of the raw body,
 *   https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries).
 *
 * `github.sync` (hourly at :37): new commits since the newest stored one (90 days on first run,
 * 2 pages of 100), then fills in line stats for up to STATS_PER_RUN commits. Commits are
 * `INSERT … ON CONFLICT DO NOTHING`, so re-reading them writes nothing.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { GithubCommit } from "../../../shared/api-types";
import { getAccess } from "../../auth/context";
import { requireSiteAccess } from "../../auth/middleware";
import type { JobContext } from "../../jobs/registry";
import { verifyHmacSha256 } from "../../lib/crypto";
import { chunk } from "../../lib/d1";
import { errorFields, log } from "../../lib/log";
import { paginationOf, success } from "../../lib/response";
import { escapeLike } from "../../lib/sql";
import { lastNDays, parseRange, toIso } from "../../lib/time";
import { parsePagination, parseQuery } from "../../lib/validate";
import type { AppEnv } from "../../types";
import { githubWebhookSecret } from "../integrations/routes";
import {
  type Connection,
  decryptCredentials,
  getConnection,
  listActiveConnections,
  type OAuthCredentials,
  syncResultStatement,
} from "../shared/connections";
import { errorMessage, type Fetcher, requestJson } from "../shared/http";

const API = "https://api.github.com";
export const SITES_PER_RUN = 3;
export const STATS_PER_RUN = 10;
const BACKFILL_MS = 90 * 86_400_000;

export interface GithubSettings {
  repo?: string;
  branch?: string | null;
}

export interface GithubCursor {
  since?: string;
}

export interface CommitRecord {
  sha: string;
  repo: string;
  branch: string | null;
  message: string;
  authorName: string | null;
  authorLogin: string | null;
  authorAvatar: string | null;
  additions: number | null;
  deletions: number | null;
  url: string | null;
  committedAt: number;
}

function headers(token: string | null): Record<string, string> {
  const h: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "DataGoat-commit-markers",
  };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

interface ApiCommit {
  sha: string;
  html_url?: string;
  commit?: {
    message?: string;
    author?: { name?: string; date?: string };
    committer?: { date?: string };
  };
  author?: { login?: string; avatar_url?: string } | null;
  stats?: { additions?: number; deletions?: number };
}

export async function listCommits(
  fetcher: Fetcher,
  token: string | null,
  repo: string,
  options: { since: string; branch?: string | null; page?: number },
): Promise<CommitRecord[]> {
  const url = new URL(`${API}/repos/${repo}/commits`);
  url.searchParams.set("per_page", "100");
  url.searchParams.set("since", options.since);
  if (options.branch) url.searchParams.set("sha", options.branch);
  if (options.page && options.page > 1) url.searchParams.set("page", String(options.page));
  const res = await requestJson<ApiCommit[]>(fetcher, "GitHub", url.toString(), {
    headers: headers(token),
  });
  return (Array.isArray(res) ? res : []).map((c) => ({
    sha: c.sha,
    repo,
    branch: options.branch ?? null,
    message: (c.commit?.message ?? "").slice(0, 2000),
    authorName: c.commit?.author?.name ?? null,
    authorLogin: c.author?.login ?? null,
    authorAvatar: c.author?.avatar_url ?? null,
    additions: null,
    deletions: null,
    url: c.html_url ?? `https://github.com/${repo}/commit/${c.sha}`,
    committedAt:
      Date.parse(c.commit?.author?.date ?? c.commit?.committer?.date ?? "") || Date.now(),
  }));
}

export async function commitStats(
  fetcher: Fetcher,
  token: string | null,
  repo: string,
  sha: string,
) {
  const res = await requestJson<ApiCommit>(
    fetcher,
    "GitHub",
    `${API}/repos/${repo}/commits/${sha}`,
    {
      headers: headers(token),
    },
  );
  return { additions: res.stats?.additions ?? 0, deletions: res.stats?.deletions ?? 0 };
}

export async function listRepos(fetcher: Fetcher, token: string) {
  const res = await requestJson<
    Array<{ full_name: string; private: boolean; default_branch?: string; pushed_at?: string }>
  >(fetcher, "GitHub", `${API}/user/repos?per_page=100&sort=pushed`, { headers: headers(token) });
  return (res ?? []).map((r) => ({
    fullName: r.full_name,
    private: r.private,
    defaultBranch: r.default_branch ?? null,
    pushedAt: r.pushed_at ?? null,
  }));
}

export function commitInserts(db: D1Database, siteId: string, commits: readonly CommitRecord[]) {
  return chunk(commits, 8).map((part) =>
    db
      .prepare(
        `INSERT INTO github_commits (site_id, sha, repo, branch, message, author_name, author_login, author_avatar,
           additions, deletions, url, committed_at)
         VALUES ${part.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ")}
         ON CONFLICT (site_id, sha) DO NOTHING`,
      )
      .bind(
        ...part.flatMap((c) => [
          siteId,
          c.sha,
          c.repo,
          c.branch,
          c.message,
          c.authorName,
          c.authorLogin,
          c.authorAvatar,
          c.additions,
          c.deletions,
          c.url,
          c.committedAt,
        ]),
      ),
  );
}

async function tokenOf(
  env: Cloudflare.Env,
  conn: Pick<Connection, "kind" | "siteId" | "credentialsEnc">,
) {
  const creds = await decryptCredentials<OAuthCredentials>(env, conn).catch(() => null);
  return creds?.accessToken || null;
}

export async function syncGithubSite(
  ctx: Pick<JobContext, "db" | "env" | "now" | "fetch">,
  conn: Connection<GithubSettings, GithubCursor>,
) {
  const { db, now } = ctx;
  const repo = conn.settings.repo;
  if (!repo) return { commits: 0, stats: 0 };
  const token = await tokenOf(ctx.env, conn);
  const since = conn.cursor.since ?? new Date(now - BACKFILL_MS).toISOString();
  const commits: CommitRecord[] = [];
  for (let page = 1; page <= 2; page++) {
    const batch = await listCommits(ctx.fetch, token, repo, {
      since,
      branch: conn.settings.branch,
      page,
    });
    commits.push(...batch);
    if (batch.length < 100) break;
  }
  const newest = commits.reduce((m, c) => Math.max(m, c.committedAt), Date.parse(since) || 0);
  const pending = await db
    .prepare(
      `SELECT sha FROM github_commits WHERE site_id = ? AND repo = ? AND additions IS NULL
       ORDER BY committed_at DESC LIMIT ${STATS_PER_RUN}`,
    )
    .bind(conn.siteId, repo)
    .all<{ sha: string }>();
  const stats = await Promise.all(
    (pending.results ?? []).map(async ({ sha }) => {
      try {
        return { sha, ...(await commitStats(ctx.fetch, token, repo, sha)) };
      } catch {
        return null;
      }
    }),
  );
  await db.batch([
    ...commitInserts(db, conn.siteId, commits),
    ...stats
      .filter((s): s is { sha: string; additions: number; deletions: number } => s !== null)
      .map((s) =>
        db
          .prepare(
            "UPDATE github_commits SET additions = ?, deletions = ? WHERE site_id = ? AND sha = ?",
          )
          .bind(s.additions, s.deletions, conn.siteId, s.sha),
      ),
    syncResultStatement(db, conn.siteId, "github", {
      now,
      cursor: { since: new Date(newest + 1000).toISOString() },
      error: null,
    }),
  ]);
  return { commits: commits.length, stats: stats.filter(Boolean).length };
}

export async function syncGithub(
  ctx: Pick<JobContext, "db" | "env" | "now" | "fetch" | "remainingQueries">,
) {
  const conns = await listActiveConnections<GithubSettings, GithubCursor>(
    ctx.db,
    "github",
    SITES_PER_RUN,
  );
  let commits = 0;
  for (const conn of conns) {
    if (ctx.remainingQueries() < 3) break;
    try {
      commits += (await syncGithubSite(ctx, conn)).commits;
    } catch (err) {
      log.warn("github.sync_failed", { siteId: conn.siteId, ...errorFields(err) });
      await syncResultStatement(ctx.db, conn.siteId, "github", {
        now: ctx.now,
        error: errorMessage(err),
      }).run();
    }
  }
  return { sites: conns.length, commits };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const githubRoutes = new Hono<AppEnv>();

const CommitsQuery = z.object({
  websiteId: z.string().optional(),
  startAt: z.string().optional(),
  endAt: z.string().optional(),
  timezone: z.string().optional(),
  q: z.string().max(100).optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
});

githubRoutes.get("/api/v1/github/commits", requireSiteAccess("analytics:read"), async (c) => {
  const { site } = getAccess(c);
  const q = parseQuery(c, CommitsQuery, { strict: true });
  const { limit, offset } = parsePagination(q, { max: 1000 });
  const range =
    parseRange(q, site.timezone, (tz, now) => lastNDays(30, tz, now)) ??
    lastNDays(30, site.timezone);
  const prefix = q.q?.trim().toLowerCase();
  const where = `site_id = ?1 AND committed_at >= ?2 AND committed_at < ?3${prefix ? " AND lower(message) LIKE ?4 ESCAPE '\\'" : ""}`;
  const binds: unknown[] = [site.id, range.startMs, range.endMs];
  if (prefix) binds.push(`${escapeLike(prefix)}%`);
  const [rows, count] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT * FROM github_commits WHERE ${where} ORDER BY committed_at DESC LIMIT ${limit} OFFSET ${offset}`,
    ).bind(...binds),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM github_commits WHERE ${where}`).bind(...binds),
  ]);
  const data: GithubCommit[] = ((rows?.results ?? []) as Array<Record<string, unknown>>).map(
    (r) => ({
      sha: String(r.sha),
      repo: String(r.repo),
      branch: (r.branch as string | null) ?? null,
      message: String(r.message),
      author: {
        name: (r.author_name as string | null) ?? null,
        login: (r.author_login as string | null) ?? null,
        avatar: (r.author_avatar as string | null) ?? null,
      },
      additions: (r.additions as number | null) ?? null,
      deletions: (r.deletions as number | null) ?? null,
      url: (r.url as string | null) ?? null,
      timestamp: toIso(Number(r.committed_at)),
    }),
  );
  const total = Number((count?.results?.[0] as { n?: number })?.n ?? 0);
  return success(c, data, { pagination: paginationOf(limit, offset, total) });
});

githubRoutes.get("/api/v1/github/repos", requireSiteAccess("settings:read"), async (c) => {
  const { site } = getAccess(c);
  const conn = await getConnection(c.env.DB, site.id, "github");
  const token = conn ? await tokenOf(c.env, conn) : null;
  if (!token) return success(c, []);
  try {
    return success(c, await listRepos((i, init) => fetch(i, init), token));
  } catch (err) {
    return success(c, [], { extra: { error: errorMessage(err) } });
  }
});

interface PushPayload {
  ref?: string;
  repository?: { full_name?: string; default_branch?: string };
  commits?: Array<{
    id?: string;
    message?: string;
    timestamp?: string;
    url?: string;
    author?: { name?: string; username?: string };
  }>;
}

githubRoutes.post("/webhooks/github/:siteId", async (c) => {
  const siteId = c.req.param("siteId");
  const body = await c.req.text();
  if (body.length > 1_000_000) return c.json({ error: "Payload too large" }, 413);
  const signature = c.req.header("x-hub-signature-256") ?? "";
  const secret = await githubWebhookSecret(c.env, siteId);
  if (
    !signature.startsWith("sha256=") ||
    !(await verifyHmacSha256(secret, body, signature.slice(7)))
  ) {
    return c.json({ error: "Invalid signature" }, 401);
  }
  const event = c.req.header("x-github-event") ?? "";
  if (event === "ping") return c.json({ ok: true });
  if (event !== "push") return c.json({ ok: true, ignored: event });
  const conn = await getConnection<GithubSettings>(c.env.DB, siteId, "github");
  if (!conn?.settings.repo) return c.json({ ok: true, ignored: "not connected" });
  let payload: PushPayload;
  try {
    payload = JSON.parse(body) as PushPayload;
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const repo = payload.repository?.full_name ?? "";
  if (repo.toLowerCase() !== conn.settings.repo.toLowerCase())
    return c.json({ ok: true, ignored: "other repository" });
  const branch = (payload.ref ?? "").replace(/^refs\/heads\//, "");
  const wanted = conn.settings.branch || payload.repository?.default_branch || branch;
  if (branch !== wanted) return c.json({ ok: true, ignored: "other branch" });
  const commits: CommitRecord[] = (payload.commits ?? [])
    .filter((x) => x.id && /^[0-9a-f]{7,64}$/.test(x.id))
    .slice(0, 100)
    .map((x) => ({
      sha: x.id as string,
      repo: conn.settings.repo as string,
      branch,
      message: (x.message ?? "").slice(0, 2000),
      authorName: x.author?.name ?? null,
      authorLogin: x.author?.username ?? null,
      authorAvatar: x.author?.username ? `https://github.com/${x.author.username}.png` : null,
      additions: null,
      deletions: null,
      url: x.url ?? null,
      committedAt: Date.parse(x.timestamp ?? "") || Date.now(),
    }));
  if (commits.length) await c.env.DB.batch(commitInserts(c.env.DB, siteId, commits));
  return c.json({ ok: true, stored: commits.length });
});
