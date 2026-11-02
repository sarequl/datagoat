// Standalone checkout handoff helpers.
//
// getCheckoutContext() reads the visitor id, session hint and first-touch UTM
// from the cookie/localStorage. setCheckoutMetadata() merges them into a
// provider payload so milestone 2 can join a payment to a visitor.
//
// Kept separate from core.js so the served t.js bundle stays small; load this
// on checkout pages (IIFE: window.DataGoatCheckout) or import it in the npm
// package.

import { DEFAULTS, defaultEnv } from './core.js';

export function readIdentity(env, options) {
  const config = Object.assign({}, DEFAULTS, options || {});
  const e = env || defaultEnv();
  const vid = readCookieValue(e, config.cookieName) || readStorageValue(e, config.cookieName) || null;
  const start = parseInt(readStorageValue(e, config.sessionKey) || '0', 10);
  const sid = start ? base64urlValue(e, (vid || 'anon') + ':' + Math.floor(start / 1000)) : null;
  const utm = readFirstTouchValue(e, config);
  return { visitor_id: vid, session_id: sid, utm };
}

export function mergeCheckoutMetadata(payload, ctx) {
  payload = payload || {};
  ctx = ctx || {};
  const metadata = Object.assign({}, payload.metadata || {});
  if (ctx.visitor_id) {
    metadata.datagoat_visitor_id = ctx.visitor_id;
    // Migration alias so a site switching from DataFast keeps attribution.
    metadata.datafast_visitor_id = ctx.visitor_id;
  }
  if (ctx.session_id) metadata.session_id = ctx.session_id;
  if (ctx.utm && typeof ctx.utm === 'object') {
    ['source', 'medium', 'campaign', 'term', 'content'].forEach((k) => {
      if (ctx.utm[k]) metadata['utm_' + k] = ctx.utm[k];
    });
  }
  payload.metadata = metadata;
  if (ctx.visitor_id && !payload.client_reference_id) payload.client_reference_id = ctx.visitor_id;
  return payload;
}

export function getCheckoutContext(env, config) {
  return readIdentity(env, config);
}

export function setCheckoutMetadata(payload, ctx, env, config) {
  const context = ctx || getCheckoutContext(env, config);
  return mergeCheckoutMetadata(payload, context);
}

function readCookieValue(e, name) {
  const doc = e.document;
  if (!doc || !doc.cookie) return null;
  const m = doc.cookie.match(new RegExp('(?:^|;\\s*)' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}

function readStorageValue(e, key) {
  try {
    const store = e.window && e.window.localStorage;
    return store ? store.getItem(key) : null;
  } catch (err) {
    return null;
  }
}

function base64urlValue(e, str) {
  const b = e.window && e.window.btoa
    ? e.window.btoa(str)
    : typeof Buffer !== 'undefined'
      ? Buffer.from(str, 'binary').toString('base64')
      : '';
  return b.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function readFirstTouchValue(e, config) {
  const raw = readCookieValue(e, config.utmCookieName) || readStorageValue(e, config.utmCookieName);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

export default { getCheckoutContext, setCheckoutMetadata, readIdentity, mergeCheckoutMetadata };
