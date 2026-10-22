'use strict';
// Mountain time (UTC-6/-7): evening local == next day in UTC, which is
// exactly where the old toISOString() date keys went wrong.
process.env.TZ = 'America/Denver';
const test = require('node:test');
const assert = require('node:assert/strict');
const { localDateKey, addDaysKey, lastNDays, daysInMonth } = require('../lib/dates');
const Cost = require('../lib/cost-calculator');
const ChartData = require('../lib/chart-data');

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg || ''} expected ${b}, got ${a}`);
const day = (input) => ({ 'claude-sonnet-4-6': { input, output: 0, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0 } });

test('localDateKey uses the local calendar day, not UTC', () => {
  // 2026-10-22 20:30 in Denver is 2026-10-23 02:30 UTC.
  const evening = new Date(Date.UTC(2026, 9, 23, 2, 30));
  assert.equal(evening.toISOString().slice(0, 10), '2026-10-23');
  assert.equal(localDateKey(evening), '2026-10-22');
  assert.equal(localDateKey('garbage'), null);
});

test('addDaysKey / lastNDays / daysInMonth across DST and month ends', () => {
  const nov2 = new Date(2026, 10, 2, 12); // day after US DST ends
  assert.equal(addDaysKey(nov2, -1), '2026-11-01');
  assert.equal(addDaysKey(nov2, -2), '2026-10-31');
  assert.deepEqual(lastNDays(3, nov2), ['2026-10-31', '2026-11-01', '2026-11-02']);
  assert.equal(daysInMonth(new Date(2028, 1, 10)), 29);
});

test('today/week/month come from transcripts with correct windows', () => {
  const now = new Date(2026, 9, 22, 20, 30); // Oct 22, 8:30pm local
  const daily = {
    '2026-10-22': day(1e6), // $3 today
    '2026-10-16': day(1e6), // 6 days ago -> in week
    '2026-10-15': day(1e6), // 7 days ago -> NOT in a 7-day week (old code counted 8 days)
    '2026-10-01': day(1e6), // in month
    '2026-09-30': day(1e6), // previous month
  };
  const c = Cost.calculateAll({}, {}, { daily, now });
  near(c.todayCost, 3, 'today');
  near(c.weekCost, 6, 'week');
  near(c.monthCost, 12, 'month');
  near(c.last30Cost, 15, 'last30');
  // $12 over 22 days, projected over 31 days.
  near(c.projectedMonthly, 12 / 22 * 31, 'projection');
  assert.equal(c.totalsSource, 'transcripts');
  near(c.totalCost, 15, 'total from transcripts when stats-cache is empty');
});

test('projection early in the month is not inflated by last month', () => {
  const now = new Date(2026, 10, 1, 9); // Nov 1
  const daily = {};
  for (let i = 1; i <= 30; i++) daily[`2026-10-${String(i).padStart(2, '0')}`] = day(1e6);
  daily['2026-11-01'] = day(1e6);
  const c = Cost.calculateAll({}, {}, { daily, now });
  // Old formula: last-30-days ($90) / 1 * 30 = $2700.
  near(c.projectedMonthly, 3 * 30, 'projection');
});

test('stats-cache fills days transcripts no longer cover; transcripts win where both exist', () => {
  const now = new Date(2026, 9, 22, 12);
  const stats = {
    dailyModelTokens: [
      { date: '2026-10-20', tokensByModel: { 'claude-sonnet-4-6': 1e6 } }, // blended (3+15)/2 = $9
      { date: '2026-10-22', tokensByModel: { 'claude-sonnet-4-6': 5e6 } },
    ],
    modelUsage: {
      'claude-opus-4-6': { inputTokens: 1e6, outputTokens: 1e6, cacheReadInputTokens: 1e6, cacheCreationInputTokens: 0 },
      '<synthetic>': { inputTokens: 5, outputTokens: 5 },
    },
  };
  const c = Cost.calculateAll(stats, { monthlySubscriptionCost: 100 }, { daily: { '2026-10-22': day(1e6) }, now });
  near(c.todayCost, 3, 'today from transcripts');
  near(c.weekCost, 12, 'week = 3 + 9');
  near(c.totalCost, 5 + 25 + 0.5, 'opus 4.6 all-time');
  near(c.cacheSavings, 4.5, 'cache savings');
  near(c.cacheRate, 50, 'cache rate');
  assert.equal(c.modelDistribution.length, 1);
  assert.equal(c.modelDistribution[0].name, 'Opus 4.6');
  assert.equal(c.monthlySubscriptionCost, 100);
});

test('estimateSessionCost prefers the parser cost and falls back to tokens', () => {
  assert.equal(Cost.estimateSessionCost({ cost_usd: 1.23, tokens: {} }), 1.23);
  near(Cost.estimateSessionCost({ tokens: { input: 1e6, output: 0 }, models_used: ['claude-haiku-4-5'] }), 1);
  assert.equal(Cost.estimateSessionCost(null), 0);
});

test('chart series are aligned to a continuous day range', () => {
  const now = new Date(2026, 9, 22, 12);
  const stats = {
    dailyActivity: [
      { date: '2026-10-18', messageCount: 4, sessionCount: 1, toolCallCount: 2 },
      { date: '2026-10-21', messageCount: 9, sessionCount: 2, toolCallCount: 3 },
    ],
    dailyModelTokens: [{ date: '2026-10-18', tokensByModel: { 'claude-opus-4-6': 100 } }],
    hourCounts: { 9: 3, 14: 7 },
  };
  const daily = { '2026-10-22': { 'claude-fable-5-1': { input: 10, output: 5, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0 } } };
  const ch = ChartData.prepare(stats, 7, { daily, now });
  assert.deepEqual(ch.dateKeys, ['2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22']);
  assert.deepEqual(ch.dates[0], '10-16');
  assert.deepEqual(ch.messages, [0, 0, 4, 0, 0, 9, 0]);
  assert.deepEqual(ch.opusTokens, [0, 0, 100, 0, 0, 0, 0]);
  assert.deepEqual(ch.fableTokens, [0, 0, 0, 0, 0, 0, 15]);
  assert.equal(ch.dailyCosts.length, 7);
  assert.equal(ch.costTimeline.length, ch.dates.length);
  assert.deepEqual(ch.cumulativeTokens, [0, 0, 100, 100, 100, 100, 115]);
  assert.deepEqual(ch.peakHour, { hour: 14, count: 7 });
  assert.deepEqual(ch.recentDays.map(d => d.date), ['2026-10-21', '2026-10-18']);
});

test('chart-data tolerates empty input and bad historyDays', () => {
  const ch = ChartData.prepare({}, 'abc', { now: new Date(2026, 0, 5) });
  assert.equal(ch.dates.length, 30);
  assert.equal(ch.maxHourCount, 0);
});
