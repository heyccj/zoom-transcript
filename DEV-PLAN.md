# ZT Captions — Dev Plan
**Reference files:** `src/` modules (source) · `zoom-transcript.js` (built bundle) · `mock-widget.html` (target design)

**Build:** `npm run build` — bundles `src/index.js` → `zoom-transcript.js` for jsDelivr/bookmarklet.

---

## Overview

The existing app is a single self-contained IIFE injected into Zoom's caption panel. The mock defines a redesigned widget with a new visual system (CSS custom properties + light/dark mode), a combined log/live view, a Stats tab, and several new UX features (session naming, pause, JSON export, search, collapse pill). The data extraction and Redux polling core is solid and should be kept intact. Most work is in the UI layer.

---

## 1. CSS Architecture

### What exists
`ensureStyles()` (line 710) injects a `<style>` tag with hardcoded dark-mode-only values as a template literal. All colors are absolute hex/rgba values — no variables. One CSS custom property exists (`--zt-panel-width`) but only for dimensions.

### What needs to change
Replace the single hardcoded stylesheet with a two-mode token system. All color values become CSS custom properties. Light mode is the default (`:root`); dark mode overrides them on a class (`.__zt-dark`). Apply `.__zt-dark` to `#__zt-caption-mount` rather than `document.body` — the widget is scoped and shouldn't affect Zoom's own DOM.

**New token set to define in `:root` (light defaults):**
```
--zt-widget-bg, --zt-widget-border
--zt-text-primary, --zt-text-secondary, --zt-text-dim
--zt-text-msg, --zt-text-pending-msg, --zt-text-marker
--zt-text-idle, --zt-text-idle-strong
--zt-session-color, --zt-session-placeholder
--zt-tab-inactive, --zt-tab-active-text, --zt-tab-active-line, --zt-tab-border
--zt-search-bg, --zt-search-border, --zt-search-text
--zt-entry-border
--zt-btn-bg, --zt-btn-border, --zt-btn-text, --zt-btn-hover
--zt-btn-pause-*, --zt-btn-stop-*, --zt-btn-primary-*, --zt-btn-resume-*
--zt-icon-btn-bg, --zt-icon-btn-border, --zt-icon-btn-text
--zt-icon-btn-active-bg, --zt-icon-btn-active-border, --zt-icon-btn-active-text
--zt-footer-border, --zt-scrollbar
--zt-dropdown-bg, --zt-dropdown-border, --zt-dropdown-hover
--zt-paused-bg, --zt-paused-border, --zt-paused-text
--zt-stats-bar-bg, --zt-stat-name, --zt-stat-lines
--zt-panel-width (keep existing)
```

**Speaker colors also need light/dark variants.** Existing palette (`SPEAKER_PALETTE`, line 349) uses bright pastels designed for dark backgrounds. In light mode these are too low-contrast. Define two palettes and switch with the mode:

```js
const SPEAKER_PALETTE_DARK  = ['#7dd3fc','#f9a8d4','#fcd34d','#86efac','#c4b5fd','#fb923c','#67e8f9','#f87171'];
const SPEAKER_PALETTE_LIGHT = ['#0284c7','#be185d','#b45309','#15803d','#7c3aed','#c2410c','#0891b2','#b91c1c'];
```

`getSpeakerColor()` (line 351) currently assigns colors once and caches them. It needs to return the right palette color based on the current mode. Options: re-derive on every call using the mode state, or rebuild `speakerColorMap` on mode toggle. The re-derive-on-call approach is simpler.

---

## 2. DOM Structure — `createMount()`

### What exists
`createMount()` (line 963) builds:
```
.__zt-caption-mount
  .__zt-caption-bar
    #__zt-caption-dot
    #__zt-caption-status     ← text like "Recording — Patrick" or "Listening…"
    #__zt-caption-count      ← "84 saved"
    .__zt-caption-actions
      #__zt-caption-copy     ← "Copy"
      #__zt-caption-save     ← "Download"
      #__zt-caption-close    ← "Stop"
  #__zt-caption-log          ← flat scrollable log
```
No tabs. No session name. No pause. No mode toggle. Single download format.

### What needs to replace it
```
.__zt-caption-mount [.__zt-dark when dark mode active]
  .__zt-header
    #__zt-dot
    #__zt-session-name       ← contenteditable or <input>
    .__zt-meta
      #__zt-timer            ← NEW: elapsed time display
      #__zt-count            ← "84 lines"
    #__zt-mode-btn           ← ☀︎ / 🌙 icon button
    #__zt-collapse-btn       ← – icon button

  .__zt-tabs
    .__zt-tab[data-tab="log"]    ← "Log" (default active)
    .__zt-tab[data-tab="stats"]  ← "Stats"

  .__zt-tab-panel[data-panel="log"]
    .__zt-search
      <input #__zt-search-input>
    #__zt-log-entries        ← scrollable log rows (replaces #__zt-caption-log)

  .__zt-tab-panel[data-panel="stats"]
    .__zt-stats-header
    .__zt-stat-row × N       ← per speaker

  .__zt-footer
    #__zt-pause-btn          ← NEW
    #__zt-copy-btn
    .__zt-download-wrap
      #__zt-download-btn     ← opens dropdown
      .__zt-dropdown
        .zt-dropdown-item[data-format="txt"]
        .zt-dropdown-item[data-format="json"]
    #__zt-stop-btn
```

**Collapsed state** is a separate element (not part of the mount). When collapsed, the mount is hidden and a pill div is shown in its place:
```
#__zt-pill
  .__zt-collapsed-dot
  .__zt-speaker-chip         ← current speaker + color dot
  .__zt-collapsed-meta       ← "84 lines · 23:47"
  #__zt-expand-btn           ← +
```

---

## 3. State Variables — What's New

Add these alongside existing module-level vars (line 317–349 block):

```js
let sessionName    = '';          // persisted to localStorage key '__ztCaptionSession'
let paused         = false;       // when true, ingestLines() is a no-op
let darkMode       = false;       // persisted to localStorage key '__ztCaptionDark'
let collapsed      = false;
let activeTab      = 'log';       // 'log' | 'stats'
let elapsedStart   = null;        // Date.now() snapshot when first line captured
let elapsedTimer   = null;        // setInterval handle for header timer
let speakerStats   = {};          // { [name]: lineCount } — rebuilt on every persistLog()
```

**Remove:**
- `statusFlash`, `statusFlashUntil` (line 331–332) — status text is replaced by the session name field + dot state; flash pattern no longer needed
- `status` string (line 327) — replaced by dot color + tab state
- `uiMountedHost` (line 333) — not needed in new structure

---

## 4. Log Entries — Pending State

### What exists
`renderLogItems()` (line 1304) appends only settled entries. Pending lines live in `pendingLines` during the 3s settle window and are displayed in the separate live overlay (`renderLiveOverlay()`, line 1080+), not in the log.

### What needs to change
Remove the separate live overlay entirely. Pending lines appear directly in the log as dimmed entries, then get replaced/confirmed when settled.

**New rendering model:**

```
renderLog()
  1. Render settled entries (log[]) as normal — unchanged from current renderLogItems()
  2. If pendingLines is non-null, append them after settled entries with class .__zt-entry--pending
  3. On settle: remove pending DOM nodes, re-render newly settled entries as normal
  4. Auto-scroll to bottom whenever log or pending changes
```

**Implementation approach:** Track DOM nodes separately for settled vs pending. On each `updateUI()` call:
- Settled rows: append-only (same as today with `renderedLogCount`)
- Pending rows: clear and re-render the pending block each time (it's at most a few rows)

Pending entry DOM structure matches settled entries but with the `__zt-entry--pending` class:
```html
<div class="__zt-entry __zt-entry--pending" data-key="...">
  <span class="__zt-entry-time">10:07:18</span>
  <span class="__zt-entry-name" style="color:...">Patrick</span>
  <span class="__zt-entry-msg">yeah go ahead</span>
</div>
```

**CSS for pending:**
```css
.__zt-entry--pending .__zt-entry-time { opacity: 0.4; }
.__zt-entry--pending .__zt-entry-name { opacity: 0.4; }
.__zt-entry--pending .__zt-entry-msg  { color: var(--zt-text-pending-msg); }
```

**Remove:** `renderLiveOverlay()` (line 1080–1137), `syncIdleLine()` (line 1139–1155), `updateRowWords()` (line 1054–1071), `recordedPrefixLength()` (line 1028–1053), `recordedWordCount()` (line 1055–1063 approximate), `normalizedLogMsgs()` (line 1012–1023), all `.__zt-live-*` and `.__zt-w` CSS, `#__zt-live-overlay` DOM element and cleanup in `shutdown()` (line 955).

---

## 5. Timestamp Format

### What exists
`linesFromAllMessages()` (line 228) stores `msg.messageTime` as `line.time`. The value is whatever Zoom provides — typically a locale time string without seconds (e.g. `"10:07 AM"`).

### What needs to change
Timestamps should include seconds. `messageTime` from Zoom's Redux state is a Unix timestamp (milliseconds). Convert on capture:

```js
// In linesFromAllMessages() and linesFromNewLTMessage()
// Replace:
time: msg.messageTime || '',
// With:
time: msg.messageTime ? formatTime(msg.messageTime) : '',
```

```js
function formatTime(ms) {
  const d = new Date(ms);
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return h + ':' + m + ':' + s;
}
```

Also update `linesFromMessageLatest()` (line 276) which uses `new Date().toLocaleTimeString()` — replace with `formatTime(Date.now())`.

---

## 6. New Features

### 6a. Session Name
- Input field in header, `contenteditable` span or `<input>`.
- On change, save to `localStorage.setItem('__ztCaptionSession', value)`.
- On init, load from localStorage.
- Used in `downloadFilename()` (line 1392): if `sessionName` is set, prefix the filename with a slugified version: `rowan-dev-sync-2026-06-11-100000.txt`.

### 6b. Pause
- Add `paused` bool to module state.
- In `ingestLines()` (line 398), add early return: `if (paused) return 0;`
- Also skip `persistLog()` call in the settle timer callback (line 529–539) when paused.
- Dot state: paused → green-steady (same as "connected, idle"). Add CSS class `.__zt-caption-dot--paused`.
- Show `.__zt-paused-banner` in the widget when paused (above the tabs).
- Footer button: toggles between "⏸ Pause" (`__zt-btn--pause`) and "▶ Resume" (`__zt-btn--resume`).

### 6c. Elapsed Timer
- `elapsedStart` is set to `Date.now()` the first time `ingestLines()` adds a line (i.e. first caption received).
- `elapsedTimer` runs `setInterval` every second, updating `#__zt-timer` with `mm:ss`.
- Pause halts the displayed timer (but doesn't reset `elapsedStart` — just stop updating the display while paused).
- Stop/reset clears `elapsedStart` and the interval.

### 6d. Stats Tab
- `speakerStats` is rebuilt inside `persistLog()` after `dedupLog()`: iterate `log`, count lines per `e.name`, skip nulls (markers).
- `renderStats()` is called from `updateUI()` but only when `activeTab === 'stats'`.
- Render a row per speaker, sorted descending by line count.
- Bar width = `(count / maxCount) * 100`% — relative to top speaker, not total.
- Percentage = `(count / totalLines) * 100`.

### 6e. Light/Dark Mode Toggle
- `darkMode` persisted to `localStorage.setItem('__ztCaptionDark', '1')`.
- On init, read from localStorage and apply.
- Toggle button (`#__zt-mode-btn`) in the header calls `toggleMode()`:
  ```js
  function toggleMode() {
    darkMode = !darkMode;
    localStorage.setItem('__ztCaptionDark', darkMode ? '1' : '');
    const mount = document.getElementById('__zt-caption-mount');
    mount.classList.toggle('__zt-dark', darkMode);
    updateModeBtn();
  }
  ```
- `updateModeBtn()` sets the button icon to `☀︎` (light mode) or `🌙` (dark mode).
- Speaker colors: `getSpeakerColor()` checks `darkMode` flag to pick from the right palette.

### 6f. Collapse to Pill
- `#__zt-pill` is a sibling element of `#__zt-caption-mount` inside the mount's parent.
- Collapse: hide `#__zt-caption-mount`, show `#__zt-pill`.
- Expand: reverse.
- Pill shows: recording dot, current speaker chip (from `latestPendingSpeaker()` or last settled speaker), line count, elapsed time.
- `collapsed` persists to `localStorage` — user shouldn't have to re-collapse on page navigation within Zoom.

### 6g. Search
- `#__zt-search-input` is an `<input>` inside the log panel.
- `oninput` handler filters `#__zt-log-entries` children: hide non-matching, highlight matching term with `<mark>`.
- Clear input restores all entries and removes highlights.
- Search only applies to settled entries (not pending).

### 6h. JSON Export
Add alongside existing `downloadCaptions()` (line 1399):

```js
function downloadJson() {
  flushPending();
  if (!log.length) return;
  const payload = {
    session: sessionName || null,
    exportedAt: new Date().toISOString(),
    entries: log.map(e => ({
      time: e.time || null,
      speaker: e.name || null,
      text: e.msg,
      marker: e.marker || false
    }))
  };
  const a = activeDoc().createElement('a');
  a.href = 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(payload, null, 2));
  a.download = downloadFilename().replace('.txt', '.json');
  a.click();
}
```

The download button becomes a dropdown with two items: "Plain text (.txt)" and "Structured (.json)".

---

## 7. What to Remove

| Current code | Reason |
|---|---|
| `renderLiveOverlay()` (line 1080) | Replaced by pending entries in log |
| `syncIdleLine()` (line 1139) | Idle state now shown inline in log panel |
| `updateRowWords()` (line 1054) | No more per-word green/white coloring |
| `recordedPrefixLength()` (line 1028) | Only needed for word coloring |
| `recordedWordCount()` | Same |
| `normalizedLogMsgs()` cache (line 1012) | Same |
| `__zt-live-overlay` DOM + CSS | Replaced |
| `.__zt-w`, `.__zt-w--rec` CSS | No more word spans |
| `.__zt-live-row`, `.__zt-live-avatar`, `.__zt-live-text` CSS | No more live overlay |
| `.__zt-caption-idle-line` CSS | Idle handled differently in log panel |
| `statusFlash` / `statusFlashUntil` (line 331) | Status text is gone |
| `status` string (line 327) | Replaced by dot state + tab content |
| `displayStatus()` (line 368) | No longer used |
| `latestPendingSpeaker()` (line 360) | Keep — used for collapsed pill speaker chip |
| `panelWatchTimer` (line 346 — already removed in recent update) | Confirm removed |
| `.__zt-caption-status` CSS + DOM element | Replaced by session name field |
| `createFallback()` (line 1185) | Fallback div pattern replaced by dock-first approach |

---

## 8. Things to Keep As-Is

These are working correctly and shouldn't be touched:

- Redux store detection: `findReduxStore()`, `storeFromFiber()`, `collectFibers()` (lines 102–157)
- Caption extraction: `extractLines()`, `linesFromAllMessages()`, `linesFromNewLTMessage()`, `linesFromMessageLatest()` (lines 219–297)
- Dedup logic: `dedupLog()`, `ingestLines()`, `makeKey()`, `isProgressiveUpdate()` — keep but fix the direction bug on line 20 (see code-review notes)
- `pollStore()` core loop (line 483)
- `attendeeNameMap()` / `activeSharerMap()` / `trackShareEvents()` (lines 159–460)
- Auto-enable captions: `startCaptionsAutoEnable()`, `tryShowCaptions()` (lines 660–706)
- Caption language modal: `tryDismissCaptionLanguageModal()` (line 631)
- Auto-download on Leave/End: `setupAutoDownloadHooks()`, `teardownAutoDownloadHooks()` (lines 1267–1301)
- iframe injection (lines 1361–1373)
- `shutdown()` — extend to also clear new state (elapsedTimer, new DOM nodes)
- `flushPending()` (line 1364) — keep as-is
- `persistLog()` — extend to rebuild `speakerStats`
- `formatOutput()` (line 1379) for .txt export — keep
- `getMeetingId()` and meeting-scoped localStorage key logic (lines 56–64, 317–325)

---

## 9. Execution Order

1. **CSS tokens** — rewrite `ensureStyles()` with the full variable set, light defaults, `.__zt-dark` overrides. No behavior change yet, just the style system.
2. **DOM structure** — rewrite `createMount()` with the new HTML. Wire up button refs in `attachMount()`. Keep existing log rendering connected to `#__zt-log-entries`.
3. **Timestamp seconds** — add `formatTime()`, update `linesFromAllMessages()` and `linesFromNewLTMessage()`.
4. **Pending in log** — modify `updateUI()` to call a new `renderPendingItems()` that appends/replaces the pending block after settled entries. Remove `renderLiveOverlay()` call from `watchCaptionPanel()`.
5. **Elapsed timer** — wire up `elapsedStart` and `elapsedTimer` in `ingestLines()` and `shutdown()`.
6. **Session name** — add input, localStorage read/write, integrate into `downloadFilename()`.
7. **Pause** — add `paused` flag, guard in `ingestLines()` and settle callback, wire button.
8. **Stats tab** — add `speakerStats` rebuild in `persistLog()`, add `renderStats()`, wire tab switching.
9. **Light/dark toggle** — add `darkMode` state, toggle on mount class, update speaker color selection.
10. **Collapse pill** — add pill element in `attachMount()`, wire collapse/expand.
11. **Search** — add input handler, filter/highlight settled entries.
12. **JSON export** — add `downloadJson()`, replace single Download button with dropdown.
13. **Cleanup** — remove all dead code listed in Section 7. Fix the dedup direction bug.
