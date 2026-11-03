import type { FunnelStep, FunnelStepType } from '../api/types.ts';

export interface FunnelStepFieldSchema {
  name: string;
  kind: 'string' | 'number' | 'boolean' | 'device';
  required: boolean;
}

export interface FunnelStepGroupSchema {
  fields: string[];
  min: number;
}

export interface FunnelStepTypeSchema {
  label: string;
  fields: FunnelStepFieldSchema[];
  groups?: FunnelStepGroupSchema[];
}

// `api.md` §2.8.1: predicate params are flattened at the step level.
export const FUNNEL_STEP_SCHEMA: Record<FunnelStepType, FunnelStepTypeSchema> = {
  page: {
    label: 'Page equals',
    fields: [{ name: 'path', kind: 'string', required: true }],
  },
  pageContains: {
    label: 'Page contains',
    fields: [{ name: 'pathContains', kind: 'string', required: true }],
  },
  goal: {
    label: 'Goal',
    fields: [{ name: 'goal', kind: 'string', required: true }],
  },
  country: {
    label: 'Country',
    fields: [{ name: 'country', kind: 'string', required: true }],
  },
  referrer: {
    label: 'Referrer',
    fields: [
      { name: 'referrer', kind: 'string', required: false },
      { name: 'referrerContains', kind: 'string', required: false },
    ],
    groups: [{ fields: ['referrer', 'referrerContains'], min: 1 }],
  },
  device: {
    label: 'Device',
    fields: [{ name: 'device', kind: 'device', required: true }],
  },
  host: {
    label: 'Hostname',
    fields: [{ name: 'host', kind: 'string', required: true }],
  },
  utm: {
    label: 'UTM',
    fields: [
      { name: 'utmSource', kind: 'string', required: false },
      { name: 'utmCampaign', kind: 'string', required: false },
    ],
    groups: [{ fields: ['utmSource', 'utmCampaign'], min: 1 }],
  },
  isCustomer: {
    label: 'Customer status',
    fields: [{ name: 'isCustomer', kind: 'boolean', required: true }],
  },
  scrollDepth: {
    label: 'Scroll depth',
    fields: [{ name: 'scrollPercent', kind: 'number', required: true }],
  },
};

export const FUNNEL_STEP_TYPES = Object.keys(FUNNEL_STEP_SCHEMA) as FunnelStepType[];

export function emptyFunnelStep(type: FunnelStepType = 'page'): FunnelStep {
  switch (type) {
    case 'page':
      return { type, path: '' };
    case 'pageContains':
      return { type, pathContains: '' };
    case 'goal':
      return { type, goal: '' };
    case 'country':
      return { type, country: '' };
    case 'referrer':
      return { type, referrer: '' };
    case 'device':
      return { type, device: 'desktop' };
    case 'host':
      return { type, host: '' };
    case 'utm':
      return { type, utmSource: '', utmCampaign: '' };
    case 'isCustomer':
      return { type, isCustomer: true };
    case 'scrollDepth':
      return { type, scrollPercent: 50 };
  }
}

/** Derives a display label when a step has no user-provided name. */
export function funnelStepLabel(step: FunnelStep): string {
  if (step.name) return step.name;
  switch (step.type) {
    case 'page':
      return step.path ? `Page ${step.path}` : 'Page';
    case 'pageContains':
      return step.pathContains ? `Page contains ${step.pathContains}` : 'Page contains';
    case 'goal':
      return step.goal ? `Goal ${step.goal}` : 'Goal';
    case 'country':
      return step.country ? `Country ${step.country}` : 'Country';
    case 'referrer':
      if (step.referrer) return `Referrer ${step.referrer}`;
      return step.referrerContains ? `Referrer contains ${step.referrerContains}` : 'Referrer';
    case 'device':
      return step.device ? `Device ${step.device}` : 'Device';
    case 'host':
      return step.host ? `Hostname ${step.host}` : 'Hostname';
    case 'utm': {
      const source = step.utmSource ?? '';
      const campaign = step.utmCampaign ? ` / ${step.utmCampaign}` : '';
      return source || step.utmCampaign ? `UTM ${source}${campaign}`.trim() : 'UTM';
    }
    case 'isCustomer':
      return step.isCustomer ? 'Customers' : 'Non-customers';
    case 'scrollDepth':
      return `Scroll ${step.scrollPercent ?? 0}%`;
  }
}
