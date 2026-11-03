import type { Env, Website } from '../env';
import { randomHex, ulid } from '../util/ids';
import { isValidTimeZone } from '../util/time';
import { requireOwner } from './auth';
import {
  checkQueryParams,
  error,
  iso,
  json,
  pagination,
  parsePagination,
  readJsonBody,
} from './util';

const COLLECTION_QUERY_KEYS: string[] = ['limit', 'offset'];
const ITEM_QUERY_KEYS: string[] = [];
const WRITABLE_FIELDS = ['name', 'domain', 'timezone', 'currency'] as const;

type WritableField = (typeof WRITABLE_FIELDS)[number];

function siteJson(site: Website, includeToken = false): Record<string, unknown> {
  return {
    id: site.id,
    name: site.name ? site.name : null,
    domain: site.domain,
    timezone: site.timezone,
    currency: site.currency,
    createdAt: iso(site.created_at),
    ...(includeToken ? { siteToken: site.site_token } : {}),
  };
}

function normalizeDomain(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.includes('://')) {
    try {
      return new URL(trimmed).hostname.toLowerCase();
    } catch {
      return trimmed;
    }
  }
  return trimmed.replace(/^\/+|\/+$/g, '');
}

function validateFields(
  body: Record<string, unknown>,
  partial: boolean,
): {
  values: Partial<Record<WritableField, string>>;
  error?: string;
} {
  for (const key of Object.keys(body)) {
    if (!(WRITABLE_FIELDS as readonly string[]).includes(key)) {
      return { values: {}, error: `Unknown field: ${key}` };
    }
  }

  const values: Partial<Record<WritableField, string>> = {};
  let provided = 0;

  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || body.name.length > 100) {
      return { values: {}, error: 'name must be a string of 100 characters or fewer' };
    }
    values.name = body.name;
    provided += 1;
  }

  if (body.domain !== undefined) {
    if (typeof body.domain !== 'string' || !normalizeDomain(body.domain)) {
      return { values: {}, error: 'domain must be a non-empty string' };
    }
    values.domain = normalizeDomain(body.domain);
    provided += 1;
  } else if (!partial) {
    return { values: {}, error: 'domain is required' };
  }

  if (body.timezone !== undefined) {
    if (typeof body.timezone !== 'string' || !isValidTimeZone(body.timezone)) {
      return { values: {}, error: 'timezone must be a valid IANA timezone' };
    }
    values.timezone = body.timezone;
    provided += 1;
  }

  if (body.currency !== undefined) {
    if (typeof body.currency !== 'string' || !/^[A-Za-z]{3}$/.test(body.currency)) {
      return { values: {}, error: 'currency must be a 3-letter ISO 4217 code' };
    }
    values.currency = body.currency.toUpperCase();
    provided += 1;
  }

  if (partial && provided === 0) {
    return { values: {}, error: 'At least one field is required' };
  }

  return { values };
}

async function findOwnedSite(env: Env, userId: string, siteId: string): Promise<Website | null> {
  const site = await env.DB.prepare('SELECT * FROM websites WHERE id = ?')
    .bind(siteId)
    .first<Website>();
  if (!site || site.owner_user_id !== userId) return null;
  return site;
}

async function handleCollection(
  request: Request,
  env: Env,
  url: URL,
  method: string,
  userId: string,
): Promise<Response> {
  if (method === 'GET') {
    const queryError = checkQueryParams(url, COLLECTION_QUERY_KEYS);
    if (queryError) return queryError;
    const { limit, offset, error: pageError } = parsePagination(url);
    if (pageError) return pageError;

    const total = await env.DB.prepare('SELECT COUNT(*) AS n FROM websites WHERE owner_user_id = ?')
      .bind(userId)
      .first<{ n: number }>();
    const rows = await env.DB.prepare(
      `SELECT id, name, domain, timezone, currency, created_at
       FROM websites WHERE owner_user_id = ?
       ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    )
      .bind(userId, limit, offset)
      .all<Website>();

    return json({
      data: rows.results.map((site) => siteJson(site)),
      pagination: pagination(limit, offset, total?.n ?? 0),
    });
  }

  if (method === 'POST') {
    const queryError = checkQueryParams(url, COLLECTION_QUERY_KEYS);
    if (queryError) return queryError;
    const body = await readJsonBody(request);
    if (body === null) return error(400, 'Invalid JSON body');

    const { values, error: validationError } = validateFields(body, false);
    if (validationError) return error(400, validationError);

    const domain = values.domain as string;
    const existing = await env.DB.prepare('SELECT id FROM websites WHERE domain = ?')
      .bind(domain)
      .first<{ id: string }>();
    if (existing) return error(409, `A site already exists for domain ${domain}`);

    const now = Math.floor(Date.now() / 1000);
    const site: Website = {
      id: `site_${ulid()}`,
      site_token: randomHex(16),
      name: values.name ?? domain,
      domain,
      timezone: values.timezone ?? 'UTC',
      currency: values.currency ?? 'USD',
      owner_user_id: userId,
      privacy_mode: 'cookies',
      allow_cookieless: 1,
      allowed_hosts: JSON.stringify([domain]),
      excluded_ips: '[]',
      excluded_paths: '[]',
      excluded_ua: '[]',
      hash_paths: 0,
      attribution_model: 'last_non_direct',
      retention_days: 365,
      bot_filter_level: 'standard',
      created_at: now,
      updated_at: now,
    };

    await env.DB.prepare(
      `INSERT INTO websites (
         id, site_token, name, domain, timezone, currency, owner_user_id, privacy_mode,
         allow_cookieless, allowed_hosts, excluded_ips, excluded_paths, excluded_ua,
         hash_paths, attribution_model, retention_days, bot_filter_level, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        site.id,
        site.site_token,
        site.name,
        site.domain,
        site.timezone,
        site.currency,
        site.owner_user_id,
        site.privacy_mode,
        site.allow_cookieless,
        site.allowed_hosts,
        site.excluded_ips,
        site.excluded_paths,
        site.excluded_ua,
        site.hash_paths,
        site.attribution_model,
        site.retention_days,
        site.bot_filter_level,
        site.created_at,
        site.updated_at,
      )
      .run();

    return json({ data: siteJson(site, true) }, 201);
  }

  return error(405, 'Method not allowed');
}

async function handleItem(
  request: Request,
  env: Env,
  url: URL,
  method: string,
  userId: string,
  siteId: string,
): Promise<Response> {
  const queryError = checkQueryParams(url, ITEM_QUERY_KEYS);
  if (queryError) return queryError;

  if (method === 'GET') {
    const site = await findOwnedSite(env, userId, siteId);
    if (!site) return error(404, 'Site not found');
    return json({ data: siteJson(site, true) });
  }

  if (method === 'PATCH') {
    const site = await findOwnedSite(env, userId, siteId);
    if (!site) return error(404, 'Site not found');

    const body = await readJsonBody(request);
    if (body === null) return error(400, 'Invalid JSON body');
    const { values, error: validationError } = validateFields(body, true);
    if (validationError) return error(400, validationError);

    if (values.domain && values.domain !== site.domain) {
      const existing = await env.DB.prepare('SELECT id FROM websites WHERE domain = ? AND id != ?')
        .bind(values.domain, siteId)
        .first<{ id: string }>();
      if (existing) return error(409, `A site already exists for domain ${values.domain}`);
    }

    const next: Website = {
      ...site,
      name: values.name ?? site.name,
      domain: values.domain ?? site.domain,
      timezone: values.timezone ?? site.timezone,
      currency: values.currency ?? site.currency,
      updated_at: Math.floor(Date.now() / 1000),
    };

    await env.DB.prepare(
      `UPDATE websites SET name = ?, domain = ?, timezone = ?, currency = ?, updated_at = ?
       WHERE id = ?`,
    )
      .bind(next.name, next.domain, next.timezone, next.currency, next.updated_at, siteId)
      .run();

    return json({ data: siteJson(next, true) });
  }

  return error(405, 'Method not allowed');
}

export async function handleAdminSites(
  request: Request,
  env: Env,
  url: URL,
  method: string,
  siteId?: string,
): Promise<Response> {
  const owner = await requireOwner(request, env);
  if (owner.error) return owner.error;
  const userId = owner.userId as string;

  if (siteId === undefined) return handleCollection(request, env, url, method, userId);
  return handleItem(request, env, url, method, userId, siteId);
}
