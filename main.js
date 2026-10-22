const { app, BrowserWindow, Tray, Menu, ipcMain, globalShortcut, screen, nativeImage, shell, dialog, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const chokidar = require('chokidar');
const os = require('os');

const Config = require('./lib/config');
const CostCalculator = require('./lib/cost-calculator');
const ChartData = require('./lib/chart-data');
const { TranscriptStore } = require('./lib/transcript-parser');
const { sessionsToCsv, sessionsToJson } = require('./lib/export');
const { isSafeExternalUrl, isPathInside, isTrustedRendererUrl } = require('./lib/security');
const { localDateKey } = require('./lib/dates');

// --- Config ---
// CLAUDE_CONFIG_DIR is honoured the same way Claude Code honours it.
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const STATS_CACHE = path.join(CLAUDE_DIR, 'stats-cache.json');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const INDEX_HTML = path.join(__dirname, 'renderer', 'index.html');
// Settings live in the per-user app data dir (the app folder is read-only when
// packaged). The old files next to main.js are still read as a fallback.
const LEGACY_STATE_FILE = path.join(__dirname, 'window-state.json');
const LEGACY_CONFIG_FILE = path.join(__dirname, 'dashboard-config.json');
let STATE_FILE = LEGACY_STATE_FILE;
let CONFIG_FILE = LEGACY_CONFIG_FILE;

let mainWindow = null;
let tray = null;
let watcher = null;
let isQuitting = false;
let refreshTimer = null;
let costToday = 0;
let appIcon = null;
const transcripts = new TranscriptStore();

// ============================================================
// Icon Generation
// ============================================================
// Generated in memory: writing assets/icon.png next to main.js fails inside a
// packaged (read-only) asar.
function ensureIcon() {
  if (appIcon) return appIcon;
  try {
    const png = generatePNG(32, 32, { r: 249, g: 226, b: 175 }, 6); // Catppuccin yellow
    appIcon = nativeImage.createFromBuffer(png);
    if (appIcon.isEmpty()) appIcon = null;
  } catch { appIcon = null; }
  return appIcon;
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
  return Config.loadConfig(CONFIG_FILE, LEGACY_CONFIG_FILE);
}

function saveConfig(config) {
  return Config.saveConfig(CONFIG_FILE, config);
}

function restartRefreshTimer(config) {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(refreshAllData, (config && config.refreshIntervalMs) || 30000);
}

// ============================================================
// Window State
// ============================================================
function loadWindowState() {
  const s = Config.readJson(STATE_FILE) || Config.readJson(LEGACY_STATE_FILE);
  if (!s || ![s.x, s.y, s.width, s.height].every(n => Number.isFinite(n))) return null;
  return s;
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    // Save the restored (non-maximized) bounds so un-maximizing goes back to them.
    const b = mainWindow.getNormalBounds();
    Config.writeJsonAtomic(STATE_FILE, {
      x: b.x, y: b.y, width: b.width, height: b.height,
      isMaximized: mainWindow.isMaximized()
    });
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
  const s = saved ? { ...saved } : { ...defaults };

  // Verify position is on-screen
  const displays = screen.getAllDisplays();
  const onScreen = displays.some(d => {
    const a = d.workArea;
    return s.x >= a.x - 100 && s.x < a.x + a.width + 100 && s.y >= a.y - 100 && s.y < a.y + a.height + 100;
  });
  if (!onScreen) Object.assign(s, defaults);

  const icon = ensureIcon();
  mainWindow = new BrowserWindow({
    width: s.width, height: s.height, x: s.x, y: s.y,
    minWidth: 800, minHeight: 600,
    frame: false,
    backgroundColor: '#1e1e2e',
    icon: icon || undefined,
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
    show: false,
  });

  // Never open new Electron windows or navigate away from the bundled page:
  // a new window would inherit the preload bridge. Web links go to the OS browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    e.preventDefault();
    if (isSafeExternalUrl(url)) shell.openExternal(url);
  });

  mainWindow.loadFile(INDEX_HTML);
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
  let trayIcon = ensureIcon() || nativeImage.createEmpty();
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

  const today = localDateKey();
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

function readSessions(config) {
  try {
    return transcripts.readAll(PROJECTS_DIR, {
      activeThresholdMinutes: (config || loadConfig()).activeThresholdMinutes,
    });
  } catch (e) {
    console.error('Failed to read sessions:', e.message);
    return { sessions: [], daily: {} };
  }
}

function refreshAllData() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  try {
    const statsRaw = readStatsCache();
    const config = loadConfig();
    const { sessions, daily } = readSessions(config);
    const now = new Date();

    const costData = CostCalculator.calculateAll(statsRaw, config, { daily, now });
    const chartData = ChartData.prepare(statsRaw, config.historyDays, { daily, now });

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
  // Watch the whole projects tree (new project dirs and sub-agent transcripts
  // appear while the app runs). The periodic timer is the fallback if the
  // directory doesn't exist yet.
  const watchPaths = [STATS_CACHE];
  if (fs.existsSync(PROJECTS_DIR)) watchPaths.push(PROJECTS_DIR);

  watcher = chokidar.watch(watchPaths, {
    ignoreInitial: true,
    // Transcripts are appended continuously; don't wait for them to settle.
    depth: 4,
    ignored: (p, stats) => !!stats && stats.isFile() && !/\.jsonl?$/.test(p),
  });

  const dr = debounce(refreshAllData, 2000);
  watcher.on('add', dr).on('change', dr).on('unlink', dr);
  watcher.on('error', (e) => console.error('Watcher error:', e && e.message));
}

// ============================================================
// IPC Handlers
// ============================================================
// Only our own bundled page may call the IPC API.
function handle(channel, fn) {
  ipcMain.handle(channel, (event, ...args) => {
    const url = event.senderFrame ? event.senderFrame.url : '';
    if (!isTrustedRendererUrl(url, INDEX_HTML)) {
      console.error(`Blocked IPC "${channel}" from untrusted sender`);
      return null;
    }
    return fn(event, ...args);
  });
}

function setupIPC() {
  handle('get-all-data', () => {
    refreshAllData();
    return null;
  });

  handle('get-config', () => loadConfig());

  handle('save-config', (_e, incoming) => {
    // Keep fields the settings UI doesn't send (e.g. lastBudgetAlertDate).
    const merged = Config.sanitizeConfig({ ...loadConfig(), ...(incoming && typeof incoming === 'object' ? incoming : {}) });
    const ok = saveConfig(merged);
    restartRefreshTimer(merged);
    refreshAllData();
    return ok;
  });

  handle('export-sessions', async (_e, format, sessionIds) => {
    if (format !== 'csv' && format !== 'json') return false;
    const { sessions } = readSessions();
    const filtered = Array.isArray(sessionIds)
      ? sessions.filter(s => sessionIds.includes(s.session_id))
      : sessions;

    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Sessions',
      defaultPath: `sessions-export-${localDateKey()}.${format}`,
      filters: format === 'csv'
        ? [{ name: 'CSV', extensions: ['csv'] }]
        : [{ name: 'JSON', extensions: ['json'] }],
    });

    if (result.canceled || !result.filePath) return false;

    try {
      const body = format === 'csv' ? sessionsToCsv(filtered) : sessionsToJson(filtered);
      fs.writeFileSync(result.filePath, body, 'utf8');
      return true;
    } catch (e) {
      console.error('Export failed:', e.message);
      return false;
    }
  });

  handle('get-session-detail', (_e, sessionId) => {
    if (typeof sessionId !== 'string') return null;
    const { sessions } = readSessions();
    return sessions.find(s => s.session_id === sessionId) || null;
  });

  // Window controls
  handle('window-minimize', () => { if (mainWindow) mainWindow.minimize(); });
  handle('window-maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  handle('window-close', () => { if (mainWindow) mainWindow.hide(); });
  handle('window-is-maximized', () => mainWindow ? mainWindow.isMaximized() : false);

  handle('open-external', (_e, url) => {
    if (!isSafeExternalUrl(url)) return false;
    shell.openExternal(url);
    return true;
  });
  // Restricted to the Claude data dir (e.g. "reveal transcript"); anything
  // else could launch arbitrary executables.
  handle('open-path', (_e, p) => {
    if (!isPathInside(CLAUDE_DIR, p) || !fs.existsSync(p)) return false;
    shell.showItemInFolder(p);
    return true;
  });
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
    const userData = app.getPath('userData');
    STATE_FILE = path.join(userData, 'window-state.json');
    CONFIG_FILE = path.join(userData, 'dashboard-config.json');

    setupIPC();
    createWindow();
    createTray();
    startWatcher();

    try {
      if (!globalShortcut.register('CommandOrControl+Shift+D', toggleWindow)) console.error('Hotkey Ctrl+Shift+D is in use by another app');
    } catch (e) { console.error('Hotkey registration failed:', e.message); }

    restartRefreshTimer(loadConfig());
  });

  app.on('before-quit', () => { isQuitting = true; });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (watcher) watcher.close();
    if (refreshTimer) clearInterval(refreshTimer);
  });
  app.on('window-all-closed', (e) => e.preventDefault());
}
