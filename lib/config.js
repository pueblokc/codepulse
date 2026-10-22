/**
 * Dashboard config: defaults, validation, and load/save helpers.
 *
 * Config arrives from the renderer over IPC, so every field is re-validated
 * here: unknown keys are dropped and numbers are clamped (a NaN refresh
 * interval used to reach setInterval and spin the refresh loop).
 */

const fs = require('fs');
const path = require('path');

const DEFAULTS = Object.freeze({
  refreshIntervalMs: 30000,
  budgetThreshold: 100,
  dailyBudgetWarn: 10,
  historyDays: 30,
  activeThresholdMinutes: 10,
  weeklyAllModelsLimit: 3200000,
  weeklySonnetLimit: 15000000,
  monthlySubscriptionCost: 200,
  lastBudgetAlertDate: null,
});

// [min, max, integer?]
const NUMERIC = {
  refreshIntervalMs: [5000, 300000, true],
  budgetThreshold: [0, 1e7, false],
  dailyBudgetWarn: [0, 1e6, false],
  historyDays: [7, 365, true],
  activeThresholdMinutes: [1, 60, true],
  weeklyAllModelsLimit: [0, 1e13, true],
  weeklySonnetLimit: [0, 1e13, true],
  monthlySubscriptionCost: [0, 1e6, false],
};

function sanitizeConfig(input) {
  const src = input && typeof input === 'object' ? input : {};
  const out = { ...DEFAULTS };
  for (const [key, [min, max, int]] of Object.entries(NUMERIC)) {
    let v = Number(src[key]);
    if (src[key] === null || src[key] === '' || !isFinite(v)) continue;
    if (int) v = Math.round(v);
    out[key] = Math.min(max, Math.max(min, v));
  }
  if (typeof src.lastBudgetAlertDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(src.lastBudgetAlertDate)) {
    out.lastBudgetAlertDate = src.lastBudgetAlertDate;
  }
  return out;
}

function readJson(file) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { /* ignore corrupt file */ }
  return null;
}

/**
 * Load config from `file`, falling back to `legacyFile` (the old location next
 * to main.js, which is read-only inside a packaged asar).
 */
function loadConfig(file, legacyFile) {
  const raw = readJson(file) || (legacyFile ? readJson(legacyFile) : null);
  return sanitizeConfig(raw || {});
}

/** Atomic write: temp file + rename, so a crash can't leave half a JSON file. */
function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function saveConfig(file, config) {
  try {
    writeJsonAtomic(file, sanitizeConfig(config));
    return true;
  } catch (e) {
    console.error('Failed to save config:', e.message);
    return false;
  }
}

module.exports = { DEFAULTS, sanitizeConfig, loadConfig, saveConfig, writeJsonAtomic, readJson };
