// DataGoat tracker core. Environment-agnostic: the browser bootstrap passes the
// real DOM, tests pass a fake. No runtime dependencies.

export const VERSION = '0.1.0';

export const DEFAULTS = {
  site: '',
  endpoint: '',
  domain: '',
  mode: 'auto', // auto | cookies | localstorage | cookieless | consent
  autoTrack: true,
  spa: true,
  hash: false,
  respectDnt: true,
  dnt: 'cookieless', // cookieless | block
  requireConsent: false,
  blockBots: true,
  botThreshold: 60,
  redactUrl: true,
  crossDomain: [],
  allowEmbed: false,
  cookieName: '_dg_vid',
  sessionKey: '_dg_ses',
  sessionLastKey: '_dg_ses_last',
  utmCookieName: '_dg_utm',
  gidKey: '_dg_gid',
  optOutKey: '_dg_optout',
};

const RESERVED_PROPS = new Set([
  'v', 's', 'e', 'ts', 'u', 'p', 'q', 'r', 'vid', 'sid', 'uid', 'vw', 'vh',
  'sw', 'sh', 'dpr', 'lang', 'tz', 'bs', 'pvid', 'event_id', 'gid', 'props',
]);

const PII_KEY = /^(email|e-mail|mail|token|access[_-]?token|refresh[_-]?token|auth|authorization|password|passwd|pwd|secret|api[_-]?key|apikey|client[_-]?secret|ssn|credit[_-]?card|card[_-]?number|cardnumber|cvc|cvv|session[_-]?id|phpsessid|jsessionid|sid)$/i;

const BOT_UA = /(bot|crawler|spider|slurp|baidu|yandex|bing|google|facebook|twitter|linkedin|slack|discord|applebot|petal|semrush|ahrefs|mj12|dotbot|gpt|claude|perplexity|bytespider|headless|phantomjs|puppeteer|selenium|playwright|webdriver)/i;

const SESSION_MS = 30 * 60 * 1000;
const YEAR_S = 365 * 24 * 60 * 60;

export function defaultEnv() {
  if (typeof window === 'undefined') {
    return { window: undefined, document: undefined, navigator: undefined, location: undefined, screen: undefined, crypto: undefined };
  }
  return {
    window,
    document: window.document,
    navigator: window.navigator,
    location: window.location,
    screen: window.screen,
    crypto: window.crypto,
  };
}

export function createTracker(options, env) {
  const config = Object.assign({}, DEFAULTS, options || {});
  if (typeof config.crossDomain === 'string') config.crossDomain = config.crossDomain.split(',').map((s) => s.trim()).filter(Boolean);
  config.crossDomain = config.crossDomain || [];
  config.endpoint = normalizeEndpoint(config.endpoint);

  const e = env || defaultEnv();
  const state = {
    vid: null,
    sid: null,
    uid: null,
    userProps: {},
    gid: null,
    pvid: null,
    pageStart: 0,
    sessionStart: 0,
    lastEventAt: 0,
    consent: !config.requireConsent,
    optOut: false,
    bs: 0,
    mode: config.mode,
    firstTouch: null,
    scrollMarks: {},
    readingSent: false,
    sentPageview: false,
    lastUrl: '',
    cleanup: [],
  };

  function normalizeEndpoint(value) {
    if (!value) return '';
    let v = String(value).trim().replace(/\/+$/, '');
    if (v.endsWith('/t')) v = v.slice(0, -2);
    return v;
  }

  // ---------------------------------------------------------------- storage

  function readCookie(name) {
    const doc = e.document;
    if (!doc || !doc.cookie) return null;
    const prefix = name + '=';
    const parts = String(doc.cookie).split('; ');
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].indexOf(prefix) === 0) return decodeURIComponent(parts[i].slice(prefix.length));
    }
    return null;
  }

  function writeCookie(name, value, opts) {
    const doc = e.document;
    if (!doc) return false;
    let str = name + '=' + encodeURIComponent(value) + '; Path=' + (opts.path || '/');
    if (opts.domain) str += '; Domain=' + opts.domain;
    if (opts.maxAge != null) str += '; Max-Age=' + opts.maxAge;
    if (opts.expires) str += '; Expires=' + opts.expires;
    if (opts.secure) str += '; Secure';
    if (opts.sameSite) str += '; SameSite=' + opts.sameSite;
    try {
      doc.cookie = str;
    } catch (err) {
      return false;
    }
    return readCookie(name) === value;
  }

  function deleteCookie(name, opts) {
    return writeCookie(name, '', Object.assign({}, opts, { maxAge: 0, expires: 'Thu, 01 Jan 1970 00:00:00 GMT' }));
  }

  function readStorage(key) {
    try {
      const store = e.window && e.window.localStorage;
      return store ? store.getItem(key) : null;
    } catch (err) {
      return null;
    }
  }

  function writeStorage(key, value) {
    try {
      const store = e.window && e.window.localStorage;
      if (!store) return false;
      store.setItem(key, String(value));
      return true;
    } catch (err) {
      return false;
    }
  }

  function deleteStorage(key) {
    try {
      const store = e.window && e.window.localStorage;
      if (store) store.removeItem(key);
    } catch (err) {
      /* ignore */
    }
  }

  // ---------------------------------------------------------------- helpers

  function randomHex(bytes) {
    const c = e.crypto || (typeof crypto !== 'undefined' ? crypto : null);
    if (c && typeof c.getRandomValues === 'function') {
      const arr = new Uint8Array(bytes);
      c.getRandomValues(arr);
      let out = '';
      for (let i = 0; i < bytes; i++) out += (arr[i] < 16 ? '0' : '') + arr[i].toString(16);
      return out;
    }
    let out = '';
    for (let i = 0; i < bytes * 2; i++) out += Math.floor(Math.random() * 16).toString(16);
    return out.slice(0, bytes * 2);
  }

  function base64url(str) {
    const b = e.window && e.window.btoa ? e.window.btoa(str) : btoa(str);
    return b.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function timeZone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch (err) {
      return '';
    }
  }

  function cookieOpts() {
    const secure = e.location && e.location.protocol === 'https:';
    const sameSite = config.allowEmbed ? 'None' : 'Lax';
    return {
      path: '/',
      domain: config.domain || undefined,
      maxAge: YEAR_S,
      secure: sameSite === 'None' ? true : secure,
      sameSite,
    };
  }

  function utmCookieOpts() {
    const secure = e.location && e.location.protocol === 'https:';
    return { path: '/', domain: config.domain || undefined, maxAge: 1800, secure, sameSite: config.allowEmbed ? 'None' : 'Lax' };
  }

  function isDnt() {
    const nav = e.navigator || {};
    return nav.doNotTrack === '1' || nav.doNotTrack === 'yes' || nav.globalPrivacyControl === true;
  }

  function computeBotScore() {
    const nav = e.navigator || {};
    const win = e.window || {};
    const doc = e.document || {};
    if (nav.webdriver) return 100;
    const ua = nav.userAgent || '';
    if (ua && BOT_UA.test(ua)) return 100;
    let score = 0;
    const headless = !win.chrome || (nav.languages && nav.languages.length === 0);
    if (nav.plugins && nav.plugins.length === 0 && headless) score += 60;
    if (win.outerWidth === 0 && win.outerHeight === 0) score += 40;
    if (!timeZone()) score += 20;
    if (doc.hidden) score += 10;
    return Math.min(100, score);
  }

  function resolveMode() {
    let mode = config.mode || 'auto';
    if (config.cookieless) mode = 'cookieless';
    if (config.requireConsent && !state.consent) mode = 'cookieless';
    if (mode === 'consent') mode = state.consent ? 'cookies' : 'cookieless';
    if (config.respectDnt && isDnt()) {
      if (config.dnt === 'block') state.optOut = true;
      else if (mode === 'auto' || mode === 'cookies') mode = 'cookieless';
    }
    if (mode === 'auto') mode = 'cookies';
    return mode;
  }

  function ensureVisitorId() {
    if (state.vid) return state.vid;
    const mode = state.mode;
    if (mode === 'cookieless') return null;

    if (mode === 'localstorage') {
      const stored = readStorage(config.cookieName);
      if (stored) {
        state.vid = stored;
        return stored;
      }
      const id = randomHex(16);
      if (writeStorage(config.cookieName, id)) {
        state.vid = id;
        return id;
      }
      return null;
    }

    // cookies (and the auto fallback chain)
    const fromCookie = readCookie(config.cookieName);
    if (fromCookie) {
      state.vid = fromCookie;
      return fromCookie;
    }
    const fromStorage = readStorage(config.cookieName);
    if (fromStorage) {
      state.vid = fromStorage;
      writeCookie(config.cookieName, fromStorage, cookieOpts());
      return fromStorage;
    }
    const id = randomHex(16);
    if (writeCookie(config.cookieName, id, cookieOpts())) {
      writeStorage(config.cookieName, id);
      state.vid = id;
      return id;
    }
    if (writeStorage(config.cookieName, id)) {
      state.vid = id;
      return id;
    }
    return null;
  }

  function ensureSession() {
    const now = Date.now();
    const persistent = state.mode !== 'cookieless';
    let start = persistent ? parseInt(readStorage(config.sessionKey) || '0', 10) : state.sessionStart;
    const last = persistent ? parseInt(readStorage(config.sessionLastKey) || '0', 10) : state.lastEventAt;
    if (!start || now - last > SESSION_MS) start = now;
    if (persistent) {
      writeStorage(config.sessionKey, start);
      writeStorage(config.sessionLastKey, now);
    }
    state.sessionStart = start;
    state.lastEventAt = now;
    state.sid = base64url((state.vid || 'anon') + ':' + Math.floor(start / 1000));
    return state.sid;
  }

  function ensureGid() {
    if (state.gid) return state.gid;
    let gid = readStorage(config.gidKey);
    if (!gid) {
      gid = randomHex(8);
      writeStorage(config.gidKey, gid);
    }
    state.gid = gid;
    return gid;
  }

  function readFirstTouch() {
    if (state.firstTouch) return state.firstTouch;
    const raw = readCookie(config.utmCookieName) || readStorage(config.utmCookieName);
    if (raw) {
      try {
        state.firstTouch = JSON.parse(raw);
      } catch (err) {
        state.firstTouch = null;
      }
    }
    return state.firstTouch;
  }

  function captureFirstTouch() {
    if (readFirstTouch()) return;
    const search = e.location && e.location.search;
    if (!search) return;
    let params;
    try {
      params = new URLSearchParams(search);
    } catch (err) {
      return;
    }
    const utm = {};
    ['source', 'medium', 'campaign', 'term', 'content'].forEach((k) => {
      const v = params.get('utm_' + k);
      if (v) utm[k] = v;
    });
    const referrer = (e.document && e.document.referrer) || '';
    if (Object.keys(utm).length || referrer) {
      state.firstTouch = { referrer, utm };
      const raw = JSON.stringify(state.firstTouch);
      if (state.mode !== 'localstorage') writeCookie(config.utmCookieName, raw, utmCookieOpts());
      writeStorage(config.utmCookieName, raw);
    }
  }

  function consumeIncomingParams() {
    const search = e.location && e.location.search;
    if (!search) return;
    let params;
    try {
      params = new URLSearchParams(search);
    } catch (err) {
      return;
    }
    const vid = params.get('datagoat_v');
    const gid = params.get('datagoat_g');
    if (gid) {
      state.gid = gid;
      writeStorage(config.gidKey, gid);
    }
    if (vid && /^[0-9a-f]{32}$/i.test(vid)) {
      state.vid = vid;
      if (state.mode !== 'localstorage') writeCookie(config.cookieName, vid, cookieOpts());
      writeStorage(config.cookieName, vid);
    }
    if (vid || gid) {
      params.delete('datagoat_v');
      params.delete('datagoat_g');
      const qs = params.toString();
      const url = (e.location.pathname || '/') + (qs ? '?' + qs : '') + (e.location.hash || '');
      if (e.window && e.window.history && e.window.history.replaceState) {
        e.window.history.replaceState({}, (e.document && e.document.title) || '', url);
      }
    }
  }

  // ---------------------------------------------------------------- payload

  function redactQuery(query) {
    if (!query) return '';
    return query
      .split('&')
      .filter((pair) => {
        const key = pair.split('=')[0].toLowerCase();
        return !PII_KEY.test(key);
      })
      .join('&');
  }

  function resolveUrl(raw) {
    let url;
    try {
      url = new URL(raw, e.location ? e.location.href : undefined);
    } catch (err) {
      return { u: String(raw || ''), p: String(raw || ''), q: '' };
    }
    let path = url.pathname || '/';
    let query = url.search ? url.search.slice(1) : '';
    if (config.redactUrl) query = redactQuery(query);
    if (path.length > 512) path = path.slice(0, 512);
    if (query.length > 512) query = query.slice(0, 512);
    let full = url.origin + path + (query ? '?' + query : '');
    if (full.length > 1024) full = full.slice(0, 1024);
    return { u: full, p: path, q: query };
  }

  function sanitizeProps(props) {
    const out = {};
    Object.keys(props || {}).forEach((rawKey) => {
      const key = String(rawKey).toLowerCase().slice(0, 64);
      if (!key || RESERVED_PROPS.has(key)) return;
      const value = props[rawKey];
      if (value == null) return;
      if (typeof value === 'string') out[key] = value.slice(0, 255);
      else if (typeof value === 'number' || typeof value === 'boolean') out[key] = value;
      else out[key] = String(value).slice(0, 255);
    });
    return out;
  }

  function buildPayload(eventName, props, pvid) {
    const now = Date.now();
    const url = resolveUrl(state.currentUrl || (e.location && e.location.href) || '');
    const payload = {
      v: 1,
      s: config.site,
      e: eventName === 'pageview' ? 'pageview' : 'event',
      ts: now,
      u: url.u,
      p: url.p,
      q: url.q,
      r: (e.document && e.document.referrer) || '',
      vw: (e.window && e.window.innerWidth) || 0,
      vh: (e.window && e.window.innerHeight) || 0,
      sw: (e.screen && e.screen.width) || 0,
      sh: (e.screen && e.screen.height) || 0,
      dpr: (e.window && e.window.devicePixelRatio) || 1,
      lang: (e.navigator && e.navigator.language) || '',
      tz: timeZone(),
      bs: state.bs,
      pvid,
      event_id: eventName === 'pageview' ? pvid : pvid + ':' + ((props && props.name) || '') + ':' + now,
    };
    if (state.vid) payload.vid = state.vid;
    if (state.sid) payload.sid = state.sid;
    if (state.uid) payload.uid = state.uid;
    if (state.gid) payload.gid = state.gid;
    if (eventName === 'event') payload.props = sanitizeProps(Object.assign({}, state.userProps, props));
    else payload.props = {};
    return payload;
  }

  function send(payload) {
    if (state.optOut || !state.consent) return Promise.resolve(false);
    if (!config.site || !config.endpoint) return Promise.resolve(false);
    if (config.blockBots && state.bs >= config.botThreshold) return Promise.resolve(false);

    const body = JSON.stringify(payload);
    const url = config.endpoint + '/t';
    const nav = e.navigator;
    const win = e.window;

    if (nav && typeof nav.sendBeacon === 'function') {
      try {
        // A string body is sent as text/plain;charset=UTF-8, which is
        // CORS-safelisted, so no preflight is needed.
        if (nav.sendBeacon(url, body)) return Promise.resolve(true);
      } catch (err) {
        /* fall through */
      }
    }

    if (win && typeof win.fetch === 'function') {
      try {
        // A string body defaults to text/plain;charset=UTF-8, which the Worker
        // accepts; keepalive lets the request outlive the page.
        win.fetch(url, { method: 'POST', body, keepalive: true });
        return Promise.resolve(true);
      } catch (err) {
        /* fall through */
      }
    }
    return Promise.resolve(false);
  }

  // ---------------------------------------------------------------- events

  function trackPageview(opts) {
    if (state.optOut || !state.consent) return Promise.resolve(false);
    opts = opts || {};
    const url = opts.url || (e.location && e.location.href) || '';
    state.currentUrl = url;
    const pvid = randomHex(8);
    state.pvid = pvid;
    state.pageStart = Date.now();
    state.scrollMarks = {};
    state.readingSent = false;
    ensureVisitorId();
    ensureSession();
    const payload = buildPayload('pageview', {}, pvid);
    state.sentPageview = true;
    return send(payload);
  }

  function trackEvent(props) {
    if (state.optOut || !state.consent) return Promise.resolve(false);
    const input = Object.assign({}, props || {});
    if (!input.name) return Promise.resolve(false);
    const pvid = state.pvid || randomHex(8);
    ensureVisitorId();
    ensureSession();
    return send(buildPayload('event', input, pvid));
  }

  function identify(uid) {
    state.uid = uid == null ? null : String(uid);
    return Promise.resolve(true);
  }

  function setUserProperties(props) {
    Object.assign(state.userProps, props || {});
    return Promise.resolve(true);
  }

  function setConsent(opts) {
    state.consent = !!(opts && opts.analytics);
    if (state.consent) {
      if (config.mode === 'consent' || config.requireConsent) state.mode = 'cookies';
      if (!state.sentPageview && config.autoTrack) trackPageview();
    }
    return Promise.resolve(true);
  }

  function setDomain(domain) {
    config.domain = domain;
    if (state.vid && state.mode !== 'localstorage') writeCookie(config.cookieName, state.vid, cookieOpts());
    return Promise.resolve(true);
  }

  function reset() {
    deleteCookie(config.cookieName, cookieOpts());
    deleteStorage(config.cookieName);
    deleteStorage(config.sessionKey);
    deleteStorage(config.sessionLastKey);
    deleteCookie(config.utmCookieName, utmCookieOpts());
    deleteStorage(config.utmCookieName);
    deleteStorage(config.gidKey);
    state.vid = null;
    state.sid = null;
    state.uid = null;
    state.userProps = {};
    state.gid = null;
    state.pvid = null;
    state.firstTouch = null;
    state.sessionStart = 0;
    state.lastEventAt = 0;
    state.scrollMarks = {};
    return Promise.resolve(true);
  }

  function optOut() {
    state.optOut = true;
    writeStorage(config.optOutKey, '1');
    return Promise.resolve(true);
  }

  // ---------------------------------------------------------------- listeners

  function patchHistory() {
    const win = e.window;
    const hist = win && win.history;
    if (!hist || !win.addEventListener) return;
    if (win.__datagoatPatched) return;
    win.__datagoatPatched = true;
    const origPush = hist.pushState;
    const origReplace = hist.replaceState;
    hist.pushState = function (...args) {
      const ret = origPush.apply(this, args);
      onRouteChange();
      return ret;
    };
    hist.replaceState = function (...args) {
      const ret = origReplace.apply(this, args);
      onRouteChange();
      return ret;
    };
    win.addEventListener('popstate', onRouteChange);
    if (config.hash) win.addEventListener('hashchange', onRouteChange);
  }

  function onRouteChange() {
    const url = e.location && e.location.href;
    if (!url || url === state.lastUrl) return;
    state.lastUrl = url;
    trackPageview({ url });
  }

  function setupScroll() {
    const win = e.window;
    if (!win || !win.addEventListener) return;
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      win.setTimeout(() => {
        ticking = false;
        emitScroll();
      }, 100);
    };
    win.addEventListener('scroll', onScroll, { passive: true });
    state.cleanup.push(() => win.removeEventListener('scroll', onScroll));
  }

  function emitScroll() {
    if (state.optOut || !state.consent) return;
    const doc = e.document || {};
    const win = e.window || {};
    const el = doc.documentElement || doc.body || {};
    const scrollTop = win.pageYOffset || el.scrollTop || 0;
    const height = (el.scrollHeight || 0) - (win.innerHeight || el.clientHeight || 0);
    const pct = height > 0 ? Math.min(100, Math.round((scrollTop / height) * 100)) : 100;
    [25, 50, 75, 100].forEach((mark) => {
      if (pct >= mark && !state.scrollMarks[mark]) {
        state.scrollMarks[mark] = true;
        trackEvent({ name: 'scroll', scroll_depth: mark });
      }
    });
  }

  function setupUnload() {
    const win = e.window;
    if (!win || !win.addEventListener) return;
    const onHide = () => {
      const doc = e.document || {};
      if (doc.visibilityState === 'hidden' || !doc.visibilityState) emitReadingTime();
    };
    win.addEventListener('pagehide', onHide);
    win.addEventListener('visibilitychange', onHide);
    state.cleanup.push(() => {
      win.removeEventListener('pagehide', onHide);
      win.removeEventListener('visibilitychange', onHide);
    });
  }

  function emitReadingTime() {
    if (!state.pvid || state.readingSent) return;
    state.readingSent = true;
    const start = state.pageStart || Date.now();
    trackEvent({ name: 'reading_time', reading_time_ms: Math.max(0, Date.now() - start) });
  }

  function isCrossDomainHost(hostname) {
    if (!hostname) return false;
    const host = String(hostname).toLowerCase();
    return config.crossDomain.some((entry) => {
      const h = String(entry).toLowerCase().replace(/^\./, '');
      return host === h || host.endsWith('.' + h);
    });
  }

  function setupCrossDomain() {
    const doc = e.document;
    if (!doc || !doc.addEventListener || !config.crossDomain.length) return;
    const handler = (event) => {
      const target = event.target;
      if (!target || !target.closest) return;
      const anchor = target.closest('a[href]');
      if (!anchor) return;
      if (anchor.dataset && anchor.dataset.datagoatDecorated) return;
      let url;
      try {
        url = new URL(anchor.href, e.location.href);
      } catch (err) {
        return;
      }
      if (!isCrossDomainHost(url.hostname)) return;
      const vid = state.vid || ensureVisitorId();
      const gid = ensureGid();
      const params = new URLSearchParams(url.search);
      params.set('datagoat_v', vid || '');
      params.set('datagoat_g', gid);
      url.search = params.toString();
      anchor.href = url.toString();
      if (anchor.dataset) anchor.dataset.datagoatDecorated = '1';
    };
    doc.addEventListener('click', handler);
    doc.addEventListener('mousedown', handler);
    state.cleanup.push(() => {
      doc.removeEventListener('click', handler);
      doc.removeEventListener('mousedown', handler);
    });
  }

  // ---------------------------------------------------------------- lifecycle

  function command(name, ...args) {
    switch (name) {
      case 'trackPageview':
        return trackPageview(args[0]);
      case 'trackEvent':
        return trackEvent(args[0]);
      case 'identify':
        return identify(args[0]);
      case 'setUserProperties':
        return setUserProperties(args[0]);
      case 'consent':
        return setConsent(args[0]);
      case 'reset':
        return reset();
      case 'optOut':
        return optOut();
      case 'setDomain':
        return setDomain(args[0]);
      default:
        return Promise.resolve(false);
    }
  }

  function destroy() {
    state.cleanup.forEach((fn) => {
      try {
        fn();
      } catch (err) {
        /* ignore */
      }
    });
    state.cleanup = [];
  }

  function init(queue) {
    state.bs = computeBotScore();
    state.mode = resolveMode();
    if (readStorage(config.optOutKey) === '1') state.optOut = true;
    if (config.requireConsent && e.window && e.window.__datagoat_consent === true) state.consent = true;
    if (state.mode !== 'cookieless') captureFirstTouch();
    consumeIncomingParams();
    if (config.crossDomain.length) ensureGid();
    if (config.spa) patchHistory();
    setupScroll();
    setupUnload();
    setupCrossDomain();
    // Apply commands queued before the script loaded, before the auto pageview,
    // so an early identify()/consent() shapes the first beacon.
    if (queue && queue.length) queue.forEach((args) => command(...args));
    if (config.autoTrack && !state.optOut && state.consent) trackPageview();
    return api;
  }

  const api = {
    init,
    command,
    trackPageview,
    trackEvent,
    identify,
    setUserProperties,
    setConsent,
    reset,
    optOut,
    setDomain,
    destroy,
    getVisitorId: () => state.vid,
    getConfig: () => config,
    getState: () => state,
  };

  return api;
}

