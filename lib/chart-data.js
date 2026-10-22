/**
 * Chart Data Preparation — transforms stats-cache + transcript usage into
 * Chart.js-ready datasets. Every series is aligned to the same continuous
 * range of local calendar days ending today, so gaps in the source data show
 * up as zero instead of shifting later points onto the wrong labels.
 */

const CostCalculator = require('./cost-calculator');
const Pricing = require('./pricing');
const { lastNDays } = require('./dates');

const FAMILIES = ['fable', 'opus', 'sonnet', 'haiku'];

function prepare(statsData, historyDays = 30, opts = {}) {
  statsData = statsData || {};
  const now = opts.now instanceof Date ? opts.now : new Date();
  const daily = opts.daily || {};
  const days = Math.max(1, Math.min(3650, parseInt(historyDays, 10) || 30));

  const activityByDate = {};
  for (const d of statsData.dailyActivity || []) if (d && d.date) activityByDate[d.date] = d;
  const statsTokensByDate = {};
  for (const e of statsData.dailyModelTokens || []) if (e && e.date) statsTokensByDate[e.date] = e.tokensByModel || {};

  const range = lastNDays(days, now);
  const dates = range.map(k => k.slice(5)); // MM-DD

  const messages = range.map(k => (activityByDate[k] && activityByDate[k].messageCount) || 0);
  const sessions = range.map(k => (activityByDate[k] && activityByDate[k].sessionCount) || 0);
  const tools = range.map(k => (activityByDate[k] && activityByDate[k].toolCallCount) || 0);

  // Per-family (input+output) tokens per day; transcripts win over stats-cache.
  const familyTokens = Object.fromEntries(FAMILIES.map(f => [f, []]));
  const dayTotals = [];
  for (const k of range) {
    const perFamily = Object.fromEntries(FAMILIES.map(f => [f, 0]));
    let total = 0;
    if (daily[k]) {
      for (const [model, u] of Object.entries(daily[k])) {
        const n = (u.input || 0) + (u.output || 0);
        const fam = Pricing.getModelFamily(model);
        if (fam === 'mythos') perFamily.fable += n;
        else if (perFamily[fam] !== undefined) perFamily[fam] += n;
        total += n;
      }
    } else if (statsTokensByDate[k]) {
      for (const [model, count] of Object.entries(statsTokensByDate[k])) {
        if (!Pricing.isBillableModel(model)) continue;
        const n = Number(count) || 0;
        const fam = Pricing.getModelFamily(model);
        if (fam === 'mythos') perFamily.fable += n;
        else if (perFamily[fam] !== undefined) perFamily[fam] += n;
        total += n;
      }
    }
    for (const f of FAMILIES) familyTokens[f].push(perFamily[f]);
    dayTotals.push(total);
  }

  const dayCost = CostCalculator.buildDailyCostLookup(statsData, daily);
  const dailyCosts = range.map(k => Math.round(dayCost(k) * 100) / 100);

  let running = 0;
  const cumulativeTokens = dayTotals.map(n => (running += n));

  // Hour heatmap
  const hourCounts = statsData.hourCounts || {};
  const hourData = [];
  let maxHourCount = 0;
  for (let i = 0; i < 24; i++) {
    const count = parseInt(hourCounts[String(i)] || '0', 10) || 0;
    hourData.push({ hour: i, count });
    if (count > maxHourCount) maxHourCount = count;
  }
  const peakHour = hourData.reduce((max, h) => h.count > max.count ? h : max, { hour: 0, count: 0 });

  // Recent activity: last 7 calendar days that have stats, most recent first.
  const recentDays = lastNDays(7, now).reverse().filter(k => activityByDate[k]).map(k => activityByDate[k]);

  return {
    dates,
    dateKeys: range,
    messages,
    sessions,
    tools,
    fableTokens: familyTokens.fable,
    opusTokens: familyTokens.opus,
    sonnetTokens: familyTokens.sonnet,
    haikuTokens: familyTokens.haiku,
    dailyCosts,
    costTimeline: dailyCosts,
    cumulativeTokens,
    hourData,
    maxHourCount,
    peakHour,
    recentDays,
  };
}

module.exports = { prepare };
