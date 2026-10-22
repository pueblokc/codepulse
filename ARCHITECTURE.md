# CodePulse — Architecture

CodePulse is a small Electron desktop app that shows what your Claude Code usage
would cost at Anthropic API list prices. It only **reads** files that Claude Code
already writes under `~/.claude/` (or `$CLAUDE_CONFIG_DIR`), and makes no network requests.

## How it runs

```
npm start  ->  electron .  ->  main.js (main process)
                                 ├─ BrowserWindow (frameless, sandboxed) -> renderer/index.html
                                 ├─ Tray icon + global hotkey Ctrl/Cmd+Shift+D
                                 ├─ chokidar watcher on ~/.claude/projects and stats-cache.json
                                 └─ setInterval refresh (refreshIntervalMs)
```

* **Single instance**: a second launch just focuses the existing window.
* **Close = hide to tray**. Quit comes from the tray menu.
* Settings and window position are saved in `app.getPath('userData')`
  (`dashboard-config.json`, `window-state.json`). Files left next to `main.js`
  by v1.0.0 are read as a fallback.

## Modules

| File | Process | Role |
|------|---------|------|
| `main.js` | main | Window, tray, watcher, refresh loop, IPC handlers, budget OS notification |
| `preload.js` | preload | `contextBridge` → `window.dashboard` (IPC invoke wrappers only) |
| `lib/transcript-parser.js` | main | Finds and parses session JSONL transcripts; caches per-file results by mtime+size |
| `lib/pricing.js` | main | Price table (USD / 1M tokens), model-id parsing, labels, colours, `costForUsage` |
| `lib/cost-calculator.js` | main | Today / 7-day / month-to-date / projected / all-time / cache-savings figures |
| `lib/chart-data.js` | main | Chart.js series aligned to a continuous range of local days |
| `lib/dates.js` | main | Local-calendar date keys (never `toISOString()` for days) |
| `lib/config.js` | main | Defaults, validation/clamping, atomic JSON writes |
| `lib/export.js` | main | CSV (formula-injection safe) / JSON export |
| `lib/security.js` | main | URL allow-list, path containment, IPC sender check |
| `renderer/app.js` | renderer | Renders tabs, tables, charts; all clicks via one delegated listener |
| `renderer/index.html` | renderer | Markup + strict CSP (`script-src 'self'`, so no inline handlers) |
| `renderer/kccs-branding.js` | renderer | Footer branding |
| `renderer/vendor/chart.umd.min.js` | renderer | Chart.js 4.4.7 (vendored) |

## Data sources

1. **Session transcripts** — `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`,
   sub-agent sidechains in `<encoded-cwd>/<session-id>/subagents/*.jsonl`, and the
   older `<encoded-cwd>/sessions/*.jsonl` layout. Each `assistant` line carries
   `message.id`, `message.model` and `message.usage`. Claude Code writes one line per
   content block, repeating the same usage, so usage is de-duplicated by
   `message.id + requestId`. Resumed sessions copy earlier history into the new file,
   so daily totals de-duplicate across files too.
2. **`~/.claude/stats-cache.json`** — Claude Code's periodically recomputed
   aggregate: `modelUsage` (all-time per-model token totals), `dailyModelTokens`
   (combined token count per model per day), `dailyActivity`, `hourCounts`.

## Data flow (one refresh)

```
watcher event / timer / renderer "get-all-data"
  └─ refreshAllData()                                        main.js
       ├─ readStatsCache()                → statsRaw
       ├─ TranscriptStore.readAll()       → { sessions[], daily{date:{model:usage}} }
       ├─ CostCalculator.calculateAll(statsRaw, config, {daily})
       │     day cost = transcript cost for that local day if present,
       │                else stats-cache blended estimate
       ├─ ChartData.prepare(statsRaw, historyDays, {daily})
       ├─ checkBudgetAlert()  (OS notification at most once per local day)
       └─ webContents.send('data-update', { stats, sessions, costs, charts, config })
                                                             renderer/app.js
            renderOverview / renderSessions / renderCosts / renderSettings / renderCharts
```

Session cost, model labels and colours, and the pricing reference table are all
computed in the main process, so the renderer has no copy of the price table.

## Security model

* `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, no `<webview>`.
* `setWindowOpenHandler` denies every new window, and `will-navigate` is blocked;
  http(s) links (the branding footer) open in the OS browser instead. A new window
  would otherwise inherit the preload bridge.
* Every IPC handler checks that the sender frame is the bundled `index.html`.
* `open-external` only accepts http(s) URLs; `open-path` only reveals files inside
  the Claude data dir.
* Config from the renderer is re-validated and clamped in the main process.
* The renderer escapes all transcript-derived text before inserting HTML, and CSP
  blocks inline scripts.

## Tests and CI

`npm test` runs `node --test` over `test/*.test.js`. The tests use temporary
fixture `~/.claude` trees, so there are no real user files and no Electron binary.
`npm run lint` runs ESLint 10 (flat config). `.github/workflows/ci.yml` runs both
on Ubuntu and Windows.
