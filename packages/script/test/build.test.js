import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const distDir = fileURLToPath(new URL('../dist/', import.meta.url));

test('built t.js is under 5 KB gzipped', () => {
  const raw = readFileSync(`${distDir}t.js`);
  const gzipped = gzipSync(raw).length;
  assert.ok(gzipped < 5120, `t.js is ${gzipped} B gzipped`);
});

test('built t.js exposes window.datagoat and sends one pageview', () => {
  const code = readFileSync(`${distDir}t.js`, 'utf8');
  const storage = new Map();
  const cookies = new Map();
  const sends = [];

  const location = {
    href: 'https://example.com/',
    protocol: 'https:',
    origin: 'https://example.com',
    hostname: 'example.com',
    host: 'example.com',
    pathname: '/',
    search: '',
    hash: '',
  };

  const document = {
    title: '',
    referrer: '',
    hidden: false,
    visibilityState: 'visible',
    cookie: '',
    currentScript: { src: 'https://example.com/t.js', dataset: { site: 's1' } },
    documentElement: { scrollHeight: 1000, clientHeight: 800 },
    body: {},
    addEventListener() {},
    getElementsByTagName() {
      return [];
    },
  };
  Object.defineProperty(document, 'cookie', {
    get() {
      return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    set() {},
  });

  const navigator = {
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    language: 'en-US',
    languages: ['en-US'],
    plugins: [{}],
    webdriver: false,
    sendBeacon(url, body) {
      sends.push({ url, body });
      return true;
    },
  };

  const window = {
    innerWidth: 800,
    innerHeight: 600,
    devicePixelRatio: 1,
    pageYOffset: 0,
    location,
    document,
    navigator,
    screen: { width: 1000, height: 800 },
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    history: { pushState() {}, replaceState() {} },
    addEventListener() {},
    setTimeout(fn) {
      fn();
      return 0;
    },
    crypto: {
      getRandomValues(arr) {
        for (let i = 0; i < arr.length; i++) arr[i] = i % 256;
        return arr;
      },
    },
    Blob: class Blob {
      constructor(parts) {
        this.parts = parts;
      }
    },
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  };

  const context = {
    window,
    document,
    navigator,
    location,
    screen: window.screen,
    crypto: window.crypto,
    Blob: window.Blob,
    btoa: window.btoa,
    setTimeout: window.setTimeout,
    URL,
    URLSearchParams,
    Intl,
    unescape,
    JSON,
    Math,
    Date,
    Uint8Array,
    Promise,
    Buffer,
    console,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(code, context);

  assert.equal(typeof window.datagoat, 'function');
  assert.equal(sends.length, 1);
  const body = typeof sends[0].body === 'string' ? sends[0].body : sends[0].body.parts[0];
  const payload = JSON.parse(body);
  assert.equal(payload.s, 's1');
  assert.equal(payload.e, 'pageview');
  assert.equal(payload.event_id, payload.pvid);
});
