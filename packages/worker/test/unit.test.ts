import { describe, expect, it } from 'vitest';
import { classifyAttribution } from '../src/attribution';
import { evaluateBot, globToRegExp, matchesCidr } from '../src/bot';
import { deriveCookielessVid, hmacSha256Hex, sha256Hex } from '../src/util/crypto';
import { bareHost, hostOf, parseCookies, serializeCookie } from '../src/util/ids';
import { dayBucket, hourBucket } from '../src/util/time';
import { parseUserAgent } from '../src/util/ua';

const BASE_BOT_INPUT = {
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36',
  accept: 'text/html',
  acceptLanguage: 'en-US',
  ip: '198.51.100.7',
  path: '/',
  visitorId: 'v1',
  level: 'standard' as const,
  excludedIps: [] as string[],
  excludedPaths: [] as string[],
  excludedUa: [] as string[],
  asn: null as number | null,
};

describe('globToRegExp', () => {
  it('treats * as any run of characters', () => {
    expect(globToRegExp('/api/*').test('/api/v1/events')).toBe(true);
    expect(globToRegExp('/api/*').test('/api')).toBe(false);
    expect(globToRegExp('*.jpg').test('photo.jpg')).toBe(true);
  });
});

describe('matchesCidr', () => {
  it('matches addresses inside the range', () => {
    expect(matchesCidr('10.0.0.5', '10.0.0.0/24')).toBe(true);
    expect(matchesCidr('10.0.1.5', '10.0.0.0/24')).toBe(false);
    expect(matchesCidr('192.168.1.1', '192.168.1.1')).toBe(true);
    expect(matchesCidr('not-an-ip', '10.0.0.0/24')).toBe(false);
  });
});

describe('evaluateBot', () => {
  it('flags known bot User-Agents', () => {
    expect(evaluateBot({ ...BASE_BOT_INPUT, userAgent: 'Googlebot/2.1' }).reason).toBe('known_bot');
  });

  it('flags a missing User-Agent', () => {
    expect(evaluateBot({ ...BASE_BOT_INPUT, userAgent: '' }).reason).toBe('no_ua');
  });

  it('flags headless markers', () => {
    expect(evaluateBot({ ...BASE_BOT_INPUT, userAgent: 'HeadlessChrome/120' }).isBot).toBe(true);
  });

  it('flags requests with neither accept nor accept-language', () => {
    expect(evaluateBot({ ...BASE_BOT_INPUT, accept: null, acceptLanguage: null }).reason).toBe(
      'no_headers',
    );
  });

  it('honours excluded IPs, paths and UA fragments', () => {
    expect(
      evaluateBot({ ...BASE_BOT_INPUT, ip: '10.1.2.3', excludedIps: ['10.0.0.0/8'] }).reason,
    ).toBe('excluded_ip');
    expect(
      evaluateBot({ ...BASE_BOT_INPUT, path: '/api/health', excludedPaths: ['/api/*'] }).reason,
    ).toBe('excluded_path');
    expect(evaluateBot({ ...BASE_BOT_INPUT, excludedUa: ['my-internal-probe'] }).reason).toBeNull();
    expect(
      evaluateBot({
        ...BASE_BOT_INPUT,
        userAgent: 'my-internal-probe/1.0',
        excludedUa: ['my-internal-probe'],
      }).reason,
    ).toBe('excluded_ua');
  });

  it('applies the datacenter ASN list only at strict level', () => {
    expect(evaluateBot({ ...BASE_BOT_INPUT, asn: 16509, level: 'strict' }).reason).toBe(
      'datacenter',
    );
    expect(evaluateBot({ ...BASE_BOT_INPUT, asn: 16509, level: 'standard' }).reason).toBeNull();
  });

  it('flags the honeypot visitor id', () => {
    expect(evaluateBot({ ...BASE_BOT_INPUT, visitorId: 'dg_bot_trap' }).reason).toBe('honeypot');
  });

  it('accepts an ordinary browser', () => {
    const decision = evaluateBot(BASE_BOT_INPUT);
    expect(decision.isBot).toBe(false);
    expect(decision.reason).toBeNull();
  });
});

describe('classifyAttribution', () => {
  const input = {
    utmSource: null,
    utmMedium: null,
    utmCampaign: null,
    referrer: null,
    path: '/',
    allowedHosts: ['example.com'],
  };

  it('classifies paid search from UTM', () => {
    expect(
      classifyAttribution({ ...input, utmSource: 'google', utmMedium: 'cpc', referrer: null }),
    ).toEqual({ channel: 'paid', channel_name: 'google', direct_type: null });
  });

  it('classifies organic search from UTM', () => {
    expect(
      classifyAttribution({ ...input, utmSource: 'google', utmMedium: null, referrer: null }),
    ).toEqual({ channel: 'organic', channel_name: 'google', direct_type: null });
  });

  it('classifies email, social and referral', () => {
    expect(
      classifyAttribution({ ...input, utmSource: 'newsletter', utmMedium: null, referrer: null })
        .channel,
    ).toBe('email');
    expect(
      classifyAttribution({
        ...input,
        utmSource: null,
        utmMedium: null,
        referrer: 'https://t.co/x',
      }).channel,
    ).toBe('referral');
  });

  it('treats a missing referrer as typed direct', () => {
    expect(
      classifyAttribution({ ...input, utmSource: null, utmMedium: null, referrer: null }),
    ).toEqual({ channel: 'direct', channel_name: null, direct_type: 'typed' });
  });

  it('recognises in-app browsers and AI assistants', () => {
    expect(
      classifyAttribution({
        ...input,
        utmSource: null,
        utmMedium: null,
        referrer: 'https://www.instagram.com/p/x',
      }).channel,
    ).toBe('app');
    expect(
      classifyAttribution({
        ...input,
        utmSource: null,
        utmMedium: null,
        referrer: 'https://chatgpt.com/',
      }).channel,
    ).toBe('ai');
  });
});

describe('parseUserAgent', () => {
  it('detects bots', () => {
    expect(parseUserAgent('curl/8.0').device_type).toBe('bot');
  });

  it('detects mobile, tablet and desktop', () => {
    expect(
      parseUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/605')
        .device_type,
    ).toBe('mobile');
    expect(
      parseUserAgent('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) Safari/605').device_type,
    ).toBe('tablet');
    expect(
      parseUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36')
        .device_type,
    ).toBe('desktop');
  });

  it('parses OS and browser', () => {
    const info = parseUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    );
    expect(info.os).toBe('macOS');
    expect(info.browser).toBe('Chrome');
  });
});

describe('crypto helpers', () => {
  it('hashes with sha256', async () => {
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('signs with hmac-sha256', async () => {
    expect(await hmacSha256Hex('key', 'data')).toBe(
      '5031fe3d989c6d1537a013fa6e739da23463fdaec3b70137d828e36ace221bd0',
    );
  });

  it('derives a stable cookieless visitor id', async () => {
    const a = await deriveCookielessVid('secret', 'site', '1.2.3.4', 'UA', '2026-11-02');
    const b = await deriveCookielessVid('secret', 'site', '1.2.3.4', 'UA', '2026-11-02');
    const c = await deriveCookielessVid('secret', 'site', '1.2.3.5', 'UA', '2026-11-02');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('id and cookie helpers', () => {
  it('extracts and normalises hosts', () => {
    expect(hostOf('https://WWW.Example.com/path')).toBe('www.example.com');
    expect(hostOf('not a url')).toBeNull();
    expect(bareHost('www.example.com')).toBe('example.com');
  });

  it('parses and serialises cookies', () => {
    expect(parseCookies('_dg_vid=abc; other=x')).toEqual({ _dg_vid: 'abc', other: 'x' });
    expect(serializeCookie('_dg_vid', 'abc', { maxAge: 60, sameSite: 'Lax' })).toBe(
      '_dg_vid=abc; Path=/; Max-Age=60; SameSite=Lax',
    );
  });
});

describe('time helpers', () => {
  it('formats a day bucket in a timezone', () => {
    // 2026-11-02T00:30:00Z is still 2026-11-01 in Los Angeles.
    expect(dayBucket(Date.UTC(2026, 10, 2, 0, 30) / 1000, 'America/Los_Angeles')).toBe(
      '2026-11-01',
    );
    expect(dayBucket(Date.UTC(2026, 10, 2, 12, 0) / 1000, 'UTC')).toBe('2026-11-02');
  });

  it('formats an hour bucket', () => {
    expect(hourBucket(Date.UTC(2026, 10, 2, 15, 0) / 1000, 'UTC')).toBe('15');
  });
});
