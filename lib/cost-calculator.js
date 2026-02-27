/**
 * Cost Calculator — Claude API pricing engine.
 * Prices per 1M tokens as of 2026.
 */

const PRICING = {
  'claude-opus-4-6':             { input: 15.0, output: 75.0, cache_read: 1.5, cache_write: 18.75 },
  'claude-opus-4-5-20251101':    { input: 15.0, output: 75.0, cache_read: 1.5, cache_write: 18.75 },
  'claude-sonnet-4-6':           { input: 3.0,  output: 15.0, cache_read: 0.3, cache_write: 3.75 },
  'claude-sonnet-4-5-20250929':  { input: 3.0,  output: 15.0, cache_read: 0.3, cache_write: 3.75 },
  'claude-haiku-4-5-20251001':   { input: 1.0,  output: 5.0,  cache_read: 0.1, cache_write: 1.25 },
  'claude-3-5-haiku-20241022':   { input: 0.80, output: 4.0,  cache_read: 0.08, cache_write: 1.0 },
};

const DEFAULT_PRICING = PRICING['claude-sonnet-4-6'];

function getPricing(model) {
  if (!model) return DEFAULT_PRICING;
  // Exact match first
  if (PRICING[model]) return PRICING[model];
  // Fuzzy match by family
  const m = model.toLowerCase();
  if (m.includes('opus')) return PRICING['claude-opus-4-6'];
  if (m.includes('sonnet')) return PRICING['claude-sonnet-4-6'];
  if (m.includes('haiku')) return PRICING['claude-haiku-4-5-20251001'];
  return DEFAULT_PRICING;
}

function getModelFamily(model) {
  const m = (model || '').toLowerCase();
  if (m.includes('opus-4-6')) return 'Opus 4.6';
  if (m.includes('opus')) return 'Opus 4.5';
  if (m.includes('sonnet-4-6')) return 'Sonnet 4.6';
  if (m.includes('sonnet')) return 'Sonnet 4.5';
  if (m.includes('haiku-4-5')) return 'Haiku 4.5';
  if (m.includes('haiku')) return 'Haiku 3.5';
  return model || 'Unknown';
}

function getModelColor(model) {
  const m = (model || '').toLowerCase();
  if (m.includes('opus')) return '#cba6f7';   // mauve
  if (m.includes('sonnet')) return '#89b4fa';  // blue
  if (m.includes('haiku')) return '#a6e3a1';   // green
  return '#a6adc8'; // subtext0
}

/**
 * Calculate cost for a single model's usage.
 * Uses real input/output token split from stats-cache modelUsage entries.
 */
function calculateModelCost(model, usage) {
  const p = getPricing(model);
  const inputCost = (usage.inputTokens || 0) / 1e6 * p.input;
  const outputCost = (usage.outputTokens || 0) / 1e6 * p.output;
  const cacheReadCost = (usage.cacheReadInputTokens || 0) / 1e6 * p.cache_read;
  const cacheWriteCost = (usage.cacheCreationInputTokens || 0) / 1e6 * p.cache_write;
  return {
    input: inputCost,
    output: outputCost,
    cacheRead: cacheReadCost,
    cacheWrite: cacheWriteCost,
    total: inputCost + outputCost + cacheReadCost + cacheWriteCost,
  };
}

/**
 * Calculate daily cost from dailyModelTokens using actual model pricing.
 * dailyModelTokens entries have: { date, tokensByModel: { modelId: count } }
 *
 * The tokensByModel count represents total tokens (combined input+output).
 * We use the model's average (input+output)/2 rate as the best approximation
 * when we only have a combined token count. This is consistent across all
 * time-period calculations in the app.
 */
function calcDayCostFromEntry(entry) {
  let dayCost = 0;
  const byModel = entry.tokensByModel || {};
  for (const [model, tokens] of Object.entries(byModel)) {
    const p = getPricing(model);
    // tokensByModel stores total tokens without input/output split.
    // Use the midpoint of input and output price as the blended rate.
    const blendedRate = (p.input + p.output) / 2;
    dayCost += (tokens / 1e6) * blendedRate;
  }
  return dayCost;
}

/**
 * Estimate cost for a single parsed session.
 * Uses actual token counts from session file + model pricing.
 */
function estimateSessionCost(session) {
  if (!session || !session.tokens) return 0;
  const t = session.tokens;
  const models = session.models_used || [];
  let p = DEFAULT_PRICING;
  if (models.length === 1) {
    p = getPricing(models[0]);
  } else if (models.some(m => m.toLowerCase().includes('opus'))) {
    p = PRICING['claude-opus-4-6'];
  } else if (models.some(m => m.toLowerCase().includes('sonnet'))) {
    p = PRICING['claude-sonnet-4-6'];
  }

  return (t.input || 0) / 1e6 * p.input
       + (t.output || 0) / 1e6 * p.output
       + (t.cache_read || 0) / 1e6 * p.cache_read
       + (t.cache_creation || 0) / 1e6 * p.cache_write;
}

/**
 * Calculate all cost metrics from stats-cache data.
 * config is optional — used for monthlySubscriptionCost.
 */
function calculateAll(statsData, config) {
  const modelUsage = statsData.modelUsage || {};
  const dailyActivity = statsData.dailyActivity || [];
  const dailyModelTokens = statsData.dailyModelTokens || [];
  const monthlySubscriptionCost = (config && config.monthlySubscriptionCost != null)
    ? config.monthlySubscriptionCost
    : 200;

  // Per-model cost breakdown using real token data from modelUsage
  let totalCost = 0;
  const modelCosts = {};
  const modelDistribution = [];

  let totalTokens = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;

  for (const [model, usage] of Object.entries(modelUsage)) {
    const costs = calculateModelCost(model, usage);
    modelCosts[model] = costs;
    totalCost += costs.total;

    const input = usage.inputTokens || 0;
    const output = usage.outputTokens || 0;
    const cacheRead = usage.cacheReadInputTokens || 0;
    totalTokens += input + output;
    totalInput += input;
    totalOutput += output;
    totalCacheRead += cacheRead;

    modelDistribution.push({
      model,
      name: getModelFamily(model),
      color: getModelColor(model),
      tokens: input + output,
      input,
      output,
      cacheRead,
      cost: costs.total,
    });
  }

  modelDistribution.sort((a, b) => b.tokens - a.tokens);

  for (const m of modelDistribution) {
    m.pct = totalTokens > 0 ? (m.tokens / totalTokens * 100) : 0;
  }

  // Cache savings: what was saved by reading from cache vs. paying full input price
  let cacheSavings = 0;
  for (const [model, usage] of Object.entries(modelUsage)) {
    const p = getPricing(model);
    const cr = usage.cacheReadInputTokens || 0;
    cacheSavings += (cr / 1e6 * p.input) - (cr / 1e6 * p.cache_read);
  }

  // Cache hit rate
  const cacheRate = (totalInput + totalCacheRead) > 0
    ? (totalCacheRead / (totalInput + totalCacheRead) * 100)
    : 0;

  // Today's cost using actual per-model token data
  const today = new Date().toISOString().slice(0, 10);
  let todayCost = 0;
  const todayEntry = dailyModelTokens.find(d => d.date === today);
  if (todayEntry) {
    todayCost = calcDayCostFromEntry(todayEntry);
  }

  // Weekly cost (last 7 days) using actual per-model token data
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  let weekCost = 0;
  for (const entry of dailyModelTokens) {
    if (entry.date >= weekAgo) {
      weekCost += calcDayCostFromEntry(entry);
    }
  }

  // Monthly cost (last 30 days) using actual per-model token data
  const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  let monthCost = 0;
  for (const entry of dailyModelTokens) {
    if (entry.date >= monthAgo) {
      monthCost += calcDayCostFromEntry(entry);
    }
  }

  // Projected monthly spend based on daily average this calendar month
  const daysThisMonth = new Date().getDate();
  const projectedMonthly = daysThisMonth > 0 ? (monthCost / daysThisMonth) * 30 : 0;

  // Weekly usage limits (from current Wednesday)
  const now = new Date();
  const daysSinceWed = (now.getDay() - 3 + 7) % 7;
  const lastWedDate = new Date(now.getTime() - daysSinceWed * 86400000).toISOString().slice(0, 10);
  let weeklyOpusUsed = 0, weeklySonnetUsed = 0, weeklyTotalUsed = 0;

  for (const entry of dailyModelTokens) {
    if (entry.date >= lastWedDate && entry.tokensByModel) {
      for (const [model, count] of Object.entries(entry.tokensByModel)) {
        weeklyTotalUsed += count;
        if (model.toLowerCase().includes('opus')) weeklyOpusUsed += count;
        else if (model.toLowerCase().includes('sonnet')) weeklySonnetUsed += count;
      }
    }
  }

  return {
    totalCost,
    todayCost,
    weekCost,
    monthCost,
    projectedMonthly,
    cacheSavings,
    cacheRate,
    totalTokens,
    totalInput,
    totalOutput,
    totalCacheRead,
    modelCosts,
    modelDistribution,
    weeklyOpusUsed,
    weeklySonnetUsed,
    weeklyTotalUsed,
    monthlySubscriptionCost,
    pricing: PRICING,
  };
}

module.exports = { calculateAll, estimateSessionCost, calcDayCostFromEntry, getPricing, getModelFamily, getModelColor, PRICING };
