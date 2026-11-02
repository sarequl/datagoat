import test from 'node:test';
import assert from 'node:assert/strict';
import { createTracker } from '../src/core.js';
import { makeEnv, payloads, fire } from './helpers.js';

const base = { site: 'site_token_1', endpoint: 'https://example.com' };

function setup(options = {}, envOverrides = {}) {
  const h = makeEnv(envOverrides);
  const tracker = createTracker({ ...base, ...options }, h.env);
  tracker.init();
  return { h, tracker };
}

test('a pageview produces exactly one beacon', () => {
  const { h } = setup();
  assert.equal(h.sendBeaconCalls.length, 1);
  const [p] = payloads(h.sendBeaconCalls);
  assert.equal(p.v, 1);
  assert.equal(p.s, 'site_token_1');
  assert.equal(p.e, 'pageview');
  assert.equal(p.event_id, p.pvid);
  assert.equal(p.p, '/pricing');
  assert.equal(p.q, 'plan=pro');
  assert.equal(p.r, 'https://google.com/');
  assert.equal(p.vw, 1280);
  assert.equal(p.vh, 800);
  assert.equal(p.sw, 1440);
  assert.equal(p.sh, 900);
  assert.equal(p.dpr, 2);
  assert.equal(p.lang, 'en-US');
  assert.equal(typeof p.tz, 'string');
  assert.match(p.vid, /^[0-9a-f]{32}$/);
  assert.match(p.pvid, /^[0-9a-f]{16}$/);
});

test('cookie mode keeps a stable visitor id across loads', () => {
  const shared = { cookies: new Map(), storage: new Map() };
  const a = setup({ mode: 'cookies' }, shared);
  const b = setup({ mode: 'cookies' }, shared);
  assert.equal(a.tracker.getVisitorId(), b.tracker.getVisitorId());
  assert.match(a.tracker.getVisitorId(), /^[0-9a-f]{32}$/);
});

test('localstorage mode keeps a stable visitor id and sets no cookie', () => {
  const shared = { cookies: new Map(), storage: new Map() };
  const a = setup({ mode: 'localstorage' }, shared);
  const b = setup({ mode: 'localstorage' }, shared);
  assert.equal(a.tracker.getVisitorId(), b.tracker.getVisitorId());
  assert.equal(a.h.cookies.size, 0);
  assert.ok(a.h.storage.has('_dg_vid'));
});

test('cookieless mode omits vid and stores nothing', () => {
  const { h } = setup({ mode: 'cookieless' });
  const [p] = payloads(h.sendBeaconCalls);
  assert.equal(p.vid, undefined);
  assert.equal(h.cookies.size, 0);
  assert.equal(h.storage.size, 0);
});

test('blocked cookies fall back to localStorage, then cookieless', () => {
  const ls = setup({ mode: 'auto' }, { blockCookies: true });
  assert.match(ls.tracker.getVisitorId(), /^[0-9a-f]{32}$/);
  assert.equal(ls.h.cookies.size, 0);
  assert.ok(ls.h.storage.has('_dg_vid'));

  const none = setup({ mode: 'auto' }, { blockCookies: true, blockStorage: true });
  assert.equal(none.tracker.getVisitorId(), null);
  assert.equal(payloads(none.h.sendBeaconCalls)[0].vid, undefined);
});

test('cross-domain clicks decorate the link with vid and gid', () => {
  const { h } = setup({ crossDomain: ['shop.example.net'] });
  const anchor = {
    href: 'https://shop.example.net/checkout',
    dataset: {},
    closest(sel) {
      return sel === 'a[href]' ? this : null;
    },
  };
  fire(h.listeners, 'click', { target: anchor });
  assert.match(anchor.href, /datagoat_v=[0-9a-f]{32}/);
  assert.match(anchor.href, /datagoat_g=[0-9a-f]{16}/);
});

test('incoming cross-domain params set the visitor id and are stripped', () => {
  const h = makeEnv();
  h.location.search = '?datagoat_v=0123456789abcdef0123456789abcdef&datagoat_g=fedcba9876543210&plan=pro';
  h.location.href = 'https://example.com/pricing?datagoat_v=0123456789abcdef0123456789abcdef&datagoat_g=fedcba9876543210&plan=pro';
  const tracker = createTracker({ ...base, crossDomain: ['shop.example.net'] }, h.env);
  tracker.init();
  assert.equal(tracker.getVisitorId(), '0123456789abcdef0123456789abcdef');
  assert.equal(tracker.getState().gid, 'fedcba9876543210');
  const replace = h.replaceStateCalls.find((c) => c.method === 'replaceState');
  assert.ok(replace);
  assert.equal(replace.args[2], '/pricing?plan=pro');
});

test('SPA route changes send a second pageview', () => {
  const { h } = setup({ spa: true });
  assert.equal(h.sendBeaconCalls.length, 1);
  const first = payloads(h.sendBeaconCalls)[0];
  h.location.href = 'https://example.com/pricing?plan=pro&page=2';
  h.location.search = '?plan=pro&page=2';
  h.window.history.pushState({}, '', '/pricing?plan=pro&page=2');
  assert.equal(h.sendBeaconCalls.length, 2);
  const second = payloads(h.sendBeaconCalls)[1];
  assert.equal(second.e, 'pageview');
  assert.notEqual(second.pvid, first.pvid);
});

test('scroll depth emits one event per threshold', () => {
  const { h } = setup();
  const first = payloads(h.sendBeaconCalls)[0];
  h.window.pageYOffset = 1000;
  fire(h.listeners, 'scroll');
  h.window.pageYOffset = 3200;
  fire(h.listeners, 'scroll');
  const scrolls = payloads(h.sendBeaconCalls).filter((p) => p.props && p.props.name === 'scroll');
  assert.deepEqual(scrolls.map((p) => p.props.scroll_depth), [25, 50, 75, 100]);
  assert.ok(scrolls.every((p) => p.pvid === first.pvid));
});

test('trackEvent sends an event with a per-event id', () => {
  const { h, tracker } = setup();
  const first = payloads(h.sendBeaconCalls)[0];
  tracker.trackEvent({ name: 'signup', plan: 'pro', value: 49 });
  const p = payloads(h.sendBeaconCalls)[1];
  assert.equal(p.e, 'event');
  assert.equal(p.props.name, 'signup');
  assert.equal(p.props.plan, 'pro');
  assert.equal(p.props.value, 49);
  assert.equal(p.pvid, first.pvid);
  assert.ok(p.event_id.startsWith(p.pvid + ':'));
  assert.notEqual(p.event_id, p.pvid);
});

test('identify sets uid on subsequent events', () => {
  const { h, tracker } = setup();
  tracker.identify('user@example.com');
  tracker.trackPageview();
  const p = payloads(h.sendBeaconCalls)[1];
  assert.equal(p.uid, 'user@example.com');
});

test('reset clears cookies and storage', () => {
  const { h, tracker } = setup({ mode: 'cookies' });
  assert.ok(h.cookies.size > 0 || h.storage.size > 0);
  tracker.reset();
  assert.equal(h.cookies.size, 0);
  assert.equal(h.storage.size, 0);
});

test('optOut stops sends', () => {
  const { h, tracker } = setup();
  const before = h.sendBeaconCalls.length;
  tracker.optOut();
  tracker.trackPageview();
  tracker.trackEvent({ name: 'x' });
  assert.equal(h.sendBeaconCalls.length, before);
});

test('a high bot score drops the pageview when blockBots is on', () => {
  const h = makeEnv();
  h.navigator.webdriver = true;
  const tracker = createTracker({ ...base, blockBots: true }, h.env);
  tracker.init();
  assert.equal(h.sendBeaconCalls.length, 0);
});

test('PII query keys are redacted', () => {
  const h = makeEnv();
  h.location.search = '?email=user@example.com&plan=pro';
  h.location.href = 'https://example.com/pricing?email=user@example.com&plan=pro';
  const tracker = createTracker(base, h.env);
  tracker.init();
  const [p] = payloads(h.sendBeaconCalls);
  assert.equal(p.q, 'plan=pro');
  assert.equal(p.u, 'https://example.com/pricing?plan=pro');
});

test('requireConsent starts cookieless and upgrades on consent', () => {
  const { h, tracker } = setup({ requireConsent: true });
  assert.equal(h.sendBeaconCalls.length, 0);
  tracker.setConsent({ analytics: true });
  assert.equal(h.sendBeaconCalls.length, 1);
  const [p] = payloads(h.sendBeaconCalls);
  assert.match(p.vid, /^[0-9a-f]{32}$/);
});

test('DNT defaults to cookieless', () => {
  const h = makeEnv();
  h.navigator.doNotTrack = '1';
  const tracker = createTracker(base, h.env);
  tracker.init();
  const [p] = payloads(h.sendBeaconCalls);
  assert.equal(p.vid, undefined);
});

test('sendBeacon falling back to fetch still sends once', () => {
  const h = makeEnv();
  h.navigator.sendBeacon = () => false;
  const tracker = createTracker(base, h.env);
  tracker.init();
  assert.equal(h.sendBeaconCalls.length, 0);
  assert.equal(h.fetchCalls.length, 1);
  assert.equal(h.fetchCalls[0].opts.method, 'POST');
});
