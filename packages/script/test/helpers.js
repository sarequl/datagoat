import { Buffer } from 'node:buffer';

let cryptoSeed = 0;

// A small fake DOM good enough to exercise the tracker in Node.
export function makeEnv(overrides = {}) {
  const cookies = overrides.cookies || new Map();
  const storage = overrides.storage || new Map();
  const blockCookies = !!overrides.blockCookies;
  const blockStorage = !!overrides.blockStorage;
  const listeners = {};
  const sendBeaconCalls = [];
  const fetchCalls = [];
  const replaceStateCalls = [];

  const location = {
    href: 'https://example.com/pricing?plan=pro',
    protocol: 'https:',
    host: 'example.com',
    hostname: 'example.com',
    origin: 'https://example.com',
    pathname: '/pricing',
    search: '?plan=pro',
    hash: '',
  };

  const document = {
    title: 'Pricing',
    referrer: 'https://google.com/',
    hidden: false,
    visibilityState: 'visible',
    cookie: '',
    documentElement: { scrollHeight: 4000, clientHeight: 800, scrollTop: 0 },
    body: { scrollHeight: 4000, clientHeight: 800, scrollTop: 0 },
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      const arr = listeners[type];
      if (arr) {
        const i = arr.indexOf(fn);
        if (i >= 0) arr.splice(i, 1);
      }
    },
    createElement() {
      return { style: {}, setAttribute() {}, appendChild() {} };
    },
  };

  Object.defineProperty(document, 'cookie', {
    get() {
      return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    set(str) {
      if (blockCookies) return;
      const [pair] = str.split(';');
      const idx = pair.indexOf('=');
      const key = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (/Max-Age=0/.test(str) || /Expires=Thu, 01 Jan 1970/.test(str)) cookies.delete(key);
      else cookies.set(key, value);
    },
  });

  const navigator = {
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    language: 'en-US',
    languages: ['en-US'],
    plugins: [{ length: 1 }],
    webdriver: false,
    doNotTrack: null,
    globalPrivacyControl: undefined,
    sendBeacon(url, body) {
      sendBeaconCalls.push({ url, body });
      return true;
    },
  };

  const window = {
    innerWidth: 1280,
    innerHeight: 800,
    devicePixelRatio: 2,
    pageYOffset: 0,
    location,
    document,
    navigator,
    screen: { width: 1440, height: 900 },
    localStorage: {
      getItem: (k) => {
        if (blockStorage) throw new Error('storage blocked');
        return storage.has(k) ? storage.get(k) : null;
      },
      setItem: (k, v) => {
        if (blockStorage) throw new Error('storage blocked');
        storage.set(k, String(v));
      },
      removeItem: (k) => {
        if (blockStorage) throw new Error('storage blocked');
        storage.delete(k);
      },
    },
    history: {
      pushState(...args) {
        replaceStateCalls.push({ method: 'pushState', args });
      },
      replaceState(...args) {
        replaceStateCalls.push({ method: 'replaceState', args });
      },
    },
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      const arr = listeners[type];
      if (arr) {
        const i = arr.indexOf(fn);
        if (i >= 0) arr.splice(i, 1);
      }
    },
    setTimeout(fn) {
      fn();
      return 0;
    },
    clearTimeout() {},
    crypto: {
      getRandomValues(arr) {
        // Vary per call so separate ids (pvid, vid, gid) are not identical.
        for (let i = 0; i < arr.length; i++) arr[i] = (i * 37 + 11 + (cryptoSeed++ % 251)) % 256;
        return arr;
      },
    },
    Blob: class Blob {
      constructor(parts, opts) {
        this.parts = parts;
        this.type = (opts && opts.type) || '';
      }
    },
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    fetch(url, opts) {
      fetchCalls.push({ url, opts });
      return Promise.resolve({ ok: true });
    },
  };

  const env = { window, document, navigator, location, screen: window.screen, crypto: window.crypto };
  return {
    env,
    cookies,
    storage,
    listeners,
    sendBeaconCalls,
    fetchCalls,
    replaceStateCalls,
    location,
    document,
    window,
    navigator,
  };
}

export function payloads(sendBeaconCalls) {
  return sendBeaconCalls.map((call) => {
    const body = typeof call.body === 'string' ? call.body : call.body.parts[0];
    return JSON.parse(body);
  });
}

export function fire(listeners, type, event) {
  (listeners[type] || []).slice().forEach((fn) => fn(event || {}));
}
