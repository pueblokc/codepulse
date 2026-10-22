'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Config = require('../lib/config');
const { isSafeExternalUrl, isPathInside, isTrustedRendererUrl } = require('../lib/security');
const { csvField, sessionsToCsv } = require('../lib/export');

test('sanitizeConfig clamps numbers, drops NaN and unknown keys', () => {
  const c = Config.sanitizeConfig({
    refreshIntervalMs: NaN, historyDays: 9999, activeThresholdMinutes: '15',
    budgetThreshold: -5, monthlySubscriptionCost: '', evil: '<script>', lastBudgetAlertDate: 'x',
  });
  assert.equal(c.refreshIntervalMs, 30000);
  assert.equal(c.historyDays, 365);
  assert.equal(c.activeThresholdMinutes, 15);
  assert.equal(c.budgetThreshold, 0);
  assert.equal(c.monthlySubscriptionCost, 200);
  assert.equal(c.lastBudgetAlertDate, null);
  assert.equal('evil' in c, false);
  assert.deepEqual(Config.sanitizeConfig(null), { ...Config.DEFAULTS });
  assert.equal(Config.sanitizeConfig({ refreshIntervalMs: 1 }).refreshIntervalMs, 5000);
});

test('loadConfig falls back to the legacy file and survives corrupt JSON', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codepulse-cfg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'new', 'dashboard-config.json');
  const legacy = path.join(dir, 'legacy.json');
  fs.writeFileSync(legacy, JSON.stringify({ historyDays: 60 }));
  assert.equal(Config.loadConfig(file, legacy).historyDays, 60);
  assert.equal(Config.saveConfig(file, { historyDays: 90, lastBudgetAlertDate: '2026-10-22' }), true);
  assert.equal(Config.loadConfig(file, legacy).historyDays, 90);
  assert.equal(Config.loadConfig(file, legacy).lastBudgetAlertDate, '2026-10-22');
  fs.writeFileSync(file, '{oops');
  assert.equal(Config.loadConfig(file).historyDays, 30);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter(f => f.endsWith('.tmp')), []);
});

test('isSafeExternalUrl only allows http(s) web links', () => {
  assert.equal(isSafeExternalUrl('https://kccsonline.com'), true);
  assert.equal(isSafeExternalUrl('http://example.com/x?y=1'), true);
  for (const bad of ['file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'smb://host/share',
    'ms-msdt:/id', 'https://user:pw@example.com', 'not a url', 42, null]) {
    assert.equal(isSafeExternalUrl(bad), false, String(bad));
  }
});

test('isPathInside blocks traversal and NUL bytes', () => {
  const root = path.join(os.tmpdir(), 'claude');
  assert.equal(isPathInside(root, path.join(root, 'projects', 'a.jsonl')), true);
  assert.equal(isPathInside(root, path.join(root, '..', 'evil.exe')), false);
  assert.equal(isPathInside(root, path.join(root + '-other', 'x')), false);
  assert.equal(isPathInside(root, path.join(root, 'a\0.exe')), false);
  assert.equal(isPathInside(root, ''), false);
});

test('isTrustedRendererUrl accepts only the bundled index.html', () => {
  const index = path.join(os.tmpdir(), 'app', 'renderer', 'index.html');
  const { pathToFileURL } = require('url');
  assert.equal(isTrustedRendererUrl(pathToFileURL(index).href, index), true);
  assert.equal(isTrustedRendererUrl(pathToFileURL(index).href + '#x', index), true);
  assert.equal(isTrustedRendererUrl('https://kccsonline.com/', index), false);
  assert.equal(isTrustedRendererUrl(undefined, index), false);
});

test('CSV export quotes fields and neutralises spreadsheet formulas', () => {
  assert.equal(csvField('=HYPERLINK("http://x")'), `"'=HYPERLINK(""http://x"")"`);
  assert.equal(csvField('+1'), `"'+1"`);
  assert.equal(csvField('plain, text'), '"plain, text"');
  assert.equal(csvField(5), '5');
  const csv = sessionsToCsv([{
    session_id: 'abc', status: 'idle', messages: 2, tool_calls: 1,
    tokens: { input: 1, output: 2, cache_read: 3, cache_creation: 4 },
    duration_minutes: 5, cost_usd: 0.5, primary_model: 'claude-opus-4-6',
    description: '@SUM(A1)', cwd: 'C:\\code', modified: '2026-10-22T00:00:00.000Z',
  }]);
  const [header, row] = csv.trim().split('\r\n');
  assert.equal(header.split(',').length, row.split(',').length);
  assert.match(row, /"'@SUM\(A1\)"/);
  assert.match(row, /0\.5000/);
});
