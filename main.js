const { app, BrowserWindow, Tray, Menu, ipcMain, globalShortcut, screen, nativeImage, shell, dialog, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const chokidar = require('chokidar');
const os = require('os');

// --- Config ---
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const STATS_CACHE = path.join(CLAUDE_DIR, 'stats-cache.json');
const STATE_FILE = path.join(__dirname, 'window-state.json');
const CONFIG_FILE = path.join(__dirname, 'dashboard-config.json');
const ICON_FILE = path.join(__dirname, 'assets', 'icon.png');

let mainWindow = null;
let tray = null;
let watcher = null;
let isQuitting = false;
let refreshTimer = null;
let costToday = 0;

// ============================================================
// Icon Generation
// ============================================================
function ensureIcon() {
  if (fs.existsSync(ICON_FILE)) return ICON_FILE;
  try {
    fs.mkdirSync(path.dirname(ICON_FILE), { recursive: true });
    const png = generatePNG(32, 32, { r: 249, g: 226, b: 175 }, 6); // Catppuccin yellow
    fs.writeFileSync(ICON_FILE, png);
    return ICON_FILE;
  } catch (e) { return null; }
}

function generatePNG(w, h, color, radius) {
  const raw = Buffer.alloc((1 + w * 4) * h);
  for (let y = 0; y < h; y++) {
    const off = y * (1 + w * 4);
    raw[off] = 0;
    for (let x = 0; x < w; x++) {
      const px = off + 1 + x * 4;
      const dx = Math.min(x, w - 1 - x);
      const dy = Math.min(y, h - 1 - y);
      const inCorner = dx < radius && dy < radius && Math.pow(dx - radius, 2) + Math.pow(dy - radius, 2) > radius * radius;
      raw[px] = color.r; raw[px + 1] = color.g; raw[px + 2] = color.b; raw[px + 3] = inCorner ? 0 : 255;
    }
  }
  const compressed = zlib.deflateSync(raw);
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(w, 0); ihdrData.writeUInt32BE(h, 4); ihdrData[8] = 8; ihdrData[9] = 6;
  return Buffer.concat([sig, pngChunk('IHDR', ihdrData), pngChunk('IDAT', compressed), pngChunk('IEND', Buffer.alloc(0))]);
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc32Buf(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, c]);
}

const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32Buf(buf) { let crc = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8); return (crc ^ 0xFFFFFFFF) >>> 0; }

// ============================================================
// Config
// ============================================================
function loadConfig() {
  const defaults = {
    refreshIntervalMs: 30000,
    budgetThreshold: 100,
    dailyBudgetWarn: 10,
    historyDays: 30,
    activeThresholdMinutes: 10,
    weeklyAllModelsLimit: 3200000,
    weeklySonnetLimit: 15000000,
    monthlySubscriptionCost: 200,
    lastBudgetAlertDate: null,
  };
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return { ...defaults, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
    }
  } catch { /* ignore */ }
  return defaults;
}

function saveConfig(config) {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); } catch { /* ignore */ }
}

// ============================================================
// Window State
// ============================================================
function loadWindowState() {
  try { return fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : null; } catch { return null; }
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const b = mainWindow.getBounds();
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      x: b.x, y: b.y, width: b.width, height: b.height,
      isMaximized: mainWindow.isMaximized()
    }, null, 2));
  } catch { /* ignore */ }
}

// ============================================================
// Window
// ============================================================
function createWindow() {
  const display = screen.getPrimaryDisplay();
  const wa = display.workArea;
  const saved = loadWindowState();
  const defaults = { width: 1200, height: 800, x: Math.round(wa.x + (wa.width - 1200) / 2), y: Math.round(wa.y + (wa.height - 800) / 2) };
  const s = saved || defaults;

  // Verify position is on-screen
  const displays = screen.getAllDisplays();
  const onScreen = displays.some(d => {
    const a = d.workArea;
    return s.x >= a.x - 100 && s.x < a.x + a.width + 100 && s.y >= a.y - 100 && s.y < a.y + a.height + 100;
  });
  if (!onScreen) Object.assign(s, defaults);

  const iconPath = ensureIcon();
  mainWindow = new BrowserWindow({
    width: s.width, height: s.height, x: s.x, y: s.y,
    minWidth: 800, minHeight: 600,
    frame: false,
    backgroundColor: '#1e1e2e',
    icon: iconPath || undefined,
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (saved && saved.isMaximized) mainWindow.maximize();
    refreshAllData();
  });

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    } else {
      saveWindowState();
    }
  });

  mainWindow.on('moved', debounce(saveWindowState, 500));
  mainWindow.on('resized', debounce(saveWindowState, 500));
}

// ============================================================
// Tray
// ============================================================
function createTray() {
  const iconPath = ensureIcon();
  let trayIcon = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  if (trayIcon.isEmpty()) trayIcon = nativeImage.createFromPath(process.execPath);

  tray = new Tray(trayIcon);
  updateTrayTooltip();

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show / Hide CodePulse', click: () => toggleWindow() },
    { type: 'separator' },
    { label: 'Refresh Data', click: () => refreshAllData() },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
  ]));

  tray.on('click', () => toggleWindow());
}

function updateTrayTooltip() {
  if (!tray) return;
  tray.setToolTip(`CodePulse | Today: $${costToday.toFixed(2)}`);
}

function toggleWindow() {
  if (!mainWindow) return;
  if (mainWindow.isVisible()) { mainWindow.hide(); } else { mainWindow.show(); mainWindow.focus(); }
}

// ============================================================
// Budget Notification
// ============================================================
function checkBudgetAlert(projectedMonthly, config) {
  const threshold = config.budgetThreshold || 100;
  if (projectedMonthly <= threshold) return;

  const today = new Date().toISOString().slice(0, 10);
  if (config.lastBudgetAlertDate === today) return; // already alerted today

  // Send OS notification
  if (Notification.isSupported()) {
    const n = new Notification({
      title: 'CodePulse — Budget Alert',
      body: `Projected monthly spend ($${projectedMonthly.toFixed(2)}) exceeds your budget threshold ($${threshold.toFixed(2)}).`,
      icon: ensureIcon() || undefined,
    });
    n.show();
  }

  // Save the alert date so we don't spam
  config.lastBudgetAlertDate = today;
  saveConfig(config);
}

// ============================================================
// Data Pipeline
// ============================================================
function readStatsCache() {
  try {
    if (fs.existsSync(STATS_CACHE)) {
      return JSON.parse(fs.readFileSync(STATS_CACHE, 'utf8'));
    }
  } catch (e) { console.error('Failed to read stats-cache:', e.message); }
  return {};
}

function readSessionFiles() {
  const sessions = [];
  const projectsDir = path.join(CLAUDE_DIR, 'projects');

  try {
    if (!fs.existsSync(projectsDir)) return sessions;
    const projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter(d => d.isDirectory());

    for (const pDir of projectDirs) {
      const sessionsDir = path.join(projectsDir, pDir.name, 'sessions');
      if (!fs.existsSync(sessionsDir)) continue;

      const files = fs.readdirSync(sessionsDir, { withFileTypes: true })
        .filter(f => f.isFile() && f.name.endsWith('.jsonl'));

      for (const file of files) {
        const filePath = path.join(sessionsDir, file.name);
        try {
          const stat = fs.statSync(filePath);
          const parsed = parseSessionFile(filePath, stat);
          if (parsed) sessions.push(parsed);
        } catch { /* skip bad files */ }
      }
    }
  } catch (e) { console.error('Failed to read sessions:', e.message); }

  sessions.sort((a, b) => b.modifiedMs - a.modifiedMs);
  return sessions;
}

function parseSessionFile(filePath, stat) {
  const sessionId = path.basename(filePath, '.jsonl');
  const data = {
    session_id: sessionId,
    path: filePath,
    size_bytes: stat.size,
    modifiedMs: stat.mtimeMs,
    modified: new Date(stat.mtimeMs).toISOString(),
    created: new Date(stat.birthtimeMs || stat.mtimeMs).toISOString(),
    description: '',
    messages: 0,
    user_messages: 0,
    assistant_messages: 0,
    tool_calls: 0,
    models_used: [],
    tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0 },
    cwd: '',
    duration_minutes: 0,
    status: 'idle',
  };

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());
    const modelsSet = new Set();
    let firstTs = null;
    let lastTs = null;

    const linesToParse = lines.length <= 250 ? lines : [...lines.slice(0, 200), ...lines.slice(-50)];

    for (const line of linesToParse) {
      try {
        const entry = JSON.parse(line);
        const entryType = entry.type || '';

        if (entry.timestamp) {
          try {
            const ts = new Date(entry.timestamp);
            if (!firstTs || ts < firstTs) firstTs = ts;
            if (!lastTs || ts > lastTs) lastTs = ts;
          } catch { /* ignore */ }
        }

        if (entryType === 'human' || entryType === 'user') {
          data.user_messages++;
          data.messages++;
          if (!data.description && entry.message && typeof entry.message === 'string') {
            data.description = entry.message.substring(0, 200);
          }
          if (!data.description && entry.message && entry.message.content) {
            const content = Array.isArray(entry.message.content)
              ? entry.message.content.map(c => c.text || '').join(' ')
              : String(entry.message.content);
            data.description = content.substring(0, 200);
          }
        } else if (entryType === 'assistant') {
          data.assistant_messages++;
          data.messages++;
          if (entry.message && entry.message.model) {
            modelsSet.add(entry.message.model);
          }
          if (entry.message && Array.isArray(entry.message.content)) {
            for (const block of entry.message.content) {
              if (block.type === 'tool_use') data.tool_calls++;
            }
          }
        } else if (entryType === 'summary') {
          if (entry.costUSD) data.tokens.costUSD = (data.tokens.costUSD || 0) + entry.costUSD;
        }

        if (entry.message && entry.message.usage) {
          const u = entry.message.usage;
          data.tokens.input += u.input_tokens || 0;
          data.tokens.output += u.output_tokens || 0;
          data.tokens.cache_read += u.cache_read_input_tokens || 0;
          data.tokens.cache_creation += u.cache_creation_input_tokens || 0;
        }

        if (entry.cwd && !data.cwd) data.cwd = entry.cwd;

      } catch { /* skip bad lines */ }
    }

    data.messages = data.user_messages + data.assistant_messages;
    data.models_used = Array.from(modelsSet);

    if (firstTs && lastTs) {
      data.duration_minutes = Math.round((lastTs - firstTs) / 60000);
    }

    const ageMinutes = (Date.now() - stat.mtimeMs) / 60000;
    if (ageMinutes < 10) data.status = 'active';
    else if (ageMinutes < 60) data.status = 'recent';
    else if (ageMinutes < 1440) data.status = 'idle';
    else data.status = 'stale';

  } catch { /* return partial data */ }

  return data;
}

function refreshAllData() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  try {
    const statsRaw = readStatsCache();
    const sessions = readSessionFiles();
    const config = loadConfig();

    const CostCalculator = require('./lib/cost-calculator');
    const ChartData = require('./lib/chart-data');

    const costData = CostCalculator.calculateAll(statsRaw, config);
    const chartData = ChartData.prepare(statsRaw, config.historyDays);

    costToday = costData.todayCost || 0;
    updateTrayTooltip();

    // Check budget alert (OS notification, once per day)
    checkBudgetAlert(costData.projectedMonthly || 0, config);

    const payload = {
      stats: statsRaw,
      sessions,
      costs: costData,
      charts: chartData,
      config,
      lastUpdated: new Date().toISOString(),
    };

    mainWindow.webContents.send('data-update', payload);
  } catch (e) {
    console.error('Refresh failed:', e.message);
  }
}

// ============================================================
// File Watcher
// ============================================================
function startWatcher() {
  const watchPaths = [STATS_CACHE];

  const projectsDir = path.join(CLAUDE_DIR, 'projects');
  if (fs.existsSync(projectsDir)) {
    try {
      const dirs = fs.readdirSync(projectsDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => path.join(projectsDir, d.name, 'sessions'));
      watchPaths.push(...dirs.filter(d => fs.existsSync(d)));
    } catch { /* ignore */ }
  }

  if (watchPaths.length === 0) return;

  watcher = chokidar.watch(watchPaths, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 200 },
    depth: 2,
  });

  const dr = debounce(refreshAllData, 2000);
  watcher.on('add', dr).on('change', dr).on('unlink', dr);
}

// ============================================================
// IPC Handlers
// ============================================================
function setupIPC() {
  ipcMain.handle('get-all-data', () => {
    refreshAllData();
    return null;
  });

  ipcMain.handle('get-config', () => loadConfig());

  ipcMain.handle('save-config', (_e, config) => {
    saveConfig(config);
    refreshAllData();
    return true;
  });

  ipcMain.handle('export-sessions', async (_e, format, sessionIds) => {
    const sessions = readSessionFiles();
    const filtered = sessionIds
      ? sessions.filter(s => sessionIds.includes(s.session_id))
      : sessions;

    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Sessions',
      defaultPath: `sessions-export-${new Date().toISOString().slice(0, 10)}.${format}`,
      filters: format === 'csv'
        ? [{ name: 'CSV', extensions: ['csv'] }]
        : [{ name: 'JSON', extensions: ['json'] }],
    });

    if (result.canceled) return false;

    try {
      if (format === 'csv') {
        const headers = 'Session ID,Status,Messages,Tool Calls,Input Tokens,Output Tokens,Cache Read,Cache Write,Duration (min),Cost Est ($),Description,CWD,Modified\n';
        const CostCalculator = require('./lib/cost-calculator');
        const rows = filtered.map(s => {
          const cost = CostCalculator.estimateSessionCost(s);
          return [
            s.session_id, s.status, s.messages, s.tool_calls,
            s.tokens.input, s.tokens.output, s.tokens.cache_read, s.tokens.cache_creation,
            s.duration_minutes, cost.toFixed(4),
            `"${(s.description || '').replace(/"/g, '""')}"`,
            `"${(s.cwd || '').replace(/"/g, '""')}"`,
            s.modified,
          ].join(',');
        }).join('\n');
        fs.writeFileSync(result.filePath, headers + rows, 'utf8');
      } else {
        fs.writeFileSync(result.filePath, JSON.stringify(filtered, null, 2), 'utf8');
      }
      return true;
    } catch (e) {
      console.error('Export failed:', e.message);
      return false;
    }
  });

  ipcMain.handle('get-session-detail', (_e, sessionId) => {
    const sessions = readSessionFiles();
    return sessions.find(s => s.session_id === sessionId) || null;
  });

  // Window controls
  ipcMain.handle('window-minimize', () => { if (mainWindow) mainWindow.minimize(); });
  ipcMain.handle('window-maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.handle('window-close', () => { if (mainWindow) mainWindow.hide(); });
  ipcMain.handle('window-is-maximized', () => mainWindow ? mainWindow.isMaximized() : false);

  ipcMain.handle('open-external', (_e, url) => { shell.openExternal(url); });
  ipcMain.handle('open-path', (_e, p) => { shell.openPath(p); });
}

// ============================================================
// Utilities
// ============================================================
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// ============================================================
// Lifecycle
// ============================================================
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); } else {
  app.on('second-instance', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });

  app.whenReady().then(() => {
    setupIPC();
    createWindow();
    createTray();
    startWatcher();

    try { globalShortcut.register('Ctrl+Shift+D', toggleWindow); } catch (e) { console.error('Hotkey registration failed:', e.message); }

    const config = loadConfig();
    refreshTimer = setInterval(refreshAllData, config.refreshIntervalMs || 30000);
  });

  app.on('before-quit', () => { isQuitting = true; });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (watcher) watcher.close();
    if (refreshTimer) clearInterval(refreshTimer);
  });
  app.on('window-all-closed', (e) => e.preventDefault());
}
