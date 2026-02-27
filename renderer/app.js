/* ============================================================
   CodePulse — Renderer
   ============================================================ */

// ---- State ----
let appData = null;
let allSessions = [];
let filteredSessions = [];
let chartInstances = {};
let currentPage = 1;
const PAGE_SIZE = 50;

// ---- Formatting Helpers ----
function formatTokens(count) {
  if (!count) return '0';
  if (count < 1000) return String(count);
  if (count < 1e6) return (count / 1000).toFixed(1) + 'K';
  if (count < 1e9) return (count / 1e6).toFixed(1) + 'M';
  return (count / 1e9).toFixed(2) + 'B';
}

function formatCost(amount) {
  if (!amount || amount === 0) return '$0.00';
  if (amount < 0.01) return '$' + amount.toFixed(4);
  if (amount < 1000) return '$' + amount.toFixed(2);
  return '$' + amount.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function formatAge(isoStr) {
  if (!isoStr) return 'N/A';
  const ms = Date.now() - new Date(isoStr).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return min + 'm ago';
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return hrs + 'h ago';
  return Math.floor(hrs / 24) + 'd ago';
}

function formatSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes || 0;
  for (const u of units) {
    if (size < 1024) return size.toFixed(1) + u;
    size /= 1024;
  }
  return size.toFixed(1) + 'TB';
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

// ---- Tab Management ----
function showTab(tabId) {
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  const el = document.getElementById('tab-' + tabId);
  if (el) el.classList.add('active');
  const btn = document.querySelector(`[data-tab="${tabId}"]`);
  if (btn) btn.classList.add('active');

  if ((tabId === 'overview' || tabId === 'costs') && appData) {
    requestAnimationFrame(() => renderCharts());
  }

  localStorage.setItem('activeTab', tabId);
}

// Restore last active tab
const savedTab = localStorage.getItem('activeTab');
if (savedTab) showTab(savedTab);

// ---- Chart.js Global Config ----
const CHART_COLORS = {
  grid: '#313244',
  tick: '#6c7086',
  yellow: '#f9e2af',
  blue: '#89b4fa',
  green: '#a6e3a1',
  red: '#f38ba8',
  mauve: '#cba6f7',
  peach: '#fab387',
  teal: '#94e2d5',
};

function chartDefaults() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { labels: { color: CHART_COLORS.tick, font: { size: 11 } } },
    },
    scales: {
      x: { grid: { color: CHART_COLORS.grid }, ticks: { color: CHART_COLORS.tick, font: { size: 10 } } },
      y: { grid: { color: CHART_COLORS.grid }, ticks: { color: CHART_COLORS.tick, font: { size: 10 } } },
    },
  };
}

function makeChart(canvasId, config) {
  if (chartInstances[canvasId]) {
    chartInstances[canvasId].destroy();
    delete chartInstances[canvasId];
  }
  const ctx = document.getElementById(canvasId);
  if (!ctx) return null;
  chartInstances[canvasId] = new Chart(ctx, config);
  return chartInstances[canvasId];
}

// ---- Data Update Handler ----
dashboard.onDataUpdate((data) => {
  appData = data;
  allSessions = data.sessions || [];
  renderOverview();
  renderSessions();
  renderCosts();
  renderSettings();
  renderCharts();
  updateStatusBar();
});

// Initial load
dashboard.getAllData();

// ---- Render: Overview Tab ----
function renderOverview() {
  if (!appData) return;
  const { costs, sessions } = appData;
  if (!costs) return;

  setText('stat-today-cost', formatCost(costs.todayCost));
  setText('stat-week-cost', formatCost(costs.weekCost));
  setText('stat-month-cost', formatCost(costs.monthCost));

  const activeSessions = (sessions || []).filter(s => s.status === 'active').length;
  setText('stat-active-sessions', String(activeSessions));

  setText('stat-total-tokens', formatTokens(costs.totalTokens));
  setText('stat-token-breakdown', `${formatTokens(costs.totalInput)} in / ${formatTokens(costs.totalOutput)} out`);

  setText('stat-cache-rate', costs.cacheRate.toFixed(1) + '%');
  setText('stat-cache-saved', `Saved: ${formatCost(costs.cacheSavings)}`);

  setText('cost-badge', `${formatCost(costs.todayCost)} today`);

  // Recent Activity
  const charts = appData.charts || {};
  const recentDays = charts.recentDays || [];
  const container = document.getElementById('recent-activity-list');
  if (container) {
    container.innerHTML = recentDays.map(d => `
      <div class="activity-row">
        <span class="activity-date">${d.date || ''}</span>
        <span class="activity-stats">${d.messageCount || 0} msgs &middot; ${d.sessionCount || 0} sess &middot; ${d.toolCallCount || 0} tools</span>
      </div>
    `).join('') || '<div class="stat-sub">No recent activity</div>';
  }

  // Hour Heatmap
  const hourData = charts.hourData || [];
  const maxHour = charts.maxHourCount || 1;
  const heatmap = document.getElementById('hour-heatmap');
  if (heatmap) {
    heatmap.innerHTML = hourData.map(h => {
      const intensity = h.count / maxHour;
      return `<div class="hour-cell" style="background:rgba(249,226,175,${intensity})" title="${h.hour}:00 - ${h.count} sessions">${h.hour}</div>`;
    }).join('');
  }

  const peakHour = charts.peakHour || { hour: 0, count: 0 };
  setText('peak-hour-label', `Peak: ${peakHour.hour}:00 (${peakHour.count} sessions)`);
}

// ---- Render: Sessions Tab with Pagination ----
function renderSessions() {
  currentPage = 1;
  applyFiltersAndSort();
}

function applyFiltersAndSort() {
  const search = (document.getElementById('session-search')?.value || '').toLowerCase();
  const statusFilter = document.getElementById('status-filter')?.value || 'all';
  const modelFilter = document.getElementById('model-filter')?.value || 'all';
  const sortBy = document.getElementById('sort-by')?.value || 'modified';

  filteredSessions = allSessions.filter(s => {
    if (statusFilter !== 'all' && s.status !== statusFilter) return false;
    if (modelFilter !== 'all') {
      const hasModel = (s.models_used || []).some(m => m.toLowerCase().includes(modelFilter));
      if (!hasModel) return false;
    }
    if (search) {
      const text = `${s.description} ${s.session_id} ${s.cwd}`.toLowerCase();
      if (!text.includes(search)) return false;
    }
    return true;
  });

  filteredSessions.sort((a, b) => {
    switch (sortBy) {
      case 'tokens': return ((b.tokens?.input || 0) + (b.tokens?.output || 0)) - ((a.tokens?.input || 0) + (a.tokens?.output || 0));
      case 'cost': return estimateSessionCost(b) - estimateSessionCost(a);
      case 'messages': return (b.messages || 0) - (a.messages || 0);
      case 'duration': return (b.duration_minutes || 0) - (a.duration_minutes || 0);
      default: return (b.modifiedMs || 0) - (a.modifiedMs || 0);
    }
  });

  setText('session-count', `${filteredSessions.length} sessions`);
  renderSessionPage();
}

function renderSessionPage() {
  const totalPages = Math.max(1, Math.ceil(filteredSessions.length / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = totalPages;
  if (currentPage < 1) currentPage = 1;

  const start = (currentPage - 1) * PAGE_SIZE;
  const pageRows = filteredSessions.slice(start, start + PAGE_SIZE);

  const tbody = document.getElementById('sessions-tbody');
  if (!tbody) return;

  tbody.innerHTML = pageRows.map(s => {
    const tokens = (s.tokens?.input || 0) + (s.tokens?.output || 0);
    const cost = estimateSessionCost(s);
    const primaryModel = getPrimaryModel(s.models_used);
    return `
      <tr class="clickable" onclick="showSessionModal('${escapeHtml(s.session_id)}')">
        <td><span class="status-badge status-${s.status}">${s.status}</span></td>
        <td class="id-cell">${s.session_id.substring(0, 12)}...</td>
        <td>${s.messages || 0}</td>
        <td>${s.tool_calls || 0}</td>
        <td>${formatTokens(tokens)}</td>
        <td>${formatCost(cost)}</td>
        <td>${s.duration_minutes || 0}m</td>
        <td><span style="color:${getModelColor(primaryModel)}">${getModelShort(primaryModel)}</span></td>
        <td class="desc-cell">${escapeHtml((s.description || '').substring(0, 60))}</td>
        <td>${formatAge(s.modified)}</td>
      </tr>
    `;
  }).join('');

  // Update pagination controls
  setText('page-info', `Page ${currentPage} of ${totalPages}`);
  const prevBtn = document.getElementById('page-prev');
  const nextBtn = document.getElementById('page-next');
  if (prevBtn) prevBtn.disabled = currentPage <= 1;
  if (nextBtn) nextBtn.disabled = currentPage >= totalPages;

  const paginationBar = document.getElementById('pagination-bar');
  if (paginationBar) {
    paginationBar.style.display = totalPages > 1 ? 'flex' : 'none';
  }
}

function changePage(delta) {
  const totalPages = Math.max(1, Math.ceil(filteredSessions.length / PAGE_SIZE));
  currentPage = Math.max(1, Math.min(totalPages, currentPage + delta));
  renderSessionPage();
}

// ---- Session Cost Estimation (unified via cost-calculator logic) ----
// Uses the same pricing logic as cost-calculator.js on the main process.
// Kept in renderer for sorting/display without IPC round-trip.
const PRICING = {
  'claude-opus-4-6':             { input: 15.0, output: 75.0, cache_read: 1.5,  cache_write: 18.75 },
  'claude-opus-4-5-20251101':    { input: 15.0, output: 75.0, cache_read: 1.5,  cache_write: 18.75 },
  'claude-sonnet-4-6':           { input: 3.0,  output: 15.0, cache_read: 0.3,  cache_write: 3.75 },
  'claude-sonnet-4-5-20250929':  { input: 3.0,  output: 15.0, cache_read: 0.3,  cache_write: 3.75 },
  'claude-haiku-4-5-20251001':   { input: 1.0,  output: 5.0,  cache_read: 0.1,  cache_write: 1.25 },
  'claude-3-5-haiku-20241022':   { input: 0.80, output: 4.0,  cache_read: 0.08, cache_write: 1.0  },
};
const DEFAULT_PRICING = PRICING['claude-sonnet-4-6'];

function getPricingForModel(model) {
  if (!model) return DEFAULT_PRICING;
  if (PRICING[model]) return PRICING[model];
  const m = model.toLowerCase();
  if (m.includes('opus'))   return PRICING['claude-opus-4-6'];
  if (m.includes('sonnet')) return PRICING['claude-sonnet-4-6'];
  if (m.includes('haiku'))  return PRICING['claude-haiku-4-5-20251001'];
  return DEFAULT_PRICING;
}

function estimateSessionCost(s) {
  if (!s || !s.tokens) return 0;
  const t = s.tokens;
  const models = s.models_used || [];

  let p = DEFAULT_PRICING;
  if (models.length === 1) {
    p = getPricingForModel(models[0]);
  } else if (models.some(m => m.toLowerCase().includes('opus'))) {
    p = PRICING['claude-opus-4-6'];
  } else if (models.some(m => m.toLowerCase().includes('sonnet'))) {
    p = PRICING['claude-sonnet-4-6'];
  }

  return (t.input || 0)         / 1e6 * p.input
       + (t.output || 0)        / 1e6 * p.output
       + (t.cache_read || 0)    / 1e6 * p.cache_read
       + (t.cache_creation || 0) / 1e6 * p.cache_write;
}

function getPrimaryModel(models) {
  if (!models || models.length === 0) return '';
  const opus = models.find(m => m.includes('opus'));
  if (opus) return opus;
  const sonnet = models.find(m => m.includes('sonnet'));
  if (sonnet) return sonnet;
  return models[0];
}

function getModelShort(model) {
  if (!model) return '-';
  const m = model.toLowerCase();
  if (m.includes('opus-4-6'))    return 'Opus 4.6';
  if (m.includes('opus'))        return 'Opus';
  if (m.includes('sonnet-4-6'))  return 'Sonnet 4.6';
  if (m.includes('sonnet'))      return 'Sonnet';
  if (m.includes('haiku-4-5'))   return 'Haiku 4.5';
  if (m.includes('haiku'))       return 'Haiku';
  return model.split('-').slice(-2).join(' ');
}

function getModelColor(model) {
  if (!model) return '#6c7086';
  const m = model.toLowerCase();
  if (m.includes('opus'))   return '#cba6f7';
  if (m.includes('sonnet')) return '#89b4fa';
  if (m.includes('haiku'))  return '#a6e3a1';
  return '#a6adc8';
}

// ---- Render: Cost Analysis Tab ----
function renderCosts() {
  if (!appData || !appData.costs) return;
  const { costs, config } = appData;
  const subscriptionCost = (config && config.monthlySubscriptionCost != null)
    ? config.monthlySubscriptionCost
    : 200;

  setText('cost-total-api', formatCost(costs.totalCost));
  setText('cost-cache-savings', formatCost(costs.cacheSavings));
  setText('cost-projected', formatCost(costs.projectedMonthly));
  setText('cost-subscription', formatCost(subscriptionCost) + '/mo');

  // Model cost breakdown table
  const tbody = document.getElementById('cost-breakdown-tbody');
  if (tbody) {
    const rows = Object.entries(costs.modelCosts || {}).map(([model, c]) => {
      const name = getModelShort(model);
      return `
        <tr>
          <td><strong style="color:${getModelColor(model)}">${name}</strong></td>
          <td>${formatCost(c.input)}</td>
          <td>${formatCost(c.output)}</td>
          <td>${formatCost(c.cacheRead)}</td>
          <td>${formatCost(c.cacheWrite)}</td>
          <td><strong>${formatCost(c.total)}</strong></td>
        </tr>
      `;
    });

    if (rows.length > 0) {
      rows.push(`
        <tr style="border-top:2px solid var(--surface1);">
          <td><strong>TOTAL</strong></td>
          <td></td><td></td><td></td><td></td>
          <td><strong style="color:var(--red);">${formatCost(costs.totalCost)}</strong></td>
        </tr>
      `);
    }

    tbody.innerHTML = rows.length > 0
      ? rows.join('')
      : '<tr><td colspan="6" style="color:var(--overlay0);text-align:center;padding:20px;">No model data available yet</td></tr>';
  }

  // ROI Analysis using the configurable subscription cost
  const roi = document.getElementById('roi-content');
  if (roi) {
    const netSavings = Math.max(costs.totalCost - subscriptionCost, 0);
    const multiplier = subscriptionCost > 0
      ? (costs.totalCost / subscriptionCost).toFixed(1)
      : costs.totalCost > 0 ? '∞' : '0.0';
    roi.innerHTML = `
      <div class="roi-row"><span>API cost equivalent:</span><strong style="color:var(--red)">${formatCost(costs.totalCost)}</strong></div>
      <div class="roi-row"><span>Monthly subscription:</span><strong>${formatCost(subscriptionCost)}/mo</strong></div>
      <div class="roi-row roi-divider"><span>Net savings:</span><strong style="color:var(--green)">${formatCost(netSavings)}</strong></div>
      <div class="roi-row"><span>ROI multiplier:</span><strong style="color:var(--blue)">${multiplier}x</strong></div>
      <div class="roi-row"><span>Projected this month:</span><strong style="color:var(--mauve)">${formatCost(costs.projectedMonthly)}</strong></div>
    `;
  }

  // Budget alerts
  const alertCard = document.getElementById('budget-alert-card');
  const alertContent = document.getElementById('budget-alert-content');
  if (alertCard && alertContent) {
    const threshold = (config && config.budgetThreshold) || 100;
    if (costs.projectedMonthly > threshold) {
      alertCard.style.display = 'block';
      alertContent.innerHTML = `<p style="color:var(--red);font-size:13px;">Projected monthly spend of ${formatCost(costs.projectedMonthly)} exceeds your budget threshold of ${formatCost(threshold)}.</p>`;
    } else {
      alertCard.style.display = 'none';
    }
  }
}

// ---- Render: Charts ----
function renderCharts() {
  if (!appData || !appData.charts) return;
  const charts = appData.charts;

  // Model Distribution Pie
  const dist = (appData.costs?.modelDistribution || []);
  if (dist.length > 0) {
    makeChart('modelPieChart', {
      type: 'doughnut',
      data: {
        labels: dist.map(d => d.name),
        datasets: [{
          data: dist.map(d => d.tokens),
          backgroundColor: dist.map(d => d.color),
          borderWidth: 0,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        cutout: '55%',
        plugins: {
          legend: {
            position: 'bottom',
            labels: {
              color: CHART_COLORS.tick, font: { size: 11 },
              generateLabels: () => dist.map(d => ({
                text: `${d.name}: ${d.pct.toFixed(1)}% (${formatTokens(d.tokens)})`,
                fillStyle: d.color, strokeStyle: d.color,
              })),
            },
          },
          tooltip: {
            callbacks: {
              label: (ctx) => formatTokens(ctx.raw) + ' tokens (' + formatCost(dist[ctx.dataIndex]?.cost || 0) + ')',
            },
          },
        },
      },
    });
  }

  // Cost Timeline (overview tab) — uses real per-model cost from chart-data.js
  if (charts.costTimeline && charts.costTimeline.length > 0) {
    makeChart('costTimelineChart', {
      type: 'line',
      data: {
        labels: charts.dates,
        datasets: [{
          label: 'Daily Cost ($)',
          data: charts.costTimeline,
          borderColor: CHART_COLORS.yellow,
          backgroundColor: 'rgba(249,226,175,.08)',
          fill: true, tension: 0.3, pointRadius: 2, borderWidth: 2,
        }],
      },
      options: { ...chartDefaults(), plugins: { legend: { display: false } } },
    });
  }

  // Daily Cost Chart (costs tab) — uses unified cost data
  if (charts.dailyCosts && charts.dailyCosts.length > 0) {
    makeChart('dailyCostChart', {
      type: 'line',
      data: {
        labels: charts.dates,
        datasets: [{
          label: 'Est. Cost ($)',
          data: charts.dailyCosts,
          borderColor: CHART_COLORS.red,
          backgroundColor: 'rgba(243,139,168,.08)',
          fill: true, tension: 0.3, pointRadius: 2, borderWidth: 2,
        }],
      },
      options: { ...chartDefaults(), plugins: { legend: { display: false } } },
    });
  }

  // Tokens by Model stacked bar (costs tab)
  if (charts.opusTokens && charts.dates) {
    makeChart('tokensByModelChart', {
      type: 'bar',
      data: {
        labels: charts.dates,
        datasets: [
          { label: 'Opus',   data: charts.opusTokens,   backgroundColor: CHART_COLORS.mauve },
          { label: 'Sonnet', data: charts.sonnetTokens, backgroundColor: CHART_COLORS.blue },
          { label: 'Haiku',  data: charts.haikuTokens,  backgroundColor: CHART_COLORS.green },
        ],
      },
      options: {
        ...chartDefaults(),
        scales: {
          x: { ...chartDefaults().scales.x, stacked: true },
          y: {
            ...chartDefaults().scales.y, stacked: true,
            ticks: {
              ...chartDefaults().scales.y.ticks,
              callback: v => v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1000 ? (v / 1000).toFixed(0) + 'K' : v,
            },
          },
        },
      },
    });
  }
}

// ---- Render: Settings ----
function renderSettings() {
  if (!appData || !appData.config) return;
  const c = appData.config;

  setVal('set-refresh', Math.round((c.refreshIntervalMs || 30000) / 1000));
  setVal('set-history', c.historyDays || 30);
  setVal('set-active-thresh', c.activeThresholdMinutes || 10);
  setVal('set-subscription-cost', c.monthlySubscriptionCost != null ? c.monthlySubscriptionCost : 200);
  setVal('set-budget', c.budgetThreshold || 100);
  setVal('set-daily-warn', c.dailyBudgetWarn || 10);
  setVal('set-weekly-all', c.weeklyAllModelsLimit || 3200000);
  setVal('set-weekly-sonnet', c.weeklySonnetLimit || 15000000);
}

function saveSettings() {
  const config = {
    refreshIntervalMs: parseInt(getVal('set-refresh') || '30') * 1000,
    historyDays: parseInt(getVal('set-history') || '30'),
    activeThresholdMinutes: parseInt(getVal('set-active-thresh') || '10'),
    monthlySubscriptionCost: parseFloat(getVal('set-subscription-cost') || '200'),
    budgetThreshold: parseFloat(getVal('set-budget') || '100'),
    dailyBudgetWarn: parseFloat(getVal('set-daily-warn') || '10'),
    weeklyAllModelsLimit: parseInt(getVal('set-weekly-all') || '3200000'),
    weeklySonnetLimit: parseInt(getVal('set-weekly-sonnet') || '15000000'),
  };
  // Preserve fields that settings UI doesn't expose
  if (appData && appData.config) {
    const existing = appData.config;
    if (existing.lastBudgetAlertDate !== undefined) {
      config.lastBudgetAlertDate = existing.lastBudgetAlertDate;
    }
  }
  dashboard.saveConfig(config).then(() => showToast('Settings saved', 'success'));
}

function resetSettings() {
  const defaults = {
    refreshIntervalMs: 30000,
    historyDays: 30,
    activeThresholdMinutes: 10,
    monthlySubscriptionCost: 200,
    budgetThreshold: 100,
    dailyBudgetWarn: 10,
    weeklyAllModelsLimit: 3200000,
    weeklySonnetLimit: 15000000,
  };
  dashboard.saveConfig(defaults).then(() => {
    showToast('Settings reset to defaults', 'success');
  });
}

// ---- Session Detail Modal ----
function showSessionModal(sessionId) {
  const modal = document.getElementById('session-modal');
  const content = document.getElementById('modal-content');
  const title = document.getElementById('modal-title');
  modal.classList.remove('hidden');

  const s = allSessions.find(x => x.session_id === sessionId);
  if (!s) {
    content.innerHTML = '<p style="color:var(--red);">Session not found.</p>';
    return;
  }

  const tokens = (s.tokens?.input || 0) + (s.tokens?.output || 0);
  const cost = estimateSessionCost(s);

  title.textContent = 'Session: ' + sessionId.substring(0, 16) + '...';
  content.innerHTML = `
    <div class="modal-stats">
      <div class="modal-stat"><div class="stat-label">Messages</div><div class="stat-value blue">${s.messages || 0}</div><div class="stat-sub">${s.user_messages || 0} user / ${s.assistant_messages || 0} assistant</div></div>
      <div class="modal-stat"><div class="stat-label">Tool Calls</div><div class="stat-value mauve">${s.tool_calls || 0}</div></div>
      <div class="modal-stat"><div class="stat-label">Tokens</div><div class="stat-value yellow">${formatTokens(tokens)}</div><div class="stat-sub">${formatTokens(s.tokens?.input)} in / ${formatTokens(s.tokens?.output)} out</div></div>
      <div class="modal-stat"><div class="stat-label">Est. Cost</div><div class="stat-value red">${formatCost(cost)}</div></div>
    </div>
    <table class="modal-detail-table">
      <tr><td>Session ID</td><td><code>${escapeHtml(s.session_id)}</code></td></tr>
      <tr><td>Status</td><td><span class="status-badge status-${s.status}">${s.status}</span></td></tr>
      <tr><td>Size</td><td>${formatSize(s.size_bytes)}</td></tr>
      <tr><td>Created</td><td>${s.created || 'Unknown'}</td></tr>
      <tr><td>Modified</td><td>${s.modified}</td></tr>
      <tr><td>Duration</td><td>${s.duration_minutes || 0} minutes</td></tr>
      <tr><td>Working Dir</td><td><code>${escapeHtml(s.cwd || 'N/A')}</code></td></tr>
      <tr><td>Models</td><td>${(s.models_used || []).map(m => `<span style="color:${getModelColor(m)}">${getModelShort(m)}</span>`).join(', ') || 'N/A'}</td></tr>
      <tr><td>Cache Read</td><td>${formatTokens(s.tokens?.cache_read)}</td></tr>
      <tr><td>Cache Write</td><td>${formatTokens(s.tokens?.cache_creation)}</td></tr>
    </table>
    <div class="modal-desc"><strong>First Message:</strong><br>${escapeHtml(s.description || 'No description available')}</div>
  `;
}

function closeModal() {
  document.getElementById('session-modal').classList.add('hidden');
}

// ---- Export ----
function exportAll(format) {
  dashboard.exportSessions(format, null).then(ok => {
    if (ok) showToast('Export saved successfully', 'success');
  });
}

// ---- Toast ----
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'toast ' + type;
  const icons = { success: '\u2713', error: '\u2717', info: '\u2139' };
  toast.innerHTML = `<span>${icons[type] || icons.info}</span> ${escapeHtml(message)}`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity .3s';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// ---- Status Bar ----
function updateStatusBar() {
  if (!appData) return;
  const ts = appData.lastUpdated ? new Date(appData.lastUpdated).toLocaleTimeString() : '';
  setText('status-text', `Updated: ${ts}`);

  const active = (appData.sessions || []).filter(s => s.status === 'active').length;
  const total = (appData.sessions || []).length;
  setText('status-sessions', `${active} active / ${total} total`);
}

// Live clock
setInterval(() => {
  const el = document.getElementById('live-clock');
  if (el) el.textContent = new Date().toLocaleTimeString('en-US', { hour12: false });
}, 1000);

// ---- Utility ----
function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}
function setVal(id, val) {
  const el = document.getElementById(id);
  if (el) el.value = val;
}
function getVal(id) {
  const el = document.getElementById(id);
  return el ? el.value : '';
}

// ---- Event Listeners ----
document.getElementById('session-search')?.addEventListener('input', () => { currentPage = 1; applyFiltersAndSort(); });
document.getElementById('status-filter')?.addEventListener('change', () => { currentPage = 1; applyFiltersAndSort(); });
document.getElementById('model-filter')?.addEventListener('change', () => { currentPage = 1; applyFiltersAndSort(); });
document.getElementById('sort-by')?.addEventListener('change', () => { currentPage = 1; applyFiltersAndSort(); });

// ---- Keyboard Shortcuts ----
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
    if (e.key === 'Escape') {
      e.target.blur();
      closeModal();
    }
    return;
  }

  if (e.key === 'Escape') closeModal();
  if (e.key === 'r' || e.key === 'R') { e.preventDefault(); dashboard.getAllData(); showToast('Refreshing...', 'info'); }
  if (e.key === '1') showTab('overview');
  if (e.key === '2') showTab('sessions');
  if (e.key === '3') showTab('costs');
  if (e.key === '4') showTab('settings');

  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    showTab('sessions');
    setTimeout(() => document.getElementById('session-search')?.focus(), 100);
  }
});

// Close modal on overlay click
document.getElementById('session-modal')?.addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeModal();
});
