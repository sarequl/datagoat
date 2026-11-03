import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FunnelStep, FunnelStepType } from '../../api/types.ts';
import { FUNNEL_STEP_SCHEMA } from '../../utils/funnelSteps.ts';
import { sites } from '../fixtures.ts';
import {
  createFunnelDefinition,
  deleteFunnelDefinition,
  getFunnelDefinition,
  isFunnelNameTaken,
  listFunnelDefinitions,
  updateFunnelDefinition,
} from '../funnelStore.ts';
import { readJsonBody, sendJson } from '../http.ts';

const ADMIN_FUNNELS_PATTERN = /^\/api\/v1\/admin\/sites\/([^/]+)\/funnels(?:\/([^/]+))?$/;
const DEFINITION_KEYS = new Set(['name', 'isActive', 'maxGapSeconds', 'steps']);

function parseLimit(raw: string | null): number {
  const value = Number.parseInt(raw ?? '100', 10);
  if (!Number.isFinite(value) || value < 1) return 100;
  return Math.min(value, 1000);
}

function parseOffset(raw: string | null): number {
  const value = Number.parseInt(raw ?? '0', 10);
  if (!Number.isFinite(value) || value < 0) return 0;
  return value;
}

function invalidStep(step: unknown, index: number): string | null {
  if (typeof step !== 'object' || step === null || Array.isArray(step)) {
    return `Step ${index + 1} must be an object.`;
  }
  const record = step as Record<string, unknown>;
  const type = record.type;
  if (typeof type !== 'string' || !(type in FUNNEL_STEP_SCHEMA)) {
    return `Step ${index + 1} has an unknown type.`;
  }
  const schema = FUNNEL_STEP_SCHEMA[type as FunnelStepType];
  const allowed = new Set(['type', 'name', ...schema.fields.map((field) => field.name)]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) return `Step ${index + 1} has an unknown param: ${key}.`;
  }
  if (record.name !== undefined && record.name !== null && typeof record.name !== 'string') {
    return `Step ${index + 1} name must be a string.`;
  }
  for (const field of schema.fields) {
    const value = record[field.name];
    if (value === undefined || value === null || value === '') {
      if (field.required) return `Step ${index + 1} is missing ${field.name}.`;
      continue;
    }
    if (field.kind === 'string' && typeof value !== 'string') {
      return `Step ${index + 1} ${field.name} must be a string.`;
    }
    if (field.kind === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
      return `Step ${index + 1} ${field.name} must be a number.`;
    }
    if (field.kind === 'boolean' && typeof value !== 'boolean') {
      return `Step ${index + 1} ${field.name} must be a boolean.`;
    }
    if (
      field.kind === 'device' &&
      value !== 'desktop' &&
      value !== 'mobile' &&
      value !== 'tablet'
    ) {
      return `Step ${index + 1} ${field.name} must be desktop, mobile, or tablet.`;
    }
  }
  for (const group of schema.groups ?? []) {
    const present = group.fields.filter((name) => {
      const value = record[name];
      return value !== undefined && value !== null && value !== '';
    });
    if (present.length < group.min) {
      return `Step ${index + 1} requires one of ${group.fields.join(', ')}.`;
    }
  }
  if (type === 'scrollDepth') {
    const value = record.scrollPercent;
    if (typeof value === 'number' && (value < 0 || value > 100)) {
      return `Step ${index + 1} scrollPercent must be between 0 and 100.`;
    }
  }
  return null;
}

function parseSteps(raw: unknown): { steps?: FunnelStep[]; error?: string } {
  if (!Array.isArray(raw)) return { error: 'steps must be an array.' };
  if (raw.length < 2 || raw.length > 8) return { error: 'steps must contain 2-8 items.' };
  for (let index = 0; index < raw.length; index += 1) {
    const error = invalidStep(raw[index], index);
    if (error) return { error };
  }
  return { steps: raw as unknown as FunnelStep[] };
}

function parseDefinitionBody(
  raw: Record<string, unknown>,
  options: { partial: boolean },
): {
  name?: string;
  isActive?: boolean;
  maxGapSeconds?: number | null;
  steps?: FunnelStep[];
  error?: string;
} {
  for (const key of Object.keys(raw)) {
    if (!DEFINITION_KEYS.has(key)) return { error: `Unknown field: ${key}.` };
  }

  const result: {
    name?: string;
    isActive?: boolean;
    maxGapSeconds?: number | null;
    steps?: FunnelStep[];
  } = {};

  if (raw.name !== undefined) {
    if (typeof raw.name !== 'string' || raw.name.length < 1 || raw.name.length > 100) {
      return { error: 'name must be 1-100 characters.' };
    }
    result.name = raw.name;
  } else if (!options.partial) {
    return { error: 'name is required.' };
  }

  if (raw.isActive !== undefined) {
    if (typeof raw.isActive !== 'boolean') return { error: 'isActive must be a boolean.' };
    result.isActive = raw.isActive;
  }

  if (raw.maxGapSeconds !== undefined) {
    if (
      raw.maxGapSeconds !== null &&
      (typeof raw.maxGapSeconds !== 'number' ||
        !Number.isInteger(raw.maxGapSeconds) ||
        raw.maxGapSeconds <= 0)
    ) {
      return { error: 'maxGapSeconds must be a positive integer or null.' };
    }
    result.maxGapSeconds = raw.maxGapSeconds;
  }

  if (raw.steps !== undefined) {
    const parsed = parseSteps(raw.steps);
    if (parsed.error) return { error: parsed.error };
    result.steps = parsed.steps;
  } else if (!options.partial) {
    return { error: 'steps is required.' };
  }

  if (options.partial && Object.keys(raw).length === 0) {
    return { error: 'At least one field is required.' };
  }

  return result;
}

export async function handleAdminFunnels(
  method: string,
  path: string,
  url: URL,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const match = ADMIN_FUNNELS_PATTERN.exec(path);
  if (!match) {
    sendJson(response, 404, {
      error: { code: 404, message: `Unknown admin funnel route ${method} ${path}` },
    });
    return;
  }

  const siteId = decodeURIComponent(match[1]);
  const funnelId = match[2] ? decodeURIComponent(match[2]) : undefined;
  if (!sites.some((site) => site.id === siteId)) {
    sendJson(response, 404, { error: { code: 404, message: `Site not found: ${siteId}` } });
    return;
  }
  if (url.searchParams.has('siteId')) {
    sendJson(response, 400, {
      error: {
        code: 400,
        message: 'siteId query parameter is not allowed on admin funnel routes.',
      },
    });
    return;
  }

  if (!funnelId) {
    if (method === 'GET') {
      const limit = parseLimit(url.searchParams.get('limit'));
      const offset = parseOffset(url.searchParams.get('offset'));
      const order = url.searchParams.get('order') === 'asc' ? 'asc' : 'desc';
      const { data, total } = listFunnelDefinitions({ limit, offset, order });
      sendJson(response, 200, {
        data,
        pagination: {
          limit,
          offset,
          total,
          hasMore: offset + data.length < total,
        },
      });
      return;
    }

    if (method === 'POST') {
      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(request);
      } catch {
        sendJson(response, 400, { error: { code: 400, message: 'Invalid JSON body' } });
        return;
      }
      const parsed = parseDefinitionBody(body, { partial: false });
      if (parsed.error) {
        sendJson(response, 400, { error: { code: 400, message: parsed.error } });
        return;
      }
      if (isFunnelNameTaken(parsed.name ?? '')) {
        sendJson(response, 409, {
          error: { code: 409, message: `Funnel name already exists: ${parsed.name}` },
        });
        return;
      }
      const definition = createFunnelDefinition({
        name: parsed.name ?? '',
        isActive: parsed.isActive ?? true,
        maxGapSeconds: parsed.maxGapSeconds ?? null,
        steps: parsed.steps ?? [],
      });
      sendJson(response, 201, { data: definition });
      return;
    }

    sendJson(response, 405, { error: { code: 405, message: 'Method not allowed' } });
    return;
  }

  if (method === 'PATCH') {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(request);
    } catch {
      sendJson(response, 400, { error: { code: 400, message: 'Invalid JSON body' } });
      return;
    }
    const parsed = parseDefinitionBody(body, { partial: true });
    if (parsed.error) {
      sendJson(response, 400, { error: { code: 400, message: parsed.error } });
      return;
    }
    if (!getFunnelDefinition(funnelId)) {
      sendJson(response, 404, { error: { code: 404, message: `Unknown funnel: ${funnelId}` } });
      return;
    }
    if (parsed.name !== undefined && isFunnelNameTaken(parsed.name, funnelId)) {
      sendJson(response, 409, {
        error: { code: 409, message: `Funnel name already exists: ${parsed.name}` },
      });
      return;
    }
    const updated = updateFunnelDefinition(funnelId, {
      ...(parsed.name !== undefined ? { name: parsed.name } : {}),
      ...(parsed.isActive !== undefined ? { isActive: parsed.isActive } : {}),
      ...(parsed.maxGapSeconds !== undefined ? { maxGapSeconds: parsed.maxGapSeconds } : {}),
      ...(parsed.steps !== undefined ? { steps: parsed.steps } : {}),
    });
    if (!updated) {
      sendJson(response, 404, { error: { code: 404, message: `Unknown funnel: ${funnelId}` } });
      return;
    }
    sendJson(response, 200, { data: updated });
    return;
  }

  if (method === 'DELETE') {
    if (!getFunnelDefinition(funnelId)) {
      sendJson(response, 404, { error: { code: 404, message: `Unknown funnel: ${funnelId}` } });
      return;
    }
    deleteFunnelDefinition(funnelId);
    response.statusCode = 204;
    response.end();
    return;
  }

  sendJson(response, 405, { error: { code: 405, message: 'Method not allowed' } });
}
