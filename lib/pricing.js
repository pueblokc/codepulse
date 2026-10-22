/**
 * Pricing — Anthropic first-party API list prices, USD per 1M tokens.
 *
 * Source: Anthropic model/pricing docs, checked 2026-10-22.
 *   cache_write    = 5-minute prompt-cache write (1.25x input)
 *   cache_write_1h = 1-hour prompt-cache write  (2x input)
 *   cache_read     = cache hit (usually 0.1x input; Fable 5.1, Opus 5.5 and
 *                    the 5.5 Sonnet/Haiku are cheaper, see table)
 *
 * Known simplifications (documented in CLOUD_WAVE2_REPORT.md):
 *   - Haiku 5.5 is priced at its <=100K-prompt tier ($0.10/$0.50).
 *   - Long-context (>200K) premiums on older Sonnet models are ignored.
 *   - Batch / fast-mode / partner-cloud pricing is not modelled.
 */

function rate(input, output, cacheRead) {
  return {
    input,
    output,
    cache_read: cacheRead != null ? cacheRead : round6(input * 0.1),
    cache_write: round6(input * 1.25),
    cache_write_1h: round6(input * 2),
  };
}
function round6(n) { return Math.round(n * 1e6) / 1e6; }

// Keys are "<family>-<major>.<minor>" (minor 0 when the id has none).
const PRICING = {
  'fable-5.1':  { label: 'Fable 5.1',  ...rate(10, 50, 0.25) },
  'fable-5.0':  { label: 'Fable 5',    ...rate(10, 50, 1.0) },
  'mythos-5.1': { label: 'Mythos 5.1', ...rate(10, 50, 0.25) },
  'mythos-5.0': { label: 'Mythos 5',   ...rate(10, 50, 1.0) },

  'opus-5.5':   { label: 'Opus 5.5',   ...rate(4, 20, 0.20) },
  'opus-5.0':   { label: 'Opus 5',     ...rate(5, 25) },
  'opus-4.8':   { label: 'Opus 4.8',   ...rate(5, 25) },
  'opus-4.7':   { label: 'Opus 4.7',   ...rate(5, 25) },
  'opus-4.6':   { label: 'Opus 4.6',   ...rate(5, 25) },
  'opus-4.5':   { label: 'Opus 4.5',   ...rate(5, 25) },
  'opus-4.1':   { label: 'Opus 4.1',   ...rate(15, 75) },
  'opus-4.0':   { label: 'Opus 4',     ...rate(15, 75) },
  'opus-3.0':   { label: 'Opus 3',     ...rate(15, 75) },

  'sonnet-5.5': { label: 'Sonnet 5.5', ...rate(2, 10, 0.20) },
  'sonnet-5.0': { label: 'Sonnet 5',   ...rate(2, 10) },
  'sonnet-4.6': { label: 'Sonnet 4.6', ...rate(3, 15) },
  'sonnet-4.5': { label: 'Sonnet 4.5', ...rate(3, 15) },
  'sonnet-4.0': { label: 'Sonnet 4',   ...rate(3, 15) },
  'sonnet-3.7': { label: 'Sonnet 3.7', ...rate(3, 15) },
  'sonnet-3.5': { label: 'Sonnet 3.5', ...rate(3, 15) },

  'haiku-5.5':  { label: 'Haiku 5.5',  ...rate(0.10, 0.50, 0.01) },
  'haiku-4.5':  { label: 'Haiku 4.5',  ...rate(1, 5) },
  'haiku-3.5':  { label: 'Haiku 3.5',  ...rate(0.80, 4) },
  'haiku-3.0':  { label: 'Haiku 3',    ...rate(0.25, 1.25, 0.03) },
};

// Newest of each family — used when an id names a family but a version we
// don't know yet (e.g. a model released after this table was written).
const FAMILY_LATEST = {
  fable: 'fable-5.1',
  mythos: 'mythos-5.1',
  opus: 'opus-5.5',
  sonnet: 'sonnet-5.5',
  haiku: 'haiku-5.5',
};

// Unknown / unparseable model ids are priced as the current Sonnet.
const DEFAULT_KEY = 'sonnet-5.5';

const FAMILY_COLORS = {
  fable: '#f9e2af',  // yellow
  mythos: '#f9e2af',
  opus: '#cba6f7',   // mauve
  sonnet: '#89b4fa', // blue
  haiku: '#a6e3a1',  // green
};

/**
 * Parse a Claude model id into { family, major, minor }.
 * Handles: claude-opus-4-5-20251101, claude-opus-4-20250514, claude-opus-5-5,
 * claude-opus-5-5[1m], claude-3-5-haiku-20241022, claude-3-7-sonnet-latest,
 * us.anthropic.claude-sonnet-4-5-20250929-v1:0, claude-opus-4-1@20250805.
 */
function parseModelId(model) {
  if (!model || typeof model !== 'string') return null;
  const m = model.toLowerCase();

  // New-style: <family>-<major>[-<minor>] where minor is 1-2 digits (not a date)
  let r = m.match(/(fable|mythos|opus|sonnet|haiku)-(\d{1,2})(?:[-.](\d{1,2}))?(?!\d)/);
  if (r) return { family: r[1], major: +r[2], minor: r[3] != null ? +r[3] : 0 };

  // Legacy: claude-<major>[-<minor>]-<family>
  r = m.match(/claude-(\d)(?:-(\d))?-(opus|sonnet|haiku)/);
  if (r) return { family: r[3], major: +r[1], minor: r[2] != null ? +r[2] : 0 };

  r = m.match(/(fable|mythos|opus|sonnet|haiku)/);
  if (r) return { family: r[1], major: null, minor: null };
  return null;
}

function resolveKey(model) {
  const p = parseModelId(model);
  if (!p) return DEFAULT_KEY;
  if (p.major != null) {
    const key = `${p.family}-${p.major}.${p.minor}`;
    if (PRICING[key]) return key;
  }
  return FAMILY_LATEST[p.family] || DEFAULT_KEY;
}

function getPricing(model) {
  return PRICING[resolveKey(model)];
}

function getModelLabel(model) {
  if (!model) return 'Unknown';
  const p = parseModelId(model);
  if (!p) return model;
  if (p.major != null) {
    const key = `${p.family}-${p.major}.${p.minor}`;
    if (PRICING[key]) return PRICING[key].label;
    const fam = p.family[0].toUpperCase() + p.family.slice(1);
    return p.minor ? `${fam} ${p.major}.${p.minor}` : `${fam} ${p.major}`;
  }
  return p.family[0].toUpperCase() + p.family.slice(1);
}

function getModelFamily(model) {
  const p = parseModelId(model);
  return p ? p.family : null;
}

function getModelColor(model) {
  return FAMILY_COLORS[getModelFamily(model)] || '#a6adc8';
}

/** Claude Code writes model "<synthetic>" for locally generated messages. */
function isBillableModel(model) {
  return !!model && typeof model === 'string' && !model.startsWith('<');
}

/**
 * Cost of one usage bucket.
 * usage: { input, output, cache_read, cache_write_5m, cache_write_1h }
 */
function costForUsage(model, usage) {
  const p = getPricing(model);
  const u = usage || {};
  const input = (u.input || 0) / 1e6 * p.input;
  const output = (u.output || 0) / 1e6 * p.output;
  const cacheRead = (u.cache_read || 0) / 1e6 * p.cache_read;
  const cacheWrite = (u.cache_write_5m || 0) / 1e6 * p.cache_write
                   + (u.cache_write_1h || 0) / 1e6 * p.cache_write_1h;
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

/** Rows for the in-app pricing reference table (current generation only). */
function pricingReference() {
  return ['fable-5.1', 'opus-5.5', 'opus-4.8', 'sonnet-5.5', 'sonnet-4.6', 'haiku-5.5', 'haiku-4.5']
    .map(k => ({ key: k, family: k.split('-')[0], ...PRICING[k] }));
}

module.exports = {
  PRICING,
  parseModelId,
  getPricing,
  getModelLabel,
  getModelFamily,
  getModelColor,
  isBillableModel,
  costForUsage,
  pricingReference,
};
