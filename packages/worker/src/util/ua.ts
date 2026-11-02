export type DeviceType = 'desktop' | 'mobile' | 'tablet' | 'bot';

export interface UaInfo {
  device_type: DeviceType;
  os: string | null;
  browser: string | null;
}

const BOT_UA =
  /bot|crawl|spider|slurp|archiver|headless|phantom|puppeteer|selenium|playwright|webdriver|scrapy|curl|wget|python|java\/|okhttp|go-http-client|libwww-perl/i;

/**
 * Dependency-free User-Agent parse. It only needs to be good enough for the
 * dashboard's device/OS/browser breakdowns and the bot filter; it is not a
 * full ua-parser replacement.
 */
export function parseUserAgent(ua: string): UaInfo {
  if (!ua) return { device_type: 'desktop', os: null, browser: null };
  if (BOT_UA.test(ua)) return { device_type: 'bot', os: null, browser: 'Bot' };

  let deviceType: DeviceType = 'desktop';
  if (/iPad|Tablet|Kindle|Silk|PlayBook/i.test(ua)) {
    deviceType = 'tablet';
  } else if (/Mobi|iPhone|Android.*Mobile|Windows Phone/i.test(ua)) {
    deviceType = 'mobile';
  }

  let os: string | null = null;
  if (/Windows NT/i.test(ua)) os = 'Windows';
  else if (/Mac OS X|macOS|Macintosh/i.test(ua)) os = 'macOS';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/iPhone|iPad|iPod|iOS/i.test(ua)) os = 'iOS';
  else if (/CrOS/i.test(ua)) os = 'ChromeOS';
  else if (/Linux/i.test(ua)) os = 'Linux';

  let browser: string | null = null;
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/OPR\//i.test(ua)) browser = 'Opera';
  else if (/SamsungBrowser/i.test(ua)) browser = 'Samsung';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Chrome\//i.test(ua)) browser = 'Chrome';
  else if (/Safari\//i.test(ua)) browser = 'Safari';

  return { device_type: deviceType, os, browser };
}
