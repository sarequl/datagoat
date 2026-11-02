import { BOT_PATTERNS } from './data/lists';
import type { Env } from './env';
import { handleIngest } from './ingest';
import { rollup } from './rollup';
import { TRACKER_JS } from './tracker';
import { sha256Hex } from './util/crypto';

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json', ...headers },
  });
}

function serveTracker(): Response {
  return new Response(TRACKER_JS, {
    status: 200,
    headers: {
      ...CORS,
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=300, stale-while-revalidate=86400',
    },
  });
}

async function serveMeta(env: Env): Promise<Response> {
  const botsSha256 = await sha256Hex(BOT_PATTERNS.join('\n'));
  return json({
    bots: { count: BOT_PATTERNS.length, sha256: botsSha256 },
    secret_version: env.SECRET_VERSION,
    session_gap_seconds: 30 * 60,
    privacy_modes: ['cookies', 'localstorage', 'cookieless', 'consent'],
  });
}

function serveHealth(): Response {
  return json({ status: 'ok', schema_version: 1, time: Math.floor(Date.now() / 1000) });
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (path === '/t' || path === '/p.gif') {
      return handleIngest(request, env, url);
    }
    if (path === '/t.js') {
      return serveTracker();
    }
    if (path === '/api/ingest/meta') {
      return serveMeta(env);
    }
    if (path === '/api/v1/health') {
      return serveHealth();
    }

    return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      rollup(env).catch((error) => {
        console.error('rollup failed', error);
      }),
    );
  },
} satisfies ExportedHandler<Env>;
