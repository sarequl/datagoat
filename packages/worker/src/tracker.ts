/**
 * Tracking script served at `GET /t.js` (design/script.md). Kept dependency-free
 * and small; the Worker is authoritative for sessions, bots, geo, and attribution.
 *
 * Note: this string is intentionally written without template literals so it can
 * live inside a TypeScript template literal safely.
 */
export const TRACKER_JS = `(function () {
  'use strict';
  var script = document.currentScript;
  if (!script) return;

  var site = script.getAttribute('data-site') || '';
  var domain = script.getAttribute('data-domain') || '';
  var mode = script.getAttribute('data-mode') || 'auto';
  var requireConsent = script.getAttribute('data-require-consent') === 'true';
  var endpoint = script.getAttribute('data-endpoint') || new URL(script.src).origin + '/t';
  var respectDnt = script.getAttribute('data-respect-dnt') !== 'false';

  var vid = null;
  var uid = null;
  var consent = !requireConsent;
  var disabled = false;
  var pvid = null;
  var scrollMarks = {};
  var lastPath = null;

  function storage() {
    try { return window.localStorage; } catch (e) { return null; }
  }

  function randomHex() {
    var bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    var out = '';
    for (var i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
    return out;
  }

  function hash8(value) {
    var h = 0x811c9dc5;
    for (var i = 0; i < value.length; i++) {
      h ^= value.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  function readVid() {
    var match = document.cookie.match(/(?:^|; )_dg_vid=([^;]*)/);
    if (match) return decodeURIComponent(match[1]);
    var ls = storage();
    return ls ? ls.getItem('_dg_vid') : null;
  }

  function writeVid(value) {
    vid = value;
    var expires = new Date(Date.now() + 365 * 864e5).toUTCString();
    var cookie = '_dg_vid=' + encodeURIComponent(value) +
      '; Path=/; Expires=' + expires + '; SameSite=Lax' +
      (location.protocol === 'https:' ? '; Secure' : '');
    if (domain) cookie += '; Domain=' + domain;
    document.cookie = cookie;
    var ls = storage();
    if (ls) ls.setItem('_dg_vid', value);
  }

  function ensureVid() {
    if (vid) return vid;
    if (mode === 'cookieless') return null;
    var existing = readVid();
    if (existing) { vid = existing; return vid; }
    var generated = randomHex();
    writeVid(generated);
    return generated;
  }

  function botScore() {
    var score = 0;
    if (navigator.webdriver === true) score = 100;
    else if (/HeadlessChrome|PhantomJS|Puppeteer|Selenium|Playwright|webdriver/i.test(navigator.userAgent)) score = 100;
    else if (navigator.plugins && navigator.plugins.length === 0 && !window.chrome) score = 60;
    else if (window.outerWidth === 0 && window.outerHeight === 0) score = 40;
    return score;
  }

  function sendBeacon(payload) {
    var body = JSON.stringify(payload);
    if (navigator.sendBeacon) {
      var blob = new Blob([body], { type: 'text/plain;charset=UTF-8' });
      if (navigator.sendBeacon(endpoint, blob)) return;
    }
    try {
      fetch(endpoint, {
        method: 'POST',
        body: body,
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        keepalive: true,
        credentials: 'same-origin'
      }).catch(function () {});
    } catch (e) {}
  }

  function track(name, props) {
    if (disabled || !consent || !site) return;
    var ts = Date.now();
    var eventId = name === 'pageview'
      ? pvid
      : pvid + ':' + hash8(name + ts);
    var payload = {
      v: 1,
      s: site,
      e: name === 'pageview' ? 'pageview' : 'event',
      ts: ts,
      u: location.href,
      p: location.pathname,
      q: location.search.slice(1),
      r: document.referrer || '',
      vw: window.innerWidth,
      vh: window.innerHeight,
      sw: screen.width,
      sh: screen.height,
      dpr: window.devicePixelRatio,
      lang: navigator.language,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      bs: botScore(),
      pvid: pvid,
      event_id: eventId,
      props: props || {}
    };
    var visitorId = ensureVid();
    if (visitorId) payload.vid = visitorId;
    if (uid) payload.uid = uid;
    sendBeacon(payload);
  }

  function trackPageview() {
    pvid = randomHex();
    scrollMarks = {};
    lastPath = location.pathname + location.search;
    track('pageview', {});
  }

  function onScroll() {
    var height = document.documentElement.scrollHeight - window.innerHeight;
    if (height <= 0) return;
    var depth = Math.min(100, Math.round(((window.scrollY + window.innerHeight) / (height + window.innerHeight)) * 100));
    var marks = [25, 50, 75, 100];
    for (var i = 0; i < marks.length; i++) {
      var mark = marks[i];
      if (depth >= mark && !scrollMarks[mark]) {
        scrollMarks[mark] = true;
        track('scroll', { name: 'scroll', scroll_depth: mark });
      }
    }
  }

  function bindRouter() {
    var pushState = history.pushState;
    var replaceState = history.replaceState;
    history.pushState = function () {
      pushState.apply(history, arguments);
      if ((location.pathname + location.search) !== lastPath) trackPageview();
    };
    history.replaceState = function () {
      replaceState.apply(history, arguments);
    };
    window.addEventListener('popstate', function () {
      if ((location.pathname + location.search) !== lastPath) trackPageview();
    });
    window.addEventListener('scroll', function () {
      window.requestAnimationFrame(onScroll);
    }, { passive: true });
    window.addEventListener('unload', function () {
      track('reading_time', { name: 'reading_time', reading_time_ms: Date.now() - loadTime });
    });
  }

  var loadTime = Date.now();

  function api(method, arg) {
    if (method === 'trackPageview') trackPageview();
    else if (method === 'trackEvent') track((arg && arg.name) || 'event', arg || {});
    else if (method === 'identify') {
      uid = typeof arg === 'string' ? arg : (arg && arg.userId) || null;
      track('identify', { name: 'identify' });
    }
    else if (method === 'reset') {
      vid = null;
      document.cookie = '_dg_vid=; Path=/; Max-Age=0' + (domain ? '; Domain=' + domain : '');
      var ls = storage();
      if (ls) ls.removeItem('_dg_vid');
    }
    else if (method === 'consent') {
      consent = !!(arg && arg.analytics);
      if (consent && mode === 'consent' && !vid) ensureVid();
    }
    else if (method === 'optOut') {
      disabled = true;
    }
  }

  window.datagoat = function (method, arg) {
    if (typeof method === 'string') api(method, arg);
    else if (method && method.queue && method.queue.length) {
      for (var i = 0; i < method.queue.length; i++) {
        var entry = method.queue[i];
        api(entry[0], entry[1]);
      }
    }
  };

  if (respectDnt && (navigator.doNotTrack === '1' || navigator.globalPrivacyControl === true)) {
    mode = 'cookieless';
  }

  bindRouter();
  trackPageview();
})();
`;
