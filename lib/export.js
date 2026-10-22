/**
 * Session export (CSV / JSON).
 */

const { estimateSessionCost } = require('./cost-calculator');

const CSV_HEADERS = [
  'Session ID', 'Status', 'Messages', 'Tool Calls', 'Input Tokens', 'Output Tokens',
  'Cache Read', 'Cache Write', 'Duration (min)', 'Cost Est ($)', 'Model', 'Description', 'CWD', 'Modified',
];

/**
 * Quote a CSV field. Text beginning with = + - @ (or tab/CR) is prefixed with
 * a single quote so spreadsheet apps don't execute it as a formula — session
 * descriptions are arbitrary prompt text.
 */
function csvField(value) {
  if (typeof value === 'number') return String(value);
  let s = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

function sessionsToCsv(sessions) {
  const rows = sessions.map(s => [
    csvField(s.session_id), csvField(s.status), s.messages || 0, s.tool_calls || 0,
    s.tokens.input, s.tokens.output, s.tokens.cache_read, s.tokens.cache_creation,
    s.duration_minutes || 0, estimateSessionCost(s).toFixed(4),
    csvField(s.primary_model || ''), csvField(s.title || s.description || ''),
    csvField(s.cwd || ''), csvField(s.modified),
  ].join(','));
  return CSV_HEADERS.join(',') + '\r\n' + rows.join('\r\n') + (rows.length ? '\r\n' : '');
}

function sessionsToJson(sessions) {
  return JSON.stringify(sessions, null, 2);
}

module.exports = { csvField, sessionsToCsv, sessionsToJson, CSV_HEADERS };
