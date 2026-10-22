/**
 * Cost Calculator — turns token usage into API-equivalent dollar figures.
 *
 * Two data sources:
 *   1. Session transcripts (exact per-message usage, per model, per local day).
 *      Used for every day they cover — including "today", which the
 *      stats-cache usually hasn't been recomputed for yet.
 *   2. ~/.claude/stats-cache.json (all-time per-model totals + per-day combined
 *      token counts). Used for all-time totals and for days older than the
 *      transcripts Claude Code still keeps on disk.
 */

const Pricing = require('./pricing');
const { localDateKey, addDaysKey, daysInMonth } = require('./dates');

const { getPricing, getModelColor, PRICING } = Pricing;

/** Back-compat label helper (old API name). */
function getModelFamily(model) { return Pricing.getModelLabel(model); }

/** stats-cache modelUsage entry -> cost breakdown (5m cache-write rate). */
function calculateModelCost(model, usage) {
  return Pricing.costForUsage(model, {
    input: usage.inputTokens,
    output: usage.outputTokens,
    cache_read: usage.cacheReadInputTokens,
    cache_write_5m: usage.cacheCreationInputTokens,
  });
}

/**
 * Cost estimate for a stats-cache dailyModelTokens entry.
 * tokensByModel only has a combined (input+output) count, so a blended
 * (input+output)/2 rate is used. This is an approximation; prefer
 * transcript-derived costs where available.
 */
function calcDayCostFromEntry(entry) {
  let dayCost = 0;
  const byModel = (entry && entry.tokensByModel) || {};
  for (const [model, tokens] of Object.entries(byModel)) {
    if (!Pricing.isBillableModel(model)) continue;
    const p = getPricing(model);
    dayCost += ((Number(tokens) || 0) / 1e6) * ((p.input + p.output) / 2);
  }
  return dayCost;
}

/** Exact cost of one transcript day bucket { model: usage }. */
function calcDayCostFromUsage(byModel) {
  let c = 0;
  for (const [model, u] of Object.entries(byModel || {})) c += Pricing.costForUsage(model, u).total;
  return c;
}

/**
 * Returns dateKey -> cost. Transcript days win; stats-cache fills older days.
 */
function buildDailyCostLookup(statsData, daily) {
  const fromStats = {};
  for (const e of (statsData && statsData.dailyModelTokens) || []) {
    if (e && e.date) fromStats[e.date] = calcDayCostFromEntry(e);
  }
  const fromTranscripts = {};
  for (const [day, byModel] of Object.entries(daily || {})) fromTranscripts[day] = calcDayCostFromUsage(byModel);

  const lookup = (day) => {
    if (Object.prototype.hasOwnProperty.call(fromTranscripts, day)) return fromTranscripts[day];
    return fromStats[day] || 0;
  };
  lookup.days = () => Array.from(new Set([...Object.keys(fromStats), ...Object.keys(fromTranscripts)])).sort();
  return lookup;
}

/**
 * Estimate cost for a single parsed session. Sessions parsed by
 * transcript-parser already carry an exact per-model `cost_usd`.
 */
function estimateSessionCost(session) {
  if (!session) return 0;
  if (typeof session.cost_usd === 'number') return session.cost_usd;
  if (!session.tokens) return 0;
  const t = session.tokens;
  const models = session.models_used || [];
  return Pricing.costForUsage(models[0], {
    input: t.input, output: t.output, cache_read: t.cache_read, cache_write_5m: t.cache_creation,
  }).total;
}

/** Convert transcript daily buckets into stats-cache-style modelUsage. */
function modelUsageFromDaily(daily) {
  const out = {};
  for (const byModel of Object.values(daily || {})) {
    for (const [model, u] of Object.entries(byModel)) {
      const m = out[model] || (out[model] = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
      m.inputTokens += u.input;
      m.outputTokens += u.output;
      m.cacheReadInputTokens += u.cache_read;
      m.cacheCreationInputTokens += u.cache_write_5m + u.cache_write_1h;
    }
  }
  return out;
}

/**
 * Calculate all cost metrics.
 * @param statsData  parsed stats-cache.json (may be {})
 * @param config     dashboard config (monthlySubscriptionCost)
 * @param opts       { daily: transcript day buckets, now: Date }
 */
function calculateAll(statsData, config, opts = {}) {
  statsData = statsData || {};
  const now = opts.now instanceof Date ? opts.now : new Date();
  const daily = opts.daily || {};
  const dailyModelTokens = statsData.dailyModelTokens || [];
  const monthlySubscriptionCost = (config && config.monthlySubscriptionCost != null)
    ? config.monthlySubscriptionCost
    : 200;

  let modelUsage = statsData.modelUsage || {};
  let totalsSource = 'stats-cache';
  if (Object.keys(modelUsage).length === 0 && Object.keys(daily).length > 0) {
    modelUsage = modelUsageFromDaily(daily);
    totalsSource = 'transcripts';
  }

  let totalCost = 0;
  const modelCosts = {};
  const modelDistribution = [];
  let totalTokens = 0, totalInput = 0, totalOutput = 0, totalCacheRead = 0;
  let cacheSavings = 0;

  for (const [model, usage] of Object.entries(modelUsage)) {
    if (!Pricing.isBillableModel(model)) continue;
    const costs = calculateModelCost(model, usage);
    modelCosts[model] = { ...costs, name: Pricing.getModelLabel(model), color: getModelColor(model) };
    totalCost += costs.total;

    const input = usage.inputTokens || 0;
    const output = usage.outputTokens || 0;
    const cacheRead = usage.cacheReadInputTokens || 0;
    totalTokens += input + output;
    totalInput += input;
    totalOutput += output;
    totalCacheRead += cacheRead;

    const p = getPricing(model);
    cacheSavings += cacheRead / 1e6 * (p.input - p.cache_read);

    modelDistribution.push({
      model,
      name: Pricing.getModelLabel(model),
      color: getModelColor(model),
      tokens: input + output,
      input,
      output,
      cacheRead,
      cost: costs.total,
    });
  }

  modelDistribution.sort((a, b) => b.tokens - a.tokens);
  for (const m of modelDistribution) m.pct = totalTokens > 0 ? (m.tokens / totalTokens * 100) : 0;

  const cacheRate = (totalInput + totalCacheRead) > 0
    ? (totalCacheRead / (totalInput + totalCacheRead) * 100)
    : 0;

  const dayCost = buildDailyCostLookup(statsData, daily);
  const today = localDateKey(now);

  const todayCost = dayCost(today);

  // Last 7 days including today.
  let weekCost = 0;
  for (let i = 0; i < 7; i++) weekCost += dayCost(addDaysKey(now, -i));

  // Calendar month to date (the UI labels this "This Month").
  const dom = now.getDate();
  let monthCost = 0;
  for (let i = 0; i < dom; i++) monthCost += dayCost(addDaysKey(now, -i));

  let last30Cost = 0;
  for (let i = 0; i < 30; i++) last30Cost += dayCost(addDaysKey(now, -i));

  const projectedMonthly = (monthCost / dom) * daysInMonth(now);

  // Weekly usage counters since the most recent Wednesday (local).
  const daysSinceWed = (now.getDay() - 3 + 7) % 7;
  const lastWedDate = addDaysKey(now, -daysSinceWed);
  let weeklyOpusUsed = 0, weeklySonnetUsed = 0, weeklyTotalUsed = 0;
  for (const entry of dailyModelTokens) {
    if (entry && entry.date >= lastWedDate && entry.date <= today && entry.tokensByModel) {
      for (const [model, count] of Object.entries(entry.tokensByModel)) {
        const n = Number(count) || 0;
        weeklyTotalUsed += n;
        const fam = Pricing.getModelFamily(model);
        if (fam === 'opus') weeklyOpusUsed += n;
        else if (fam === 'sonnet') weeklySonnetUsed += n;
      }
    }
  }

  return {
    totalCost,
    todayCost,
    weekCost,
    monthCost,
    last30Cost,
    projectedMonthly,
    cacheSavings,
    cacheRate,
    totalTokens,
    totalInput,
    totalOutput,
    totalCacheRead,
    totalsSource,
    modelCosts,
    modelDistribution,
    weeklyOpusUsed,
    weeklySonnetUsed,
    weeklyTotalUsed,
    monthlySubscriptionCost,
    pricingReference: Pricing.pricingReference(),
  };
}

module.exports = {
  calculateAll,
  estimateSessionCost,
  calcDayCostFromEntry,
  calcDayCostFromUsage,
  buildDailyCostLookup,
  getPricing,
  getModelFamily,
  getModelColor,
  PRICING,
};
