'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../lib/pricing');

test('parseModelId handles new, legacy, dated, suffixed and provider-prefixed ids', () => {
  const cases = {
    'claude-opus-4-6': ['opus', 4, 6],
    'claude-opus-4-5-20251101': ['opus', 4, 5],
    'claude-opus-4-20250514': ['opus', 4, 0],
    'claude-opus-4-1@20250805': ['opus', 4, 1],
    'claude-opus-5-5': ['opus', 5, 5],
    'claude-opus-5-5[1m]': ['opus', 5, 5],
    'claude-opus-5': ['opus', 5, 0],
    'claude-fable-5-1': ['fable', 5, 1],
    'claude-sonnet-4-5-20250929': ['sonnet', 4, 5],
    'us.anthropic.claude-sonnet-4-5-20250929-v1:0': ['sonnet', 4, 5],
    'claude-3-5-haiku-20241022': ['haiku', 3, 5],
    'claude-3-7-sonnet-20250219': ['sonnet', 3, 7],
    'claude-3-haiku-20240307': ['haiku', 3, 0],
    'claude-haiku-4-5': ['haiku', 4, 5],
  };
  for (const [id, [family, major, minor]] of Object.entries(cases)) {
    assert.deepEqual(P.parseModelId(id), { family, major, minor }, id);
  }
  assert.equal(P.parseModelId(''), null);
  assert.equal(P.parseModelId('gpt-4'), null);
});

test('prices match current Anthropic list prices', () => {
  // Opus 4.5+ dropped to $5/$25; the old table charged $15/$75 (3x too high).
  assert.equal(P.getPricing('claude-opus-4-6').input, 5);
  assert.equal(P.getPricing('claude-opus-4-6').output, 25);
  assert.equal(P.getPricing('claude-opus-4-5-20251101').output, 25);
  assert.equal(P.getPricing('claude-opus-4-1-20250805').output, 75);
  assert.equal(P.getPricing('claude-opus-4-20250514').input, 15);
  assert.equal(P.getPricing('claude-opus-5-5').input, 4);
  assert.equal(P.getPricing('claude-opus-5-5').cache_read, 0.2);
  assert.equal(P.getPricing('claude-sonnet-5-5').output, 10);
  assert.equal(P.getPricing('claude-sonnet-4-6').input, 3);
  assert.equal(P.getPricing('claude-haiku-4-5-20251001').output, 5);
  assert.equal(P.getPricing('claude-haiku-5-5').input, 0.1);
  assert.equal(P.getPricing('claude-3-5-haiku-20241022').input, 0.8);
  assert.equal(P.getPricing('claude-fable-5-1').cache_read, 0.25);
  // cache writes: 5m = 1.25x input, 1h = 2x input
  assert.equal(P.getPricing('claude-sonnet-4-6').cache_write, 3.75);
  assert.equal(P.getPricing('claude-sonnet-4-6').cache_write_1h, 6);
});

test('unknown versions fall back to newest in family; unknown family to Sonnet', () => {
  assert.equal(P.getPricing('claude-opus-9-9'), P.PRICING['opus-5.5']);
  assert.equal(P.getPricing('mystery-model'), P.PRICING['sonnet-5.5']);
  assert.equal(P.getPricing(null), P.PRICING['sonnet-5.5']);
});

test('labels and families', () => {
  assert.equal(P.getModelLabel('claude-opus-4-1-20250805'), 'Opus 4.1');
  assert.equal(P.getModelLabel('claude-opus-4-6'), 'Opus 4.6');
  assert.equal(P.getModelLabel('claude-3-5-haiku-20241022'), 'Haiku 3.5');
  assert.equal(P.getModelLabel('claude-opus-9-2'), 'Opus 9.2');
  assert.equal(P.getModelFamily('claude-fable-5-1'), 'fable');
  assert.equal(P.getModelColor('claude-sonnet-4-6'), '#89b4fa');
});

test('synthetic models are not billable', () => {
  assert.equal(P.isBillableModel('<synthetic>'), false);
  assert.equal(P.isBillableModel(''), false);
  assert.equal(P.isBillableModel('claude-opus-4-6'), true);
});

test('costForUsage prices each bucket including 1h cache writes', () => {
  const c = P.costForUsage('claude-sonnet-4-6', {
    input: 1e6, output: 1e6, cache_read: 1e6, cache_write_5m: 1e6, cache_write_1h: 1e6,
  });
  assert.equal(c.input, 3);
  assert.equal(c.output, 15);
  assert.ok(Math.abs(c.cacheRead - 0.3) < 1e-9);
  assert.ok(Math.abs(c.cacheWrite - (3.75 + 6)) < 1e-9);
  assert.ok(Math.abs(c.total - 28.05) < 1e-9);
});

test('pricing reference rows are complete', () => {
  for (const r of P.pricingReference()) {
    for (const k of ['label', 'input', 'output', 'cache_read', 'cache_write']) assert.ok(r[k] !== undefined, `${r.key}.${k}`);
  }
});
