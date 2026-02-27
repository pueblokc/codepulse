# CodePulse

**Real-time cost analytics and session management for Claude Code.**

![Electron](https://img.shields.io/badge/Electron-34.x-47848F?logo=electron&logoColor=white)
![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)
![License](https://img.shields.io/badge/License-MIT-green)

> **Know exactly what Claude Code is costing you.** CodePulse reads the local stats-cache and session files that Claude Code writes to your machine and shows you a real-time breakdown of token usage, API cost equivalents, cache savings, and session analytics — all without sending a single byte to any external server.

---

## Features

- **Cost tracking** — per-model, per-day, per-week, per-month cost estimates using official Anthropic API pricing
- **Session analytics** — browse, search, filter, and sort every Claude Code session with full details
- **ROI comparison** — see how much API cost your subscription saves you vs. paying per-token
- **Budget alerts** — get native OS notifications when projected monthly spend exceeds your threshold (once per day, no spam)
- **Cache savings** — calculates how much prompt caching saved you vs. sending full input tokens
- **Hour heatmap** — see when you use Claude Code most during the day
- **Export** — export session data to CSV or JSON for your own analysis
- **System tray** — runs in the background, shows today's cost in the tray tooltip
- **File watcher** — auto-refreshes when Claude Code writes new session data
- **Keyboard shortcuts** — navigate without touching the mouse

---

## Tabs

### Overview
The at-a-glance dashboard. Six stat cards across the top (today, week, month, active sessions, total tokens, cache hit rate), a model distribution doughnut chart, a 30-day cost timeline, recent activity for the last 7 days, and a 24-hour usage heatmap.

### Sessions
Every Claude Code session as a sortable, filterable table. Search by description, working directory, or session ID. Filter by status (active/recent/idle/stale) and model family. Sort by recency, token count, cost, messages, or duration. Click any row for a detail modal. Paginates at 50 rows per page. Export all or filtered sessions to CSV or JSON.

### Cost Analysis
Deep cost breakdown by model: input tokens, output tokens, cache read, cache write, and total — all using real per-model pricing from the Anthropic API pricing sheet. ROI analysis shows your API cost equivalent vs. your subscription cost and the net savings multiplier. Daily cost chart and token-by-model stacked bar chart. Budget alert banner when projected monthly spend is over threshold.

### Settings
Configure refresh interval, history window, active session threshold, monthly subscription cost (used in ROI calculation), monthly budget alert threshold, daily cost warning, and estimated weekly token limits. All settings persist to `dashboard-config.json`.

---

## Installation

### Run from source

```bash
git clone https://github.com/pueblokc/codepulse.git
cd codepulse
npm install
npm start
```

### Build a Windows installer

```bash
npm install
npm run build
# Installer and portable exe appear in dist/
```

---

## Build Instructions

Requires Node.js 18+ and npm.

```bash
# Install deps (includes electron-builder as dev dep)
npm install

# Run in dev mode
npm start

# Build Windows NSIS installer + portable exe
npm run build

# Build to directory only (faster, no installer)
npm run build:dir
```

The `dist/` folder will contain:
- `CodePulse Setup x.x.x.exe` — NSIS installer with optional install directory
- `CodePulse x.x.x.exe` — standalone portable executable

---

## Configuration

Settings are stored in `dashboard-config.json` next to the app. You can edit them through the Settings tab or directly in the file.

| Setting | Default | Description |
|---------|---------|-------------|
| `refreshIntervalMs` | `30000` | How often to reload data (milliseconds) |
| `historyDays` | `30` | How many days of history to show in charts |
| `activeThresholdMinutes` | `10` | Minutes since last write before a session is "recent" not "active" |
| `monthlySubscriptionCost` | `200` | Your actual Claude subscription cost, used in ROI calculation |
| `budgetThreshold` | `100` | Projected monthly API cost that triggers a budget alert notification |
| `dailyBudgetWarn` | `10` | Daily cost amount that triggers a warning in the UI |
| `weeklyAllModelsLimit` | `3200000` | Estimated weekly token cap across all models |
| `weeklySonnetLimit` | `15000000` | Estimated weekly Sonnet token cap |
| `lastBudgetAlertDate` | `null` | Auto-managed: date of last OS budget notification (prevents spam) |

---

## FAQ

**Where is the data stored?**
CodePulse reads from `~/.claude/stats-cache.json` and `~/.claude/projects/*/sessions/*.jsonl` — the same files Claude Code writes locally on your machine. It writes nothing to these files and makes no network requests.

**Does it upload anything?**
No. CodePulse is 100% local. No analytics, no telemetry, no external API calls. It only reads files from your local disk.

**Why does the cost show "$0.00" even though I've used Claude Code?**
Claude Code needs to have written session files and a `stats-cache.json` to `~/.claude/`. If you have sessions but no cost data, the stats-cache may not have been generated yet or may be in a different location. Check that `~/.claude/stats-cache.json` exists.

**How accurate are the cost estimates?**
Very close for total and per-model costs (based on `modelUsage` in `stats-cache.json`, which has real input/output token counts by model). Daily/weekly/monthly estimates use the `tokensByModel` field which combines input and output into a single count, so a blended per-token rate is applied. This is an estimate, not exact billing data — Anthropic's billing may differ.

**What does "Cache Hit Rate" mean?**
When Claude Code sends the same context repeatedly, Anthropic can serve it from cache at a much lower token rate. The cache hit rate is the percentage of input tokens served from cache vs. fresh. Higher is better — it means you're saving money.

**What is "Your Actual Cost" in the Cost Analysis tab?**
That is your configured monthly subscription cost (default $200/mo for Claude Max). You can change it in Settings. It is used in the ROI calculation to show how much the subscription saves you vs. paying API rates.

**Can I run this on macOS or Linux?**
Yes. The app is cross-platform. Use `npm start` to run from source. To build for macOS or Linux, add targets to the `build` section in `package.json` (e.g., `"mac": { "target": ["dmg"] }`).

**The window disappears — where did it go?**
CodePulse minimizes to the system tray instead of closing. Click the tray icon to show it again, or press `Ctrl+Shift+D`.

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `1` | Overview tab |
| `2` | Sessions tab |
| `3` | Cost Analysis tab |
| `4` | Settings tab |
| `Ctrl+K` | Focus session search |
| `Ctrl+Shift+D` | Toggle window (global) |
| `R` | Refresh data |
| `Esc` | Close modal |

---

## Tech Stack

- **Electron 34** — cross-platform desktop shell
- **Chart.js 4** — cost timeline, model distribution, token usage charts
- **Chokidar 4** — file watcher for auto-refresh when Claude Code writes session data
- **Catppuccin Mocha** — dark color palette
- Vanilla JS renderer — no React, no bundler, no build step for the UI

---

## Author

Built by [KCCS](https://kccsonline.com) — `info@kccsonline.com`

Source: [github.com/pueblokc/codepulse](https://github.com/pueblokc/codepulse)

---

*CodePulse is not affiliated with Anthropic. Claude is a trademark of Anthropic PBC.*
