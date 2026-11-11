# ZT Captions (zoom-transcript)

A Zoom web client bookmarklet that captures live captions and meeting chat into a searchable transcript with speaker names, timestamps, bookmarks, and export. An optional localhost companion (**ZT Copilot**) can receive that live transcript and show AI suggestions on a second screen.

ZT Captions does not run its own transcription. It reads Zoom's native closed-captioning and chat from the web client's Redux store, then saves and organizes the text in a panel attached to Zoom's caption box.

## Quick start

```bash
npm install
npm run build    # bundles src/ → zoom-transcript.js
npm run watch    # rebuild on change
```

The deliverable is `zoom-transcript.js` — a single IIFE loaded by the bookmarklet from jsDelivr. Each build prepends a UTC timestamp comment for cache debugging.

### AI copilot (optional)

A separate zero-dependency Node server on your machine. The bookmarklet still records and downloads as before; if this server is not running, nothing changes.

```bash
cp copilot/config.example.json copilot/config.json   # then add your Anthropic key + your speaker name
npm run copilot                                      # http://localhost:7399
```

Open that URL on a second monitor, paste a meeting brief (objectives / notes), then click the bookmarklet in Zoom. A green **AI** badge in the recorder header means the transcript is flowing to the copilot. An **On you** list (questions aimed at you, things proposed to you, things you committed to) and occasional suggestion cards appear on the copilot page; `act-now` items can fire a macOS notification.

`copilot/config.json` is gitignored. Without a key, the page still shows the live feed and writes a transcript backup to `copilot/transcripts/`.

Optional: set `vaultPath` in `config.json` to a notes folder with `projects/<slug>/_PROJECT.md` files, and the copilot reads a project's note when it comes up in the brief or the conversation. It also reads your 1:1 notes on a colleague when they speak, and any notes the brief lists on a `NOTES:` line (for example a prep note or career plan). Files that look like credentials are never read. Chips under the header show which notes it's using. Before a meeting, **Copy prep prompt** gives you a prompt to paste into Claude Code in that folder; it drafts the brief and sends it straight to the copilot.

Optional: `cp copilot/profile.example.md copilot/profile.md` and describe your role, team, and what is (and isn't) worth a nudge. It's gitignored and goes into every prompt.

## How it runs in Zoom

1. User clicks the bookmarklet on a Zoom meeting page.
2. `src/index.js` boots, initializes state, and starts polling Zoom's Redux store every 800ms.
3. On some Zoom layouts the script loads in a parent shell and injects itself into the `#webclient` iframe (`inject.js`).
4. A UI panel mounts inside Zoom's live caption box (or a fixed dock fallback).
5. Captions settle for 3 seconds before being committed to the log; chat ingests immediately.

### Debug API (browser console)

```js
__ztCaption.probe()              // Redux store, line count, attachment status, copilot connectivity
__ztCaption.getLog()             // current transcript array
__ztCaption.debugPending(true)   // verbose pending-render logs (name flash debugging)
```

## Project layout

```
zoom-transcript/
├── src/                    # ES module source (edit these)
├── zoom-transcript.js      # bundled output (commit + deploy this)
├── copilot/                # localhost AI companion (not bundled)
│   ├── server.js
│   ├── public/index.html
│   ├── config.example.json # copy to config.json (gitignored)
│   └── profile.example.md  # copy to profile.md (gitignored, optional)
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
| `src/ingest.js` | Core poll loop (`pollStore`). Ingests settled captions, immediate chat, share-event markers, and pause markers. Persists log to localStorage. Relays to the copilot after persist and on every poll tick. |
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
| `src/copilot-relay.js` | Fire-and-forget POST of settled + pending lines to `http://localhost:7399/ingest`. No-ops if the copilot server is down. |

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

persistLog() / pollStore()
       │
       └── relayToCopilot() ──► localhost:7399 /ingest  (optional; pending + settled)
```

## ZT Copilot

Local companion for high-stakes meetings. Not part of the bookmarklet bundle.

| Piece | Role |
|-------|------|
| `copilot/server.js` | Node 18+ `http` server. Ingest, SSE, brief, on-demand ask, transcript Q&A, standing directives, card feedback, repeat suppression, Anthropic prompt caching, disk backup, stale-feed detection. |
| `copilot/public/index.html` | Suggestion-first page: On you list with copy-out, "do" vs. "say this" coaching cards with 👍 / 👎 / Mute topic, small-window prompter, ask box, collapsed transcript drawer, notifications + chime. |
| `copilot/config.json` | `apiKey`, `model`, `effort`, `myName`, `suggestIntervalMs` (default 20s), `minNewWords` (30), `suggestCooldownMs` (45s), `repeatWindowMs` (10 min), `maxTokens`, `port`. |
| `copilot/profile.md` | Optional personal context added to every prompt (gitignored). |

Typical meeting flow: `npm run copilot` → open `http://localhost:7399` → paste brief → bookmarklet in Zoom → watch the second screen.

The AI loop reads settled lines **and** in-flight pending captions (Zoom can take minutes to settle). It runs when enough new speech has arrived, or sooner when a chat message lands or someone says your name. Each card is coaching, not a recap: a **do** (how to handle the moment) and/or a line to **say** or ask out loud. Before a card is shown, the server drops repeats of a recent topic, near-identical rewordings, muted topics, and anything a standing directive excludes. Typing something like `stop mentioning the budget` in the ask box adds a standing directive for the rest of the meeting, and dismissing its card lifts it. The On you list at the top tracks what is directly on you and closes items as you answer them; Copy turns it into action items after the meeting. Shrink the window to 600px wide or less (for example, parked next to your camera) and it becomes a teleprompter: only the latest prompt, in large text, with everything else hidden. Settled lines are appended to `copilot/transcripts/` as they arrive. If the Zoom tab stops posting for ~30s, the page shows a feed-lost alarm.

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

After `npm run build`, commit and push `zoom-transcript.js` to `main`. The bookmarklet always loads that `main` artifact — local `src/` changes do nothing in a real Zoom meeting until they are built and pushed.

The copilot server is local-only. You do not deploy it. Restart `npm run copilot` after changing `copilot/server.js` or `config.json`.

## Known Zoom quirks

- **Draggable caption box** — mousedown on the widget can start a drag. Interactive controls use `shieldFromCaptionDrag()` / `shieldInputEvents()`.
- **Unstable chat IDs** — system/boilerplate messages lack `msgId`; deduped by message text via `isOneShotSystemMessage()`.
- **Chat receiver objects** — `chatReceiver` may be an object; use `resolveChatLabel()` not string concat.
- **CSS selectors on log keys** — never use `querySelector('[data-key="…"]')` with raw keys; match via `getAttribute()`.
