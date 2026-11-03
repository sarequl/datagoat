import type { FunnelDefinition, FunnelResult, FunnelStep } from '../api/types.ts';
import { funnelStepLabel } from '../utils/funnelSteps.ts';
import { funnelDefinitions, funnelResults } from './fixtures.ts';

interface FunnelDefinitionPatch {
  name?: string;
  isActive?: boolean;
  maxGapSeconds?: number | null;
  steps?: FunnelStep[];
}

function cloneDefinition(definition: FunnelDefinition): FunnelDefinition {
  return {
    ...definition,
    steps: definition.steps.map((step) => ({ ...step })),
  };
}

function round4(value: number): number {
  return Number(value.toFixed(4));
}

/**
 * New funnels have no stored result yet. The mock derives a deterministic one
 * from the definition so the builder can show results immediately.
 */
function buildResult(definition: FunnelDefinition): FunnelResult {
  const totalVisitors: number = 1204;
  let previous = totalVisitors;
  const steps = definition.steps.map((step, index) => {
    const visitors = index === 0 ? totalVisitors : Math.max(1, Math.round(previous * 0.55));
    const revenue = step.type === 'goal' && step.goal === 'payment' ? 5310.5 : 0;
    const payments = revenue > 0 ? 42 : 0;
    const result = {
      step: index + 1,
      name: step.name ?? funnelStepLabel(step),
      visitors,
      conversionRate: round4(visitors / totalVisitors),
      dropoffRate: index === 0 ? 0 : round4(1 - visitors / previous),
      revenue,
      payments,
    };
    previous = visitors;
    return result;
  });
  const last = steps[steps.length - 1];
  const revenue = steps.reduce((sum, step) => sum + step.revenue, 0);
  const payments = steps.reduce((sum, step) => sum + step.payments, 0);
  return {
    id: definition.id,
    name: definition.name,
    steps,
    totalVisitors,
    totalConversionRate: last?.conversionRate ?? 0,
    revenue,
    payments,
    revenuePerVisitor: totalVisitors === 0 ? 0 : round4(revenue / totalVisitors),
    timezone: 'UTC',
    startAt: null,
    endAt: null,
    lastUpdated: new Date().toISOString(),
  };
}

const definitions = new Map<string, FunnelDefinition>();
const results = new Map<string, FunnelResult>();
const deleted = new Set<string>();
let nextId = 1;

for (const definition of funnelDefinitions) {
  definitions.set(definition.id, cloneDefinition(definition));
  const numeric = Number(definition.id.replace(/\D+/g, ''));
  if (Number.isFinite(numeric) && numeric >= nextId) {
    nextId = numeric + 1;
  }
}
for (const [id, result] of Object.entries(funnelResults)) {
  results.set(id, result);
}

export function listFunnelDefinitions(options: {
  limit: number;
  offset: number;
  order: 'asc' | 'desc';
}): { data: FunnelDefinition[]; total: number } {
  const all = [...definitions.values()]
    .filter((definition) => !deleted.has(definition.id))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (options.order === 'desc') all.reverse();
  return {
    data: all.slice(options.offset, options.offset + options.limit).map(cloneDefinition),
    total: all.length,
  };
}

export function getFunnelDefinition(id: string): FunnelDefinition | undefined {
  const definition = definitions.get(id);
  if (!definition || deleted.has(id)) return undefined;
  return cloneDefinition(definition);
}

/** `api.md` §2.7.3: inactive or unknown funnels return 404 on the results route. */
export function isFunnelEvaluable(id: string): boolean {
  const definition = definitions.get(id);
  return Boolean(definition) && !deleted.has(id) && definition?.isActive === true;
}

export function getFunnelResult(id: string): FunnelResult | undefined {
  if (!isFunnelEvaluable(id)) return undefined;
  return results.get(id);
}

export function isFunnelNameTaken(name: string, ignoreId?: string): boolean {
  return [...definitions.values()].some(
    (definition) =>
      definition.id !== ignoreId && !deleted.has(definition.id) && definition.name === name,
  );
}

export function createFunnelDefinition(input: {
  name: string;
  isActive: boolean;
  maxGapSeconds: number | null;
  steps: FunnelStep[];
}): FunnelDefinition {
  const now = new Date().toISOString();
  const definition: FunnelDefinition = {
    id: `fun_${nextId}`,
    name: input.name,
    isActive: input.isActive,
    maxGapSeconds: input.maxGapSeconds,
    steps: input.steps,
    createdAt: now,
    updatedAt: now,
  };
  nextId += 1;
  definitions.set(definition.id, definition);
  results.set(definition.id, buildResult(definition));
  return cloneDefinition(definition);
}

export function updateFunnelDefinition(
  id: string,
  patch: FunnelDefinitionPatch,
): FunnelDefinition | undefined {
  const existing = definitions.get(id);
  if (!existing || deleted.has(id)) return undefined;
  const updated: FunnelDefinition = { ...existing, updatedAt: new Date().toISOString() };
  if (patch.name !== undefined) updated.name = patch.name;
  if (patch.isActive !== undefined) updated.isActive = patch.isActive;
  if (patch.maxGapSeconds !== undefined) updated.maxGapSeconds = patch.maxGapSeconds;
  if (patch.steps !== undefined) updated.steps = patch.steps.map((step) => ({ ...step }));
  definitions.set(id, updated);
  results.set(id, buildResult(updated));
  return cloneDefinition(updated);
}

export function deleteFunnelDefinition(id: string): boolean {
  const existing = definitions.get(id);
  if (!existing || deleted.has(id)) return false;
  deleted.add(id);
  return true;
}
