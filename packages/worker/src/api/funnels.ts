import type { Env, Website } from '../env';
import { hostOf, ulid } from '../util/ids';
import { requireOwner } from './auth';
import { loadVisitorRevenue } from './revenue';
import {
  checkQueryParams,
  error,
  iso,
  json,
  noContent,
  pagination,
  parseOrder,
  parsePagination,
  readJsonBody,
  resolveOwnedSite,
  round2,
  round4,
} from './util';

// ---------------------------------------------------------------------------
// Step predicates (§2.8.1)
// ---------------------------------------------------------------------------

interface StepField {
  name: string;
  kind: 'string' | 'number' | 'boolean' | 'device';
  required: boolean;
}

interface StepGroup {
  fields: string[];
  min: number;
}

const STEP_SCHEMA: Record<string, { fields: StepField[]; groups?: StepGroup[] }> = {
  page: { fields: [{ name: 'path', kind: 'string', required: true }] },
  pageContains: { fields: [{ name: 'pathContains', kind: 'string', required: true }] },
  goal: { fields: [{ name: 'goal', kind: 'string', required: true }] },
  country: { fields: [{ name: 'country', kind: 'string', required: true }] },
  referrer: {
    fields: [
      { name: 'referrer', kind: 'string', required: false },
      { name: 'referrerContains', kind: 'string', required: false },
    ],
    groups: [{ fields: ['referrer', 'referrerContains'], min: 1 }],
  },
  device: { fields: [{ name: 'device', kind: 'device', required: true }] },
  host: { fields: [{ name: 'host', kind: 'string', required: true }] },
  utm: {
    fields: [
      { name: 'utmSource', kind: 'string', required: false },
      { name: 'utmCampaign', kind: 'string', required: false },
    ],
    groups: [{ fields: ['utmSource', 'utmCampaign'], min: 1 }],
  },
  isCustomer: { fields: [{ name: 'isCustomer', kind: 'boolean', required: true }] },
  scrollDepth: { fields: [{ name: 'scrollPercent', kind: 'number', required: true }] },
};

interface StoredStep {
  type: string;
  params: Record<string, unknown>;
  name: string;
}

interface FunnelRow {
  id: string;
  website_id: string;
  name: string;
  is_active: number;
  max_gap_seconds: number | null;
  created_at: number;
  updated_at: number | null;
  deleted_at: number | null;
}

interface StepRow {
  position: number;
  type: string;
  params: string;
  name: string | null;
}

interface DefinitionValues {
  name?: string;
  isActive?: boolean;
  maxGapSeconds?: number | null;
  steps?: StoredStep[];
}

function deriveStepName(type: string, params: Record<string, unknown>): string {
  switch (type) {
    case 'page':
      return params.path ? `Page ${params.path}` : 'Page';
    case 'pageContains':
      return params.pathContains ? `Page contains ${params.pathContains}` : 'Page contains';
    case 'goal':
      return params.goal ? `Goal ${params.goal}` : 'Goal';
    case 'country':
      return params.country ? `Country ${params.country}` : 'Country';
    case 'referrer':
      if (params.referrer) return `Referrer ${params.referrer}`;
      return params.referrerContains ? `Referrer contains ${params.referrerContains}` : 'Referrer';
    case 'device':
      return params.device ? `Device ${params.device}` : 'Device';
    case 'host':
      return params.host ? `Hostname ${params.host}` : 'Hostname';
    case 'utm': {
      const source = typeof params.utmSource === 'string' ? params.utmSource : '';
      const campaign = typeof params.utmCampaign === 'string' ? ` / ${params.utmCampaign}` : '';
      return source || params.utmCampaign ? `UTM ${source}${campaign}`.trim() : 'UTM';
    }
    case 'isCustomer':
      return params.isCustomer ? 'Customers' : 'Non-customers';
    case 'scrollDepth':
      return `Scroll ${params.scrollPercent ?? 0}%`;
    default:
      return 'Step';
  }
}

function validateStep(raw: unknown, index: number): { step?: StoredStep; error?: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { error: `Step ${index + 1} must be an object.` };
  }
  const record = raw as Record<string, unknown>;
  const type = record.type;
  if (typeof type !== 'string' || !(type in STEP_SCHEMA)) {
    return { error: `Step ${index + 1} has an unknown type.` };
  }
  const schema = STEP_SCHEMA[type];
  const allowed = new Set(['type', 'name', ...schema.fields.map((field) => field.name)]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) return { error: `Step ${index + 1} has an unknown param: ${key}.` };
  }
  if (record.name !== undefined && record.name !== null && typeof record.name !== 'string') {
    return { error: `Step ${index + 1} name must be a string.` };
  }

  const params: Record<string, unknown> = {};
  for (const field of schema.fields) {
    const value = record[field.name];
    if (value === undefined || value === null || value === '') {
      if (field.required) return { error: `Step ${index + 1} is missing ${field.name}.` };
      continue;
    }
    if (field.kind === 'string' && typeof value !== 'string') {
      return { error: `Step ${index + 1} ${field.name} must be a string.` };
    }
    if (field.kind === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
      return { error: `Step ${index + 1} ${field.name} must be a number.` };
    }
    if (field.kind === 'boolean' && typeof value !== 'boolean') {
      return { error: `Step ${index + 1} ${field.name} must be a boolean.` };
    }
    if (
      field.kind === 'device' &&
      value !== 'desktop' &&
      value !== 'mobile' &&
      value !== 'tablet'
    ) {
      return { error: `Step ${index + 1} ${field.name} must be desktop, mobile, or tablet.` };
    }
    params[field.name] = value;
  }

  for (const group of schema.groups ?? []) {
    const present = group.fields.filter((name) => {
      const value = record[name];
      return value !== undefined && value !== null && value !== '';
    });
    if (present.length < group.min) {
      return { error: `Step ${index + 1} requires one of ${group.fields.join(', ')}.` };
    }
  }

  if (type === 'scrollDepth') {
    const value = record.scrollPercent;
    if (typeof value === 'number' && (value < 0 || value > 100)) {
      return { error: `Step ${index + 1} scrollPercent must be between 0 and 100.` };
    }
  }

  const name =
    typeof record.name === 'string' && record.name.length > 0
      ? record.name
      : deriveStepName(type, params);
  return { step: { type, params, name } };
}

function parseDefinitionBody(
  body: Record<string, unknown>,
  partial: boolean,
): { values?: DefinitionValues; error?: string } {
  for (const key of Object.keys(body)) {
    if (!['name', 'isActive', 'maxGapSeconds', 'steps'].includes(key)) {
      return { error: `Unknown field: ${key}.` };
    }
  }

  const values: DefinitionValues = {};

  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || body.name.length < 1 || body.name.length > 100) {
      return { error: 'name must be 1-100 characters.' };
    }
    values.name = body.name;
  } else if (!partial) {
    return { error: 'name is required.' };
  }

  if (body.isActive !== undefined) {
    if (typeof body.isActive !== 'boolean') return { error: 'isActive must be a boolean.' };
    values.isActive = body.isActive;
  }

  if (body.maxGapSeconds !== undefined) {
    if (
      body.maxGapSeconds !== null &&
      (typeof body.maxGapSeconds !== 'number' ||
        !Number.isInteger(body.maxGapSeconds) ||
        body.maxGapSeconds <= 0)
    ) {
      return { error: 'maxGapSeconds must be a positive integer or null.' };
    }
    values.maxGapSeconds = body.maxGapSeconds;
  }

  if (body.steps !== undefined) {
    if (!Array.isArray(body.steps)) return { error: 'steps must be an array.' };
    if (body.steps.length < 2 || body.steps.length > 8) {
      return { error: 'steps must contain 2-8 items.' };
    }
    const steps: StoredStep[] = [];
    for (let index = 0; index < body.steps.length; index += 1) {
      const parsed = validateStep(body.steps[index], index);
      if (parsed.error) return { error: parsed.error };
      steps.push(parsed.step as StoredStep);
    }
    values.steps = steps;
  } else if (!partial) {
    return { error: 'steps is required.' };
  }

  if (partial && Object.keys(body).length === 0) {
    return { error: 'At least one field is required.' };
  }

  return { values };
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

async function fetchSteps(env: Env, funnelId: string): Promise<StepRow[]> {
  const rows = await env.DB.prepare(
    'SELECT position, type, params, name FROM funnel_steps WHERE funnel_id = ? ORDER BY position',
  )
    .bind(funnelId)
    .all<StepRow>();
  return rows.results;
}

function toWireStep(row: StepRow): Record<string, unknown> {
  let params: Record<string, unknown> = {};
  try {
    params = JSON.parse(row.params) as Record<string, unknown>;
  } catch {
    params = {};
  }
  return { type: row.type, ...params, name: row.name ?? deriveStepName(row.type, params) };
}

async function toWireFunnel(env: Env, row: FunnelRow): Promise<Record<string, unknown>> {
  const steps = await fetchSteps(env, row.id);
  return {
    id: row.id,
    name: row.name,
    isActive: row.is_active === 1,
    maxGapSeconds: row.max_gap_seconds,
    steps: steps.map(toWireStep),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at ?? row.created_at),
  };
}

async function replaceSteps(env: Env, funnelId: string, steps: StoredStep[]): Promise<void> {
  await env.DB.prepare('DELETE FROM funnel_steps WHERE funnel_id = ?').bind(funnelId).run();
  const insert = env.DB.prepare(
    `INSERT INTO funnel_steps (id, funnel_id, position, type, params, name, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch(
    steps.map((step, index) =>
      insert.bind(
        `fstep_${ulid()}`,
        funnelId,
        index + 1,
        step.type,
        JSON.stringify(step.params),
        step.name,
        now,
      ),
    ),
  );
}

async function findFunnel(env: Env, siteId: string, funnelId: string): Promise<FunnelRow | null> {
  return env.DB.prepare(
    'SELECT * FROM funnels WHERE id = ? AND website_id = ? AND deleted_at IS NULL',
  )
    .bind(funnelId, siteId)
    .first<FunnelRow>();
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

async function listFunnels(env: Env, url: URL, siteId: string): Promise<Response> {
  const queryError = checkQueryParams(url, ['limit', 'offset', 'order']);
  if (queryError) return queryError;
  const { limit, offset, error: pageError } = parsePagination(url);
  if (pageError) return pageError;
  const { order, error: orderError } = parseOrder(url);
  if (orderError) return orderError;

  const total = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM funnels WHERE website_id = ? AND deleted_at IS NULL',
  )
    .bind(siteId)
    .first<{ n: number }>();
  const direction = order === 'asc' ? 'ASC' : 'DESC';
  const rows = await env.DB.prepare(
    `SELECT id, name, is_active, max_gap_seconds, created_at, updated_at
     FROM funnels
     WHERE website_id = ? AND deleted_at IS NULL
     ORDER BY created_at ${direction}, id ${direction}
     LIMIT ? OFFSET ?`,
  )
    .bind(siteId, limit, offset)
    .all<FunnelRow>();

  const data = [];
  for (const row of rows.results) data.push(await toWireFunnel(env, row));
  return json({ data, pagination: pagination(limit, offset, total?.n ?? 0) });
}

async function createFunnel(
  request: Request,
  env: Env,
  url: URL,
  siteId: string,
): Promise<Response> {
  const queryError = checkQueryParams(url, []);
  if (queryError) return queryError;

  const body = await readJsonBody(request);
  if (body === null) return error(400, 'Invalid JSON body');
  const { values, error: validationError } = parseDefinitionBody(body, false);
  if (validationError || !values) return error(400, validationError ?? 'Invalid body');

  const name = values.name as string;
  const duplicate = await env.DB.prepare(
    'SELECT id FROM funnels WHERE website_id = ? AND name = ? AND deleted_at IS NULL',
  )
    .bind(siteId, name)
    .first<{ id: string }>();
  if (duplicate) return error(409, `Funnel name already exists: ${name}`);

  const id = `fun_${ulid()}`;
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO funnels (id, website_id, name, is_active, max_gap_seconds, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      siteId,
      name,
      values.isActive === false ? 0 : 1,
      values.maxGapSeconds ?? null,
      now,
      now,
    )
    .run();

  await replaceSteps(env, id, values.steps as StoredStep[]);
  const row = await findFunnel(env, siteId, id);
  return json({ data: await toWireFunnel(env, row as FunnelRow) }, 201);
}

async function updateFunnel(
  request: Request,
  env: Env,
  url: URL,
  siteId: string,
  funnelId: string,
): Promise<Response> {
  const queryError = checkQueryParams(url, []);
  if (queryError) return queryError;

  const existing = await findFunnel(env, siteId, funnelId);
  if (!existing) return error(404, `Unknown funnel: ${funnelId}`);

  const body = await readJsonBody(request);
  if (body === null) return error(400, 'Invalid JSON body');
  const { values, error: validationError } = parseDefinitionBody(body, true);
  if (validationError || !values) return error(400, validationError ?? 'Invalid body');

  if (values.name !== undefined) {
    const duplicate = await env.DB.prepare(
      'SELECT id FROM funnels WHERE website_id = ? AND name = ? AND id != ? AND deleted_at IS NULL',
    )
      .bind(siteId, values.name, funnelId)
      .first<{ id: string }>();
    if (duplicate) return error(409, `Funnel name already exists: ${values.name}`);
  }

  const next = {
    name: values.name ?? existing.name,
    is_active: values.isActive !== undefined ? (values.isActive ? 1 : 0) : existing.is_active,
    max_gap_seconds:
      values.maxGapSeconds !== undefined ? values.maxGapSeconds : existing.max_gap_seconds,
    updated_at: Math.floor(Date.now() / 1000),
  };

  await env.DB.prepare(
    'UPDATE funnels SET name = ?, is_active = ?, max_gap_seconds = ?, updated_at = ? WHERE id = ?',
  )
    .bind(next.name, next.is_active, next.max_gap_seconds, next.updated_at, funnelId)
    .run();

  if (values.steps) await replaceSteps(env, funnelId, values.steps);
  const row = await findFunnel(env, siteId, funnelId);
  return json({ data: await toWireFunnel(env, row as FunnelRow) });
}

async function deleteFunnel(
  env: Env,
  url: URL,
  siteId: string,
  funnelId: string,
): Promise<Response> {
  const queryError = checkQueryParams(url, []);
  if (queryError) return queryError;
  const existing = await findFunnel(env, siteId, funnelId);
  if (!existing) return error(404, `Unknown funnel: ${funnelId}`);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare('UPDATE funnels SET deleted_at = ?, updated_at = ? WHERE id = ?')
    .bind(now, now, funnelId)
    .run();
  return noContent();
}

export async function handleAdminFunnels(
  request: Request,
  env: Env,
  url: URL,
  method: string,
  siteId: string,
  funnelId?: string,
): Promise<Response> {
  const owner = await requireOwner(request, env);
  if (owner.error) return owner.error;
  const userId = owner.userId as string;

  const { error: siteError } = await resolveOwnedSite(env, userId, siteId);
  if (siteError) return siteError;

  if (funnelId === undefined) {
    if (method === 'GET') return listFunnels(env, url, siteId);
    if (method === 'POST') return createFunnel(request, env, url, siteId);
    return error(405, 'Method not allowed');
  }

  if (method === 'PATCH') return updateFunnel(request, env, url, siteId, funnelId);
  if (method === 'DELETE') return deleteFunnel(env, url, siteId, funnelId);
  return error(405, 'Method not allowed');
}

// ---------------------------------------------------------------------------
// Funnel results (§2.7.3)
// ---------------------------------------------------------------------------

interface FunnelEvent {
  session_id: string;
  visitor_id: string;
  ts: number;
  name: string;
  path: string | null;
  referrer: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  device_type: string | null;
  os: string | null;
  browser: string | null;
  hostname: string | null;
  utm_source: string | null;
  utm_campaign: string | null;
  props: string | null;
}

function readScrollDepth(props: string | null): number | null {
  if (!props) return null;
  try {
    const parsed = JSON.parse(props) as { scroll_depth?: unknown };
    return typeof parsed.scroll_depth === 'number' ? parsed.scroll_depth : null;
  } catch {
    return null;
  }
}

function matchesStep(
  step: StoredStep,
  event: FunnelEvent,
  visitorId: string,
  buyerByVisitor: Map<string, boolean>,
): boolean {
  const params = step.params;
  switch (step.type) {
    case 'page':
      return event.name === 'pageview' && event.path === params.path;
    case 'pageContains':
      return event.name === 'pageview' && (event.path ?? '').includes(String(params.pathContains));
    case 'goal':
      return event.name === params.goal;
    case 'country':
      return event.country === params.country;
    case 'referrer': {
      const host = event.referrer ? hostOf(event.referrer) : null;
      if (params.referrer !== undefined) return host === params.referrer;
      if (params.referrerContains !== undefined) {
        return host?.includes(String(params.referrerContains)) ?? false;
      }
      return false;
    }
    case 'device':
      return event.device_type === params.device;
    case 'host':
      return event.hostname === params.host;
    case 'utm': {
      if (params.utmSource !== undefined && event.utm_source !== params.utmSource) return false;
      if (params.utmCampaign !== undefined && event.utm_campaign !== params.utmCampaign) {
        return false;
      }
      return true;
    }
    case 'isCustomer':
      return (buyerByVisitor.get(visitorId) ?? false) === params.isCustomer;
    case 'scrollDepth': {
      if (event.name !== 'scroll') return false;
      const depth = readScrollDepth(event.props);
      return depth !== null && depth >= Number(params.scrollPercent);
    }
    default:
      return false;
  }
}

export async function handleFunnelResult(
  env: Env,
  site: Website,
  funnelId: string,
  range: {
    start: number;
    end: number;
    startRaw: string | null;
    endRaw: string | null;
    timeZone: string;
  },
): Promise<Response> {
  const funnel = await findFunnel(env, site.id, funnelId);
  if (funnel?.is_active !== 1) return error(404, `Unknown funnel: ${funnelId}`);

  const stepRows = await fetchSteps(env, funnelId);
  const steps: StoredStep[] = stepRows.map((row) => {
    let params: Record<string, unknown> = {};
    try {
      params = JSON.parse(row.params) as Record<string, unknown>;
    } catch {
      params = {};
    }
    return { type: row.type, params, name: row.name ?? deriveStepName(row.type, params) };
  });

  // §2.6: a scroll-depth step is dropped when the site has no scroll events.
  const hasScroll = await env.DB.prepare(
    'SELECT 1 FROM events WHERE website_id = ? AND name = ? LIMIT 1',
  )
    .bind(site.id, 'scroll')
    .first();

  const effectiveSteps = steps.filter((step) => {
    if (step.type === 'scrollDepth' && !hasScroll) {
      console.warn(`funnel ${funnelId}: dropping scrollDepth step (no scroll events)`);
      return false;
    }
    return true;
  });

  if (effectiveSteps.length < 2) {
    return error(400, 'Funnel must have at least two supported steps');
  }

  const sessionRows = await env.DB.prepare(
    `SELECT DISTINCT session_id, visitor_id
     FROM events
     WHERE website_id = ? AND ts >= ? AND ts <= ? AND is_bot = 0 AND session_id IS NOT NULL`,
  )
    .bind(site.id, range.start, range.end)
    .all<{ session_id: string; visitor_id: string }>();

  const visitorBySession = new Map<string, string>();
  for (const row of sessionRows.results) visitorBySession.set(row.session_id, row.visitor_id);

  const eventRows = await env.DB.prepare(
    `SELECT session_id, visitor_id, ts, name, path, referrer, country, region, city,
            device_type, os, browser, hostname, utm_source, utm_campaign, props
     FROM events
     WHERE website_id = ? AND ts >= ? AND ts <= ? AND is_bot = 0 AND session_id IS NOT NULL
     ORDER BY session_id, ts, id`,
  )
    .bind(site.id, range.start, range.end)
    .all<FunnelEvent>();

  const eventsBySession = new Map<string, FunnelEvent[]>();
  for (const row of eventRows.results) {
    const list = eventsBySession.get(row.session_id) ?? [];
    list.push(row);
    eventsBySession.set(row.session_id, list);
  }

  const buyerRows = await env.DB.prepare(
    'SELECT visitor_id, is_buyer FROM visitors WHERE website_id = ?',
  )
    .bind(site.id)
    .all<{ visitor_id: string; is_buyer: number }>();
  const buyerByVisitor = new Map<string, boolean>(
    buyerRows.results.map((row) => [row.visitor_id, row.is_buyer === 1]),
  );

  const stepVisitors: Array<Set<string>> = effectiveSteps.map(() => new Set<string>());
  for (const [sessionId, sessionEvents] of eventsBySession) {
    const visitorId = visitorBySession.get(sessionId);
    if (!visitorId) continue;
    let current = 0;
    let lastMatchTs: number | null = null;
    for (const event of sessionEvents) {
      if (current >= effectiveSteps.length) break;
      if (!matchesStep(effectiveSteps[current], event, visitorId, buyerByVisitor)) continue;
      if (
        current > 0 &&
        funnel.max_gap_seconds !== null &&
        lastMatchTs !== null &&
        event.ts - lastMatchTs > funnel.max_gap_seconds
      ) {
        break;
      }
      stepVisitors[current].add(visitorId);
      lastMatchTs = event.ts;
      current += 1;
    }
  }

  const visitorRevenue = await loadVisitorRevenue(env, site, range.start, range.end);
  const stepRevenueCents = effectiveSteps.map(() => 0);
  const stepPayments = effectiveSteps.map(() => 0);
  for (let index = 0; index < effectiveSteps.length; index += 1) {
    for (const visitor of stepVisitors[index]) {
      const entry = visitorRevenue.get(visitor);
      if (entry) {
        stepRevenueCents[index] += entry.revenueCents;
        stepPayments[index] += entry.payments;
      }
    }
  }

  const totalVisitors = stepVisitors[0].size;
  const lastIndex = effectiveSteps.length - 1;
  const lastVisitors = stepVisitors[lastIndex].size;
  const revenueCents = stepRevenueCents[lastIndex];
  const payments = stepPayments[lastIndex];

  const stepResults = effectiveSteps.map((step, index) => {
    const visitors = stepVisitors[index].size;
    const previousVisitors = index > 0 ? stepVisitors[index - 1].size : 0;
    return {
      step: index + 1,
      name: step.name,
      visitors,
      conversionRate: totalVisitors > 0 ? round4(visitors / totalVisitors) : 0,
      dropoffRate:
        index === 0 || previousVisitors === 0 ? 0 : round4(1 - visitors / previousVisitors),
      revenue: round2(stepRevenueCents[index] / 100),
      payments: stepPayments[index],
    };
  });

  return json({
    data: {
      id: funnel.id,
      name: funnel.name,
      steps: stepResults,
      totalVisitors,
      totalConversionRate: totalVisitors > 0 ? round4(lastVisitors / totalVisitors) : 0,
      revenue: round2(revenueCents / 100),
      payments,
      revenuePerVisitor: totalVisitors > 0 ? round2(revenueCents / 100 / totalVisitors) : 0,
      timezone: range.timeZone,
      startAt: range.startRaw,
      endAt: range.endRaw,
      lastUpdated: iso(Math.floor(Date.now() / 1000)),
    },
  });
}
