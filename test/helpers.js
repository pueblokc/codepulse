'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

/** Create a throwaway ~/.claude-like dir. Returns { root, projects, write(rel, lines) }. */
function makeClaudeDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codepulse-test-'));
  const projects = path.join(root, 'projects');
  fs.mkdirSync(projects, { recursive: true });
  return {
    root,
    projects,
    write(rel, entries, mtime) {
      const file = path.join(projects, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, entries.map(e => typeof e === 'string' ? e : JSON.stringify(e)).join('\n') + '\n');
      if (mtime) fs.utimesSync(file, mtime / 1000, mtime / 1000);
      return file;
    },
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

/** One assistant JSONL line (Claude Code writes one per content block). */
function assistant({ id, requestId = 'req_' + id, model = 'claude-opus-4-6', ts, usage = {}, content = [{ type: 'text', text: 'ok' }], cwd }) {
  return {
    type: 'assistant',
    requestId,
    timestamp: ts,
    cwd,
    message: {
      id, model, role: 'assistant', content,
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...usage },
    },
  };
}

function user(text, ts, extra = {}) {
  return { type: 'user', timestamp: ts, message: { role: 'user', content: text }, ...extra };
}

module.exports = { makeClaudeDir, assistant, user };
