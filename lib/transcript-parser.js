/**
 * Transcript Parser — reads Claude Code session transcripts (JSONL).
 *
 * Layout under ~/.claude/projects/ (current Claude Code):
 *   <encoded-cwd>/<sessionId>.jsonl                     main transcript
 *   <encoded-cwd>/<sessionId>/subagents/agent-*.jsonl   Task/sub-agent sidechains
 * Older layout also supported:
 *   <encoded-cwd>/sessions/<sessionId>.jsonl
 *
 * Entry shapes handled:
 *   { type: 'user', message: { role, content: string | block[] }, isMeta?, timestamp, cwd }
 *   { type: 'assistant', requestId, message: { id, model, content: block[], usage }, timestamp }
 *   { type: 'summary', summary }   and other types (system, file-history-snapshot, ...) are skipped.
 *
 * Claude Code writes one JSONL line per content block of an assistant message,
 * each repeating the same message.id and usage. Usage is therefore de-duplicated
 * by message.id + requestId (taking the max of each counter, since output_tokens
 * can grow while streaming). Resumed sessions copy earlier history into the new
 * file, so daily/global totals de-duplicate across files as well.
 */

const fs = require('fs');
const path = require('path');
const Pricing = require('./pricing');
const { localDateKey } = require('./dates');

const USAGE_FIELDS = ['input', 'output', 'cache_read', 'cache_write_5m', 'cache_write_1h'];

function emptyUsage() {
  return { input: 0, output: 0, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0 };
}

function addUsage(target, u) {
  for (const f of USAGE_FIELDS) target[f] += u[f] || 0;
  return target;
}

function num(v) { return typeof v === 'number' && isFinite(v) && v > 0 ? v : 0; }

/** Normalise an API usage object into our bucket shape. */
function normaliseUsage(u) {
  const out = emptyUsage();
  if (!u || typeof u !== 'object') return out;
  out.input = num(u.input_tokens);
  out.output = num(u.output_tokens);
  out.cache_read = num(u.cache_read_input_tokens);
  const totalWrite = num(u.cache_creation_input_tokens);
  const cc = u.cache_creation && typeof u.cache_creation === 'object' ? u.cache_creation : null;
  const w1h = cc ? num(cc.ephemeral_1h_input_tokens) : 0;
  const w5m = cc ? num(cc.ephemeral_5m_input_tokens) : 0;
  out.cache_write_1h = w1h;
  // Anything not attributed to the 1h bucket is billed at the 5m rate.
  out.cache_write_5m = Math.max(totalWrite - w1h, w5m);
  return out;
}

function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(b => b && b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join(' ');
}

function isToolResultOnly(content) {
  return Array.isArray(content) && content.length > 0 && content.every(b => b && b.type === 'tool_result');
}

/** Text Claude Code injects as a "user" turn that isn't something the user typed. */
function isSyntheticPrompt(text) {
  const t = text.trimStart();
  return t.startsWith('<command-') || t.startsWith('<local-command') || t.startsWith('Caveat:')
    || t.startsWith('<system-reminder>') || t.startsWith('[Request interrupted');
}

/**
 * Parse a transcript's text. Pure (no fs) so it can be unit-tested.
 * Returns { meta, usage: Map<key, { model, ts, ...usageFields }> }.
 */
function parseTranscriptContent(content) {
  const meta = {
    description: '',
    title: '',
    user_messages: 0,
    assistant_messages: 0,
    tool_calls: 0,
    models: new Set(),
    cwd: '',
    git_branch: '',
    firstTs: null,
    lastTs: null,
    parse_errors: 0,
  };
  const usage = new Map();
  const assistantIds = new Set();
  const toolUseIds = new Set();

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { meta.parse_errors++; continue; }
    if (!entry || typeof entry !== 'object') continue;

    const type = entry.type || '';
    const msg = entry.message && typeof entry.message === 'object' ? entry.message : null;

    let ts = null;
    if (entry.timestamp) {
      const t = Date.parse(entry.timestamp);
      if (!isNaN(t)) {
        ts = t;
        if (meta.firstTs === null || t < meta.firstTs) meta.firstTs = t;
        if (meta.lastTs === null || t > meta.lastTs) meta.lastTs = t;
      }
    }

    if (!meta.cwd && typeof entry.cwd === 'string') meta.cwd = entry.cwd;
    if (!meta.git_branch && typeof entry.gitBranch === 'string') meta.git_branch = entry.gitBranch;

    if (type === 'summary') {
      if (typeof entry.summary === 'string' && !meta.title) meta.title = entry.summary.substring(0, 200);
      continue;
    }

    if (type === 'user' || type === 'human') {
      if (entry.isMeta) continue;
      const c = msg ? msg.content : (typeof entry.message === 'string' ? entry.message : null);
      if (c == null || isToolResultOnly(c)) continue;
      const text = textOfContent(c).trim();
      if (!text) continue;
      if (isSyntheticPrompt(text)) continue;
      meta.user_messages++;
      if (!meta.description) meta.description = text.substring(0, 200);
      continue;
    }

    if (type !== 'assistant' || !msg) continue;

    const model = typeof msg.model === 'string' ? msg.model : '';
    const msgKey = msg.id || entry.uuid || `line-${i}`;
    if (!assistantIds.has(msgKey)) {
      assistantIds.add(msgKey);
      meta.assistant_messages++;
    }
    if (Pricing.isBillableModel(model)) meta.models.add(model);

    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block && block.type === 'tool_use') {
          const id = block.id || `${msgKey}-${toolUseIds.size}`;
          if (!toolUseIds.has(id)) { toolUseIds.add(id); meta.tool_calls++; }
        }
      }
    }

    if (msg.usage && Pricing.isBillableModel(model)) {
      const key = msg.id ? `${msg.id}:${entry.requestId || ''}` : (entry.uuid || `line-${i}`);
      const u = normaliseUsage(msg.usage);
      const prev = usage.get(key);
      if (prev) {
        for (const f of USAGE_FIELDS) prev[f] = Math.max(prev[f], u[f]);
        if (prev.ts === null && ts !== null) prev.ts = ts;
      } else {
        usage.set(key, { model, ts, ...u });
      }
    }
  }

  return { meta, usage };
}

// ------------------------------------------------------------
// Filesystem discovery + caching
// ------------------------------------------------------------

function listJsonl(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(f => f.isFile() && f.name.endsWith('.jsonl'))
      .map(f => path.join(dir, f.name));
  } catch { return []; }
}

/**
 * Find transcript files. Returns [{ sessionId, main: path|null, subagents: [path] }].
 */
function discoverSessions(projectsDir) {
  const bySession = new Map();
  const get = (id) => {
    if (!bySession.has(id)) bySession.set(id, { sessionId: id, project: null, main: null, subagents: [] });
    return bySession.get(id);
  };

  let projectDirs = [];
  try {
    projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true }).filter(d => d.isDirectory());
  } catch { return []; }

  for (const pDir of projectDirs) {
    const pPath = path.join(projectsDir, pDir.name);
    const mains = [...listJsonl(pPath), ...listJsonl(path.join(pPath, 'sessions'))];
    for (const f of mains) {
      const s = get(path.basename(f, '.jsonl'));
      s.project = pDir.name;
      // Prefer the current layout if a session exists in both places.
      if (!s.main || path.dirname(f) === pPath) s.main = f;
    }

    let subdirs = [];
    try { subdirs = fs.readdirSync(pPath, { withFileTypes: true }).filter(d => d.isDirectory() && d.name !== 'sessions'); } catch { /* ignore */ }
    for (const sd of subdirs) {
      const agents = listJsonl(path.join(pPath, sd.name, 'subagents'));
      if (agents.length) {
        const s = get(sd.name);
        if (!s.project) s.project = pDir.name;
        s.subagents.push(...agents);
      }
    }
  }
  return Array.from(bySession.values());
}

class TranscriptStore {
  constructor() {
    this.cache = new Map(); // path -> { mtimeMs, size, parsed }
  }

  /** Parse a file, reusing the cached result when mtime+size are unchanged. */
  parseFile(filePath) {
    let stat;
    try { stat = fs.statSync(filePath); } catch { return null; }
    const hit = this.cache.get(filePath);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
      hit.seen = true;
      return hit;
    }
    let parsed;
    try {
      parsed = parseTranscriptContent(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return null;
    }
    const entry = { mtimeMs: stat.mtimeMs, birthtimeMs: stat.birthtimeMs, size: stat.size, parsed, seen: true };
    this.cache.set(filePath, entry);
    return entry;
  }

  /**
   * Read every session under projectsDir.
   * Returns { sessions, daily } where daily = { 'YYYY-MM-DD': { model: usage } }
   * (de-duplicated across all files).
   */
  readAll(projectsDir, opts = {}) {
    const now = opts.now != null ? opts.now : Date.now();
    const activeMin = opts.activeThresholdMinutes > 0 ? opts.activeThresholdMinutes : 10;

    for (const v of this.cache.values()) v.seen = false;

    const sessions = [];
    const globalSeen = new Set();
    const daily = {};

    for (const d of discoverSessions(projectsDir)) {
      const main = d.main ? this.parseFile(d.main) : null;
      const subs = d.subagents.map(p => this.parseFile(p)).filter(Boolean);
      if (!main && subs.length === 0) continue;

      const sessionUsage = new Map();
      const files = main ? [main, ...subs] : subs;
      for (const f of files) {
        for (const [k, rec] of f.parsed.usage) {
          if (!sessionUsage.has(k)) sessionUsage.set(k, rec);
          if (!globalSeen.has(k)) {
            globalSeen.add(k);
            if (rec.ts !== null) {
              const day = localDateKey(new Date(rec.ts));
              const byModel = daily[day] || (daily[day] = {});
              addUsage(byModel[rec.model] || (byModel[rec.model] = emptyUsage()), rec);
            }
          }
        }
      }

      sessions.push(buildSession(d, main, subs, sessionUsage, now, activeMin));
    }

    for (const [k, v] of this.cache) if (!v.seen) this.cache.delete(k);

    sessions.sort((a, b) => b.modifiedMs - a.modifiedMs);
    return { sessions, daily };
  }
}

function buildSession(d, main, subs, sessionUsage, now, activeMin) {
  const files = main ? [main, ...subs] : subs;
  const meta = main ? main.parsed.meta : subs[0].parsed.meta;

  const byModel = {};
  for (const rec of sessionUsage.values()) {
    addUsage(byModel[rec.model] || (byModel[rec.model] = emptyUsage()), rec);
  }
  const total = emptyUsage();
  let cost = 0;
  for (const [model, u] of Object.entries(byModel)) {
    addUsage(total, u);
    cost += Pricing.costForUsage(model, u).total;
  }

  const models = new Set();
  let toolCalls = 0;
  let firstTs = null;
  let lastTs = null;
  for (const f of files) {
    const m = f.parsed.meta;
    m.models.forEach(x => models.add(x));
    toolCalls += m.tool_calls;
    if (m.firstTs !== null && (firstTs === null || m.firstTs < firstTs)) firstTs = m.firstTs;
    if (m.lastTs !== null && (lastTs === null || m.lastTs > lastTs)) lastTs = m.lastTs;
  }

  const modifiedMs = Math.max(...files.map(f => f.mtimeMs));
  const createdMs = firstTs !== null ? firstTs : Math.min(...files.map(f => f.birthtimeMs || f.mtimeMs));
  const ageMinutes = (now - modifiedMs) / 60000;
  let status = 'stale';
  if (ageMinutes < activeMin) status = 'active';
  else if (ageMinutes < 60) status = 'recent';
  else if (ageMinutes < 1440) status = 'idle';

  const modelsUsed = Array.from(models);
  const primary = primaryModel(byModel, modelsUsed);
  const mainMeta = main ? main.parsed.meta : meta;

  return {
    session_id: d.sessionId,
    project: d.project || '',
    path: d.main || d.subagents[0],
    subagent_files: subs.length,
    size_bytes: files.reduce((a, f) => a + f.size, 0),
    modifiedMs,
    modified: new Date(modifiedMs).toISOString(),
    created: new Date(createdMs).toISOString(),
    title: mainMeta.title,
    description: mainMeta.description,
    messages: mainMeta.user_messages + mainMeta.assistant_messages,
    user_messages: mainMeta.user_messages,
    assistant_messages: mainMeta.assistant_messages,
    tool_calls: toolCalls,
    models_used: modelsUsed,
    models_display: modelsUsed.map(m => ({ model: m, label: Pricing.getModelLabel(m), color: Pricing.getModelColor(m) })),
    primary_model: primary,
    primary_model_label: primary ? Pricing.getModelLabel(primary) : '-',
    primary_model_color: primary ? Pricing.getModelColor(primary) : '#6c7086',
    tokens: {
      input: total.input,
      output: total.output,
      cache_read: total.cache_read,
      cache_creation: total.cache_write_5m + total.cache_write_1h,
    },
    tokens_by_model: byModel,
    cost_usd: cost,
    cwd: mainMeta.cwd || meta.cwd,
    git_branch: mainMeta.git_branch || '',
    duration_minutes: firstTs !== null && lastTs !== null ? Math.round((lastTs - firstTs) / 60000) : 0,
    status,
  };
}

/** Model that produced the most output tokens (falls back to first seen). */
function primaryModel(byModel, modelsUsed) {
  let best = null;
  let bestOut = -1;
  for (const [m, u] of Object.entries(byModel)) {
    if (u.output > bestOut) { best = m; bestOut = u.output; }
  }
  return best || modelsUsed[0] || null;
}

module.exports = {
  parseTranscriptContent,
  normaliseUsage,
  discoverSessions,
  TranscriptStore,
  emptyUsage,
  addUsage,
};
