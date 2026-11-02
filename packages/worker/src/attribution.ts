import { bareHost, hostOf } from './util/ids';

export interface AttributionInput {
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  referrer: string | null;
  path: string;
  allowedHosts: string[];
}

export interface AttributionResult {
  channel: string;
  channel_name: string | null;
  direct_type: string | null;
}

const SOURCE_CHANNEL: Record<string, string> = {
  google: 'organic',
  bing: 'organic',
  yandex: 'organic',
  baidu: 'organic',
  duckduckgo: 'organic',
  newsletter: 'email',
  mailchimp: 'email',
  sendgrid: 'email',
  facebook: 'social',
  instagram: 'social',
  twitter: 'social',
  x: 'social',
  tiktok: 'social',
  linkedin: 'social',
  pinterest: 'social',
  youtube: 'social',
  reddit: 'social',
};

const APP_BROWSERS = new Set([
  'instagram.com',
  'tiktok.com',
  'reddit.com',
  'telegram.org',
  'facebook.com',
  'x.com',
  'twitter.com',
]);

const AI_ASSISTANTS = new Set([
  'chatgpt.com',
  'claude.ai',
  'perplexity.ai',
  'gemini.google.com',
  'copilot.microsoft.com',
]);

const CHECKOUT_PATH = /^\/(checkout|checkouts|billing|return|returns|order|orders)(\/|$)/i;

function normalizeHost(host: string | null): string | null {
  if (!host) return null;
  return bareHost(host.toLowerCase());
}

/**
 * Channel classification, design/worker.md §8. First match wins. UTM is the
 * strongest signal; a missing referrer is readable Direct; known in-app
 * browsers and AI assistants get their own channels.
 */
export function classifyAttribution(input: AttributionInput): AttributionResult {
  const utmSource = input.utmSource ? input.utmSource.toLowerCase() : null;
  const utmMedium = input.utmMedium ? input.utmMedium.toLowerCase() : null;

  // 1. UTM source present.
  if (utmSource) {
    let channel = SOURCE_CHANNEL[utmSource] ?? 'referral';
    if (
      (channel === 'organic' || channel === 'referral') &&
      (utmMedium === 'cpc' || utmMedium === 'ppc')
    ) {
      channel = 'paid';
    }
    return { channel, channel_name: utmSource, direct_type: null };
  }

  const refHost = normalizeHost(hostOf(input.referrer ?? ''));
  const allowed = new Set(input.allowedHosts.map((h) => normalizeHost(h)).filter(Boolean));

  // 2. Referrer is the site itself.
  if (refHost && allowed.has(refHost)) {
    const directType = CHECKOUT_PATH.test(input.path) ? 'checkout_return' : 'shared';
    return { channel: 'direct', channel_name: null, direct_type: directType };
  }

  // 3. No referrer at all.
  if (!refHost) {
    return { channel: 'direct', channel_name: null, direct_type: 'typed' };
  }

  // 4. In-app browser.
  if (APP_BROWSERS.has(refHost)) {
    return { channel: 'app', channel_name: refHost, direct_type: null };
  }

  // 5. AI assistant.
  if (AI_ASSISTANTS.has(refHost)) {
    return { channel: 'ai', channel_name: refHost, direct_type: null };
  }

  // 6. Everything else is a referral.
  return { channel: 'referral', channel_name: refHost, direct_type: null };
}
