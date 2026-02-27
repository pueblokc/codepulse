/**
 * Chart Data Preparation — transforms stats-cache into Chart.js-ready datasets.
 * All cost calculations use cost-calculator.js (real per-model pricing).
 */

const CostCalculator = require('./cost-calculator');

function prepare(statsData, historyDays = 30) {
  const dailyActivity = statsData.dailyActivity || [];
  const dailyModelTokens = statsData.dailyModelTokens || [];

  // Trim to history window
  const recentActivity = dailyActivity.slice(-historyDays);
  const recentTokens = dailyModelTokens.slice(-historyDays);

  // Date labels (MM-DD format)
  const dates = recentActivity.map(d => {
    const parts = (d.date || '').split('-');
    return parts.length >= 3 ? `${parts[1]}-${parts[2]}` : d.date;
  });

  // Messages per day
  const messages = recentActivity.map(d => d.messageCount || 0);

  // Sessions per day
  const sessions = recentActivity.map(d => d.sessionCount || 0);

  // Tool calls per day
  const tools = recentActivity.map(d => d.toolCallCount || 0);

  // Tokens by model per day (for stacked bar chart)
  const opusTokens = [];
  const sonnetTokens = [];
  const haikuTokens = [];

  for (const entry of recentTokens) {
    const byModel = entry.tokensByModel || {};
    let opus = 0, sonnet = 0, haiku = 0;
    for (const [model, count] of Object.entries(byModel)) {
      const m = model.toLowerCase();
      if (m.includes('opus')) opus += count;
      else if (m.includes('sonnet')) sonnet += count;
      else if (m.includes('haiku')) haiku += count;
    }
    opusTokens.push(opus);
    sonnetTokens.push(sonnet);
    haikuTokens.push(haiku);
  }

  // Daily cost — real per-model pricing via cost-calculator (no approximation formula)
  const costTimeline = recentTokens.map(entry =>
    Math.round(CostCalculator.calcDayCostFromEntry(entry) * 100) / 100
  );

  // dailyCosts mirrors costTimeline but aligned to activity dates.
  // We need to match activity dates to token dates since they may differ in length.
  const tokenDateMap = {};
  for (const entry of recentTokens) {
    if (entry.date) tokenDateMap[entry.date] = CostCalculator.calcDayCostFromEntry(entry);
  }
  const dailyCosts = recentActivity.map(d => {
    const cost = tokenDateMap[d.date] || 0;
    return Math.round(cost * 100) / 100;
  });

  // Cumulative tokens (actual from token data, not approximation)
  let running = 0;
  const tokenDateMapForActivity = {};
  for (const entry of recentTokens) {
    if (!entry.date) continue;
    let dayTotal = 0;
    for (const count of Object.values(entry.tokensByModel || {})) dayTotal += count;
    tokenDateMapForActivity[entry.date] = dayTotal;
  }
  const cumulativeTokens = recentActivity.map(d => {
    running += tokenDateMapForActivity[d.date] || 0;
    return running;
  });

  // Hour heatmap
  const hourCounts = statsData.hourCounts || {};
  const hourData = [];
  let maxHourCount = 0;
  for (let i = 0; i < 24; i++) {
    const count = parseInt(hourCounts[String(i)] || '0', 10);
    hourData.push({ hour: i, count });
    if (count > maxHourCount) maxHourCount = count;
  }

  // Peak hour
  const peakHour = hourData.reduce((max, h) => h.count > max.count ? h : max, { hour: 0, count: 0 });

  // Recent activity (last 7 days, most recent first)
  const recentDays = recentActivity.slice(-7).reverse();

  return {
    dates,
    messages,
    sessions,
    tools,
    opusTokens,
    sonnetTokens,
    haikuTokens,
    dailyCosts,
    cumulativeTokens,
    costTimeline,
    hourData,
    maxHourCount,
    peakHour,
    recentDays,
  };
}

module.exports = { prepare };
