import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import worker from '../src';
import { rollup } from '../src/rollup';
import {
  aggValue,
  applySchema,
  beaconRequest,
  countEvents,
  dayOf,
  pageviewBody,
  resetData,
  TEST_SITE,
} from './helpers';

async function ingest(body: Record<string, unknown>): Promise<void> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(beaconRequest(body), env, ctx);
  await waitOnExecutionContext(ctx);
  expect(response.status).toBe(204);
}

describe('cron rollup', () => {
  beforeAll(async () => {
    await applySchema();
  });

  beforeEach(async () => {
    await resetData();
  });

  it('moves an ingested pageview into sessions, visitors and daily_aggregates', async () => {
    await ingest(pageviewBody());
    expect(await countEvents()).toBe(1);

    const now = Math.floor(Date.now() / 1000);
    const result = await rollup(env, now);
    expect(result.events).toBe(1);

    const day = await dayOf(now);

    const sessions = await env.DB.prepare('SELECT * FROM sessions WHERE website_id = ?')
      .bind(TEST_SITE.id)
      .all<{
        pageviews: number;
        events: number;
        is_new_visitor: number;
      }>();
    expect(sessions.results).toHaveLength(1);
    const session = sessions.results[0];
    expect(session.pageviews).toBe(1);
    expect(session.events).toBe(1);
    expect(session.is_new_visitor).toBe(1);

    const visitors = await env.DB.prepare('SELECT * FROM visitors WHERE website_id = ?')
      .bind(TEST_SITE.id)
      .all<{ pageviews: number; sessions: number }>();
    expect(visitors.results).toHaveLength(1);
    expect(visitors.results[0].pageviews).toBe(1);
    expect(visitors.results[0].sessions).toBe(1);

    expect(await aggValue(day, 'pageviews')).toBe(1);
    expect(await aggValue(day, 'visitors')).toBe(1);
    expect(await aggValue(day, 'sessions')).toBe(1);
    expect(await aggValue(day, 'pageviews', 'channel', 'direct')).toBe(1);
    expect(await aggValue(day, 'pageviews', 'device_type', 'desktop')).toBe(1);
  });

  it('is idempotent: a second tick does not double-count', async () => {
    await ingest(pageviewBody());
    const now = Math.floor(Date.now() / 1000);
    const day = await dayOf(now);

    await rollup(env, now);
    await rollup(env, now);

    expect(await aggValue(day, 'pageviews')).toBe(1);
    const sessions = await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions').first<{
      n: number;
    }>();
    expect(sessions?.n).toBe(1);
  });

  it('splits events into separate sessions after a 30-minute gap', async () => {
    const base = Math.floor(Date.now() / 1000);
    await ingest(pageviewBody({ ts: base * 1000, event_id: 'gap_1' }));
    await ingest(pageviewBody({ ts: (base + 31 * 60) * 1000, event_id: 'gap_2' }));

    await rollup(env, base + 32 * 60);

    const sessions = await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE website_id = ?')
      .bind(TEST_SITE.id)
      .first<{ n: number }>();
    expect(sessions?.n).toBe(2);
  });

  it('deletes events older than the site retention window', async () => {
    await resetData({ retention_days: 30 });
    const now = Math.floor(Date.now() / 1000);
    const oldTs = now - 40 * 86400;

    // The beacon rejects ts outside ±24h, so seed the stale row directly.
    await env.DB.prepare(
      `INSERT INTO events (id, website_id, event_id, session_id, visitor_id, name, ts, path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        'old_event_1',
        TEST_SITE.id,
        'old_event_1',
        null,
        'old_visitor',
        'pageview',
        oldTs,
        '/',
        now,
      )
      .run();
    expect(await countEvents()).toBe(1);

    await rollup(env, now);
    expect(await countEvents()).toBe(0);
  });
});
