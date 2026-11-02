import test from 'node:test';
import assert from 'node:assert/strict';
import { createTracker } from '../src/core.js';
import { getCheckoutContext, setCheckoutMetadata, readIdentity } from '../src/checkout.js';
import { makeEnv } from './helpers.js';

test('getCheckoutContext reads the visitor id and session', () => {
  const h = makeEnv();
  const tracker = createTracker({ site: 's1', endpoint: 'https://example.com' }, h.env);
  tracker.init();
  const ctx = getCheckoutContext(h.env, {});
  assert.match(ctx.visitor_id, /^[0-9a-f]{32}$/);
  assert.ok(ctx.session_id);
  assert.equal(typeof ctx.utm, 'object');
});

test('readIdentity returns nulls when nothing is stored', () => {
  const h = makeEnv();
  const ctx = readIdentity(h.env, {});
  assert.equal(ctx.visitor_id, null);
  assert.equal(ctx.session_id, null);
  assert.equal(ctx.utm, null);
});

test('setCheckoutMetadata merges the provider metadata', () => {
  const h = makeEnv();
  const payload = { amount: 100, metadata: { existing: 'yes' } };
  const out = setCheckoutMetadata(
    payload,
    { visitor_id: 'v'.repeat(32), session_id: 'sess1', utm: { source: 'google', medium: 'cpc' } },
    h.env,
    {}
  );
  assert.equal(out.metadata.existing, 'yes');
  assert.equal(out.metadata.datagoat_visitor_id, 'v'.repeat(32));
  assert.equal(out.metadata.datafast_visitor_id, 'v'.repeat(32));
  assert.equal(out.metadata.session_id, 'sess1');
  assert.equal(out.metadata.utm_source, 'google');
  assert.equal(out.metadata.utm_medium, 'cpc');
  assert.equal(out.client_reference_id, 'v'.repeat(32));
});

test('setCheckoutMetadata does not overwrite an existing client_reference_id', () => {
  const h = makeEnv();
  const out = setCheckoutMetadata(
    { client_reference_id: 'keep-me' },
    { visitor_id: 'v'.repeat(32) },
    h.env,
    {}
  );
  assert.equal(out.client_reference_id, 'keep-me');
});
