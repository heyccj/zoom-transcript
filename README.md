# ZT Captions (zoom-transcript)

A Zoom web client bookmarklet that captures live captions and meeting chat into a searchable transcript with speaker names, timestamps, bookmarks, and export.

ZT Captions does not run its own transcription. It reads Zoom's native closed-captioning and chat from the web client's Redux store, then saves and organizes the text in a panel attached to Zoom's caption box.

## Quick start

```bash
npm install
npm run build    # bundles src/ → zoom-transcript.js
npm run watch    # rebuild on change
```

The deliverable is `zoom-transcript.js` — a single IIFE loaded by the bookmarklet from jsDelivr. Each build prepends a UTC timestamp comment for cache debugging.

## How it runs in Zoom

1. User clicks the bookmarklet on a Zoom meeting page.
2. `src/index.js` boots, initializes state, and starts polling Zoom's Redux store every 800ms.
3. On some Zoom layouts the script loads in a parent shell and injects itself into the `#webclient` iframe (`inject.js`).
4. A UI panel mounts inside Zoom's live caption box (or a fixed dock fallback).
5. Captions settle for 3 seconds before being committed to the log; chat ingests immediately.

### Debug API (browser console)

```js
__ztCaption.probe()              // Redux store, line count, attachment status
__ztCaption.getLog()             // current transcript array
__ztCaption.debugPending(true)   // verbose pending-render logs (name flash debugging)
```

## Project layout

```
zoom-transcript/
├── src/                  # ES module source (edit these)
├── zoom-transcript.js      # bundled output (commit + deploy this)
├── index.html              # marketing site + bookmarklet snippet
├── test-harness.html       # local UI testing without Zoom
├── package.json
└── AGENTS.md               # guide for AI coding agents
```

## Source files

### Entry & bootstrap

| File | Purpose |
|------|---------|
| `src/index.js` | Entry point. Boots the recorder, exposes `window.__ztCaption`, handles parent-shell vs iframe modes, starts the poll loop. |
| `src/state.js` | Global `app` singleton and `keys` (localStorage key names). `initAppState()` restores log, prefs, and panel dimensions per meeting. |
| `src/constants.js` | Timing (`POLL_MS`, `SETTLE_MS`), panel size limits, speaker color palettes. |

### Zoom integration

| File | Purpose |
|------|---------|
| `src/meeting.js` | Detects meeting documents, resolves `#webclient` iframe vs in-meeting window, derives meeting ID from URL. |
| `src/inject.js` | Injects bundled script source into the `#webclient` iframe when the bookmarklet runs in the parent shell. |
| `src/redux.js` | Finds Zoom's Redux store via React fiber traversal. Extracts caption lines (`extractLines`) and chat (`extractChatLines`) from store state. Resolves speaker names, formats timestamps, handles chat audience labels. |
| `src/caption-panel.js` | Locates Zoom's caption box DOM, auto-clicks "Show Captions", dismisses language modal, applies panel width/height CSS variables. |

### Data pipeline

| File | Purpose |
|------|---------|
| `src/ingest.js` | Core poll loop (`pollStore`). Ingests settled captions, immediate chat, share-event markers, and pause markers. Persists log to localStorage. |
| `src/dedup.js` | Log entry keys (`makeKey`), progressive caption merging, one-shot system message detection (join/leave notices, Team Chat boilerplate), `dedupLog()`. |

### UI

| File | Purpose |
|------|---------|
| `src/ui-mount.js` | Creates DOM for the caption panel and collapsed pill. Attaches to Zoom's caption box or fallback dock. Watches for DOM changes. |
| `src/ui-core.js` | Wires button handlers, resize handles, shutdown/teardown, copy-to-clipboard, UI ref caching (`ensureUiRefs`). |
| `src/controls.js` | Pause/resume, light/dark mode, collapse, tab switching, collapsed pill state, main `updateUI()` orchestrator. |
| `src/render.js` | Renders settled log entries, in-flight pending captions, stats tab, search filter, elapsed timer. Handles speaker "continued" grouping (hide repeated names). |
| `src/styles.js` | Injects all widget CSS into the Zoom document (`ensureStyles`). Light/dark theme via CSS variables. |

### Features

| File | Purpose |
|------|---------|
| `src/bookmarks.js` | Bookmark add/edit/remove, speaker colors, speaker stats, bookmark mode UI, click-to-place bookmarks on log lines. |
| `src/export.js` | Copy, TXT/JSON download, auto-download on meeting exit, `formatOutput()`, session naming. |
| `src/utils.js` | `escapeHtml`, event shielding to prevent Zoom's draggable caption box from stealing clicks. |

## Data flow

```
Zoom Redux store
       │
       ▼
  pollStore() ──────────────────────────────┐
       │                                    │
       ├── extractLines() ──► pending UI    │  (updates every poll)
       │         │                           │
       │         └── SETTLE_MS ──► ingestLines() ──► app.log ──► settled UI
       │                                              │
       ├── extractChatLines() ──► ingestChatLines() ──┘  (immediate)
       │
       └── activeSharerMap() ──► share markers
```

### Log entry shape

```js
{
  key: "14:05:30|Chris Norman|Hello everyone",  // or "sys|…" / "chat|…"
  time: "14:05:30",
  name: "Chris Norman",   // null for markers
  msg: "Hello everyone",
  src: "allMessages",     // or "chat", "share-event", "pause-event"
  chat: true,             // optional
  marker: true            // optional — pause/share events
}
```

## localStorage keys

| Key | Contents |
|-----|----------|
| `__ztCaptionLog` | Transcript JSON array |
| `__ztCaptionMeetingId` | Current meeting ID (clears log on change) |
| `__ztCaptionSession` | User-assigned meeting name |
| `__ztCaptionBookmarks` | Bookmark definitions |
| `__ztCaptionDark` | Dark mode preference |
| `__ztCaptionCollapsed` | Collapsed pill state |
| `__ztCaptionWidth` / `__ztCaptionHeight` | Panel dimensions |

## Deployment

The bookmarklet fetches the latest commit SHA from GitHub, then loads:

```
https://cdn.jsdelivr.net/gh/heyccj/zoom-transcript@{sha}/zoom-transcript.js
```

After `npm run build`, commit and push `zoom-transcript.js` to `main`.

## Known Zoom quirks

- **Draggable caption box** — mousedown on the widget can start a drag. Interactive controls use `shieldFromCaptionDrag()` / `shieldInputEvents()`.
- **Unstable chat IDs** — system/boilerplate messages lack `msgId`; deduped by message text via `isOneShotSystemMessage()`.
- **Chat receiver objects** — `chatReceiver` may be an object; use `resolveChatLabel()` not string concat.
- **CSS selectors on log keys** — never use `querySelector('[data-key="…"]')` with raw keys; match via `getAttribute()`.
