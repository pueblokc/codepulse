# Cloud Wave 2 — Overnight Quality Pass: CodePulse

Branch: `claude/cloud-wave2-2026-10-22` (no PR opened, nothing merged, tagged or released).
Date: 2026-10-22. Baseline commit: `df335f5` (Initial public release v1.0.0).

## TL;DR

1. **Sessions never loaded.** v1.0.0 only looked in `~/.claude/projects/*/sessions/*.jsonl`. Claude Code writes `~/.claude/projects/<proj>/<id>.jsonl`, so the Sessions tab was empty and session costs were $0. There is a new parser for the current layout, sub-agent transcripts and the old layout. It also stops the per-content-block double counting of tokens.
2. **Prices were stale, about 3x too high for Opus.** Opus 4.5/4.6 were priced at $15/$75; the list price is $5/$25. Claude 5.x models (Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable 5.1) were missing and fell back to the wrong prices. The new table lives in `lib/pricing.js` and is the single source; the renderer's duplicate copy is gone.
3. **Every button was dead.** The page's own CSP (`script-src 'self'`) blocks inline `onclick=` attributes. That covered tabs, minimize/maximize/close, export, pagination, Save Settings, modal close and clicking a session row. Only the keyboard shortcuts worked. Buttons are now wired through one delegated listener. I confirmed this by clicking through the real app under Xvfb.
4. **Security hardening.** The footer link (`target="_blank"`) would open kccsonline.com in a new Electron window that inherits the preload bridge. That page could then call `openPath` (launch any file) and `openExternal` (any URL scheme). Fixed:
   - all new windows and navigation are blocked
   - IPC calls only accepted from the bundled page
   - URL and path allow-lists
   - renderer sandbox turned on
   - Electron 34 (EOL, about 40 advisories) upgraded to 44.x
5. **"Today" was wrong after about 6 pm Mountain time, and the projection was badly inflated.** Dates were UTC (`toISOString`), "week" covered 8 days, and the projection was last-30-days ÷ day-of-month × 30, which reads about 30× too high on the 1st. All windows now use the local calendar.
   - Today's cost now comes from transcripts. The stats-cache is usually not recomputed for today.
   - Tests: 36 `node:test` tests and ESLint, run by GitHub Actions CI on Ubuntu and Windows. All green.

## Commits

| Hash | What |
|------|------|
| `163eb4e` | New `lib/pricing.js` (current prices) and `lib/dates.js`; cost windows and charts use local dates; fixed week, month and projection maths |
| `94b8209` | New `lib/transcript-parser.js` (current + legacy + sub-agent layout, dedupe, mtime cache), `lib/config.js`, `lib/security.js`, `lib/export.js` |
| `47debf7` | `main.js`: new data pipeline, Electron/IPC hardening, settings saved in `userData`, icon built in memory, refresh timer restarts on settings change, watcher covers the whole projects tree |
| `86a6ec1` | Renderer: replaced CSP-blocked inline handlers; removed the duplicate price table; pricing reference table generated from `lib/pricing.js`; Fable in filters and charts |
| `5a47630` | Electron 34 → 44.9.x, electron-builder 25 → 26.15; regenerated the out-of-sync lockfile (`npm ci` failed before); packaged-file allow-list |
| `c676015` | Test suite (36 tests) and ESLint 10 flat config |
| `55c1e90` | `.github/workflows/ci.yml`: lint + test on Ubuntu and Windows, no secrets |
| `7b6cd6a` | Implemented two things the README promised but the code didn't do: the daily cost warning, and export of filtered sessions |
| `fa9d2ca` | `ARCHITECTURE.md`; README corrections (data paths, config location, accuracy notes, Node 20+, Electron 44) |
| *(this commit)* | `CLOUD_WAVE2_REPORT.md` |

## Bugs found and fixed

File:line refers to the **original** code at `df335f5`.

| # | Where | Symptom | Fix |
|---|-------|---------|-----|
| 1 | `main.js:243`, `main.js:411` | Read and watched only `projects/*/sessions/`. Current Claude Code transcripts are directly in `projects/*/`, so there were no sessions and no session costs. | `lib/transcript-parser.js` `discoverSessions()` handles `<proj>/<id>.jsonl`, `<proj>/sessions/*.jsonl` and `<proj>/<id>/subagents/*.jsonl` (sub-agent cost is rolled into the parent session). |
| 2 | `main.js:334-340` | Tokens were summed on every JSONL line. Claude Code writes one line per content block (thinking, text, tool_use) with the same `usage`, so tokens and cost were inflated about 2–4×. | Usage is deduplicated by `message.id + requestId`, keeping the max of each counter. Daily totals also deduplicate across files, because resumed sessions copy the earlier history. |
| 3 | `main.js:292` | Large sessions only parsed the first 200 + last 50 lines, so tokens and cost were undercounted. | The whole file is parsed. Results are cached by mtime+size, so only changed files are re-read on each refresh. |
| 4 | `main.js:307-318` | Every `type:"user"` line counted as a user message, including tool results, meta caveats and `/command` wrappers. "First message" was often a tool output or a caveat. | Those entries are skipped. A `summary` entry becomes the session title. |
| 5 | `main.js:301` | `new Date(bad)` doesn't throw, so invalid timestamps produced NaN durations. | `Date.parse` + `isNaN` check. |
| 6 | `main.js:355` | The active-session threshold was hard-coded to 10 min, so the setting did nothing. | Uses `config.activeThresholdMinutes`. |
| 7 | `lib/cost-calculator.js:7-12`, `renderer/app.js:270-277`, `renderer/index.html` pricing table | Opus 4.5/4.6 at $15/$75 (actual $5/$25). No Claude 5.x models. Unknown Opus versions (e.g. 4.1 at $15/$75, 5.5 at $4/$20) all got the 4.6 price. Mixed-model sessions were priced entirely at one model's rate. `<synthetic>` entries were charged. | `lib/pricing.js` parses the version from the model id and holds current list prices plus the 1h cache-write rate. Sessions are priced per model. The renderer gets precomputed costs. |
| 8 | `lib/cost-calculator.js:179,187,196,211`; `main.js:203` | Date keys came from `toISOString()` (UTC), so "Today" read $0 in the US evening and the once-a-day budget alert reset at UTC midnight. | `lib/dates.js` `localDateKey()` everywhere. |
| 9 | `lib/cost-calculator.js:187` | "Week" used `date >= today-7`, which is 8 days. | Exactly 7 days including today. |
| 10 | `lib/cost-calculator.js:196,206` | "This Month" was really the last 30 days, and projected = last-30-days ÷ day-of-month × 30. On the 1st that is about 30× too high, and it fired false budget alerts. | Month = calendar month to date. Projected = MTD ÷ day-of-month × days-in-month. |
| 11 | `lib/cost-calculator.js:179` | Today/week/month came only from `stats-cache.json`, which Claude Code only recomputes now and then (normally not for today). | Transcript costs are used for every day they cover; the stats-cache fills older days. |
| 12 | `lib/chart-data.js:13-14,51` | `slice(-N)` took the last N *entries*, not days. The cost line used token-entry data on activity-entry labels, so points sat on the wrong dates whenever there were gaps. | All series are aligned to a continuous range of local days, with zeros filled in. |
| 13 | `renderer/index.html:20-31,130-131,157-159,282-283,301`; `renderer/app.js:233` | Inline `onclick` blocked by the page CSP, so every button was dead. | `data-action` / `data-tab` attributes plus one delegated click listener. A test now fails if an inline handler comes back. |
| 14 | `main.js:11-13` | Config, window state and the generated icon were written next to `main.js`. That is read-only inside a packaged asar, so settings never saved in the installed build (errors were swallowed) and the tray icon fell back to the exe icon. | Saved in `app.getPath('userData')` with atomic writes, falling back to read the old location. Icon built in memory. |
| 15 | `main.js:439-443`, `renderer/app.js:539` | A blank or invalid number field saved `NaN` (`null` in JSON), and arbitrary keys from the renderer were saved. | `lib/config.js` `sanitizeConfig()` clamps or drops values in the main process. |
| 16 | `main.js:527` | Changing the refresh interval had no effect until restart. | Timer restarts on save. |
| 17 | `main.js:404-421` | The watcher only covered session dirs that existed at startup. New projects were never watched, and `awaitWriteFinish` delayed refreshes for files that are appended constantly. | Watches the projects tree (depth 4, `.jsonl`/`.json` only), with error logging. |
| 18 | `main.js:117-118` | `Object.assign(s, defaults)` mutated the saved state object. Saved bounds were the maximized bounds, so un-maximizing after a restart restored a full-screen-sized window. | Copies objects; saves `getNormalBounds()`; validates saved numbers. |
| 19 | `main.js:524` | `Ctrl+Shift+D` doesn't exist on macOS, and a failed registration (shortcut already taken) was silent. | `CommandOrControl+Shift+D`; the return value is checked and logged. |
| 20 | `package-lock.json` | The lockfile was out of sync with `package.json`, so `npm ci` failed. | Regenerated. |
| 21 | README vs code | The README promised a "daily cost warning in the UI" (`dailyBudgetWarn` was unused) and "export all or filtered sessions" (export always sent everything). | Both implemented (commit `7b6cd6a`). |

## Security findings

### Fixed

| Finding | Original | Fix |
|---------|----------|-----|
| New windows inherit the preload bridge. The footer `<a target="_blank">` (`renderer/kccs-branding.js:78`) opened kccsonline.com inside Electron with `window.dashboard`, so a compromised or MITM'd page could call `openPath` (launch any local file or exe) and `openExternal` with any scheme. | `main.js:129-142` (no `setWindowOpenHandler` / `will-navigate`) | Deny all new windows and navigation; safe http(s) links go to the OS browser. |
| `open-external` accepted any URL (`file:`, `ms-msdt:`, `smb:` …) | `main.js:502` | http/https only, no credentials in the URL (`lib/security.js`). |
| `open-path` accepted any path (`shell.openPath` runs executables) | `main.js:503` | Only paths inside the Claude data dir; now reveals the file in its folder (`showItemInFolder`) instead of opening it. The renderer never used it. |
| IPC handlers accepted calls from any frame | `main.js:431-504` | Sender frame must be the bundled `index.html`. |
| Renderer not sandboxed | `main.js:136-140` | `sandbox: true`, `webviewTag: false`. |
| CSV formula injection: prompt text such as `=HYPERLINK(...)` ran when the export was opened in Excel | `main.js:471` | Cells starting with `= + - @` (or tab/CR) get a `'` prefix (`lib/export.js`). |
| Unescaped values in HTML (activity dates, status class, model names from stats-cache) | `renderer/app.js:157,234,241,360` | Escaped; colours limited to `#hex`. Smoke-tested with an `<img onerror>` prompt. |
| Electron 34 is end-of-life, with about 40 advisories (context-isolation bypass, `shell.openPath` NUL-byte bypass, ASAR integrity bypass, use-after-frees …) | `package.json` | Upgraded to Electron `^44.9.3` (supported line). `npm audit` no longer reports Electron. |
| Lockfile out of date (unreproducible installs) | `package-lock.json` | Regenerated. |

Public-repo leak scan (all commits, all files except the vendored Chart.js): **no secrets, tokens, IPs, internal hostnames or personal paths found.** The only email addresses are `info@kccsonline.com` (intended), the commit author address, and a test fixture. The four `docs/screenshots/*.png` show mock data only (`sess_…` ids and generic task names).

### Not fixed

| Finding | Why |
|---------|-----|
| `npm audit`: 8 moderate, all one chain: `sprintf-js` DoS via `roarr` → `global-agent` → `@electron/get` inside **electron-builder** | Build-time only; not shipped in the app. npm's suggested "fix" is a semver-major *downgrade* of electron-builder to 26.5.0. Revisit when electron-builder updates `@electron/get`. |
| CSP still has `style-src 'unsafe-inline'` | The renderer and branding use inline `style=` attributes widely. Removing it would be a large UI rewrite; script injection is still blocked. |
| No code signing / ASAR integrity fuse in the build config | Needs Justin's certificate and a decision. See Needs Justin. |
| Electron 45.0.0 was released yesterday | Picked 44.x (supported, battle-tested patch line) rather than a one-day-old major. |

## Tests

```bash
npm ci            # set ELECTRON_SKIP_BINARY_DOWNLOAD=1 if you only want lint/tests
npm run lint      # ESLint 10, flat config (eslint.config.js)
npm test          # node --test "test/*.test.js"
```

* **36 tests, 36 passing, 0 failing** locally (Node 22). Lint is clean. CI run #1 (Ubuntu + Windows) passed on GitHub Actions; later pushes trigger the same workflow.
* Files:
  - `test/pricing.test.js`: model-id parsing (dated, legacy, `[1m]`, Bedrock-prefixed), current prices, fallbacks, cache-write maths
  - `test/transcript-parser.test.js`: block-level dedupe, streaming dedupe, user-message filtering, summaries, bad lines, `<synthetic>`, 1h cache writes, all three directory layouts, resumed-session dedupe, mtime cache, threshold setting
  - `test/costs-and-charts.test.js`: run in `America/Denver`, covering the UTC-evening rollover, DST, 7-day week, month to date, projection on the 1st, stats-cache fallback, chart alignment
  - `test/config-security-export.test.js`: config clamping and atomic save, URL and path guards, IPC sender check, CSV injection
  - `test/renderer-static.test.js`: no inline handlers, every `data-action` handled, every tab has a panel
* **Manual smoke test (not in CI):** I ran the real app (Electron 44, Xvfb) against a fake `CLAUDE_CONFIG_DIR`.
  - Badge and session cost were $0.44, which I checked by hand.
  - Tabs, row click, modal open and close, Save Settings (`'abc'` was clamped to the default) and the pricing table all worked.
  - The XSS prompt rendered as text, navigation to a web URL was blocked, the window count stayed at 1, and the console had no errors.
  - I also built `electron-builder --linux dir`, confirmed `chokidar` is in the asar, and the packaged binary started cleanly.

## Needs Justin

**Decisions**
- **Data source policy.** Today/week/month now come from transcripts, and all-time totals still come from `stats-cache.json`, so all-time can lag behind today. Alternative: compute all-time from transcripts too, but Claude Code deletes transcripts after `cleanupPeriodDays` (30 by default), so history would shrink. I kept the hybrid.
- **Weekly limit settings** (`weeklyAllModelsLimit`, `weeklySonnetLimit`) are still stored but not shown anywhere. I marked them "stored only" in the README rather than inventing a UI. Decide whether to build usage meters or drop the settings.
- **Haiku 5.5 tiered pricing** ($0.10/$0.50 up to 100K-token prompts, $0.50/$2.50 above) uses the lower tier only. **Long-context, batch, fast-mode and Bedrock/Vertex pricing** are not modelled. Prices in `lib/pricing.js` need updating as Anthropic changes them.
- **Code signing and Electron fuses** (`EnableEmbeddedAsarIntegrityValidation`, `OnlyLoadAppFromAsar`) for the Windows installer. This needs your certificate.

**Manual checks on a real Windows desktop**
- Install the NSIS build, change a setting, restart, and confirm it persisted. It should land in `%APPDATA%\CodePulse\dashboard-config.json` (see Unsure).
- Tray icon looks right (now generated in memory), tray menu works, `Ctrl+Shift+D` toggles, close hides to tray.
- With your real `~/.claude`, sessions appear and today's figure roughly matches `npx ccusage daily` (or similar).
- Budget OS notification still appears (Windows toast needs the app's AppUserModelID; unchanged from v1.0.0, but worth confirming on Electron 44).
- Clicking the footer link opens your default browser, not an Electron window.

**Before the next release**
- Retake `docs/screenshots/*.png`: they show the old $15/$75 Opus pricing table.
- Bump `version` and the hard-coded `v1.0` in `renderer/index.html`.
- **Credentials to rotate:** none found in this repo.

## Unsure about

- **userData folder name.** In a packaged build Electron names it after the app (`productName` "CodePulse" vs package `name` "codepulse"). The README says "typically `%APPDATA%\CodePulse`"; please confirm on the real install. Either way the old next-to-exe file is read once as a fallback, and the first save goes to the new place.
- **Transcript format details** are inferred from the current Claude Code JSONL shape, written defensively: unknown entry types are ignored, and both `cache_creation` sub-fields and the flat field are handled. If Anthropic changes the on-disk format again, `test/transcript-parser.test.js` is the place to add a fixture.
- **Sub-agent dedupe.** Session totals include their sub-agent files. Daily totals deduplicate globally by `message.id + requestId`; if two files share an id, the first one discovered is attributed to that day (the cost is the same either way).
- **The stats-cache blended rate** (`(input+output)/2`, cache tokens ignored) for days older than the transcripts is the original author's approximation. I kept it because `tokensByModel` has no input/output split.
- **Electron 44 is untested on a real Windows desktop.** It was smoke-tested on Linux/Xvfb only. The APIs used are stable across these majors, but please do the manual checks above.
