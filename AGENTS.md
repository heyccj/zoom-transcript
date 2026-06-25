# AGENTS.md — ZT Captions (zoom-transcript)

Guide for AI coding agents working on this repository.

## What this is

A **vanilla ES-module bookmarklet** (no React/Vue) bundled with esbuild into a single IIFE (`zoom-transcript.js`). It runs inside the Zoom web client, reads captions and chat from Zoom's internal Redux store, and renders a transcript panel in the DOM.

**Do not** add npm runtime dependencies — the bundle must stay a single self-contained file loadable from a CDN.

## Build

```bash
npm run build   # src/index.js → zoom-transcript.js (with UTC banner comment)
npm run watch   # rebuild on save
```

Always run `npm run build` after source changes. The deployed artifact is `zoom-transcript.js` — commit it when pushing fixes users will load via bookmarklet.

## Architecture

### Execution contexts

1. **Webclient iframe** — primary recorder. Poll loop runs here; Redux store is accessible.
2. **Parent shell** — bookmarklet may load here first. `index.js` re-injects the script into `#webclient` via `inject.js` and exposes a proxy `__ztCaption` API.

Use `getWebclientWindow()` / `activeDoc()` — never assume `window` or `document` is the meeting frame.

### State

- **`app`** (`state.js`) — single mutable singleton. All modules import it.
- **`app.log`** — committed transcript entries.
- **`app.seen`** — `Set` of entry keys already ingested (dedup guard).
- **`app.pendingLines`** — latest caption snapshot awaiting settle.
- **`app.ui`** — cached DOM refs, populated by `ensureUiRefs()`.

### Poll loop (`ingest.js` → `pollStore`)

Every `POLL_MS` (800ms):

1. Find/hold Redux store (`redux.js` → `findReduxStore`)
2. Ingest chat immediately (`extractChatLines` → `ingestChatLines`)
3. Track screen-share start/stop markers
4. Snapshot caption lines; if changed, reset `SETTLE_MS` (3000ms) timer
5. On settle: `ingestLines` → `persistLog` → `updateUI`

Chat path has **no settle delay**. Caption path does.

### UI update chain

```
updateUI() [controls.js]
  → watchCaptionPanel() [ui-mount.js]
  → renderLogItems()     settled entries
  → renderPendingItems() in-flight captions
  → syncIdle(), renderStats(), updatePill()
```

Rendering is incremental for settled log (`app.renderedLogCount`). Pending area is fully rebuilt each poll.

### CSS

All styles injected via `ensureStyles(doc)` in `styles.js`. Class prefix: `__zt-`. Theme toggle adds `__zt-dark` on mount/pill/dock.

## Module map (where to edit what)

| Task | File(s) |
|------|---------|
| Poll timing, ingest logic | `ingest.js`, `constants.js` |
| Dedup keys, system message patterns | `dedup.js` |
| Redux/caption/chat extraction | `redux.js` |
| Caption box DOM, auto-enable captions | `caption-panel.js` |
| Panel HTML, attach to Zoom | `ui-mount.js` |
| Button wiring, resize handles | `ui-core.js` |
| Pause, tabs, collapse, updateUI | `controls.js` |
| Log rendering, pending, stats, search | `render.js` |
| Bookmarks | `bookmarks.js` |
| Export, auto-download | `export.js` |
| Visual styling | `styles.js` |
| iframe inject | `inject.js`, `meeting.js` |
| Boot, debug API | `index.js` |
| Event propagation fixes | `utils.js` |

## Conventions

- **ES modules** with `.js` import paths (including in source).
- **No TypeScript** — plain JS matching existing style (functions, `app` singleton, minimal classes).
- **HTML in templates** — `ui-mount.js` builds markup via string arrays joined with `''`.
- **Console prefix** — `[ZT Captions]` for all user-visible logs.
- **Minimize scope** — small focused diffs; match surrounding patterns.
- **Don't over-abstract** — prefer inline logic over one-off helpers.

## Common pitfalls (read before changing)

### 1. Zoom draggable caption box steals clicks

Zoom's caption panel uses react-draggable. `mousedown` bubbles up and starts a drag.

- Search input: `shieldInputEvents()`
- Bookmark button: `shieldFromCaptionDrag()`
- Bookmark placement: `mousedown` + `stopPropagation` in bookmark mode
- **Do not** shield the entire mount — breaks dragging the box

### 2. Dedup / spam loops

Zoom keeps boilerplate chat messages in state without stable IDs. Each poll used to look like a new message.

- `isOneShotSystemMessage()` — join/leave, Team Chat notices → key `sys|{full message}`
- Chat fallback ID: `chatFallbackId(name, text)` — no timestamp
- Never use `Date.now()` as fallback time for dedup keys
- `chatMessageId()` must return stable IDs; use `makeKey(null, null, text)` for system messages

### 3. `[object Object]` in chat

`thread.chatReceiver` / `thread.receiver` may be objects. Always resolve via `resolveChatLabel()` before string concat.

### 4. Invalid CSS selectors on log keys

Log entry keys can contain newlines and special characters. **Never**:

```js
querySelector('[data-key="' + key + '"]')  // BAD
```

Use `getAttribute('data-key')` comparison on iterated elements (see `render.js`).

### 5. Speaker name flashing (pending render)

`renderPendingItems()` clears and rebuilds `#__zt-pending` every poll. The `continued` flag hides speaker headers for consecutive same-speaker lines. Flashing likely comes from:

- `line.name` flickering null ↔ string from Zoom
- Multiple pending lines for progressive caption chunks
- `continued` toggling → header show/hide

Debug: `__ztCaption.debugPending(true)` — watch for `pending flash?` warnings.

### 6. Parent shell vs iframe

Changes to `__ztCaption` API must be mirrored in both the webclient boot object and the parent-shell proxy in `index.js`.

### 7. Rendered log incremental counter

`app.renderedLogCount` tracks how many `app.log` entries are in the DOM. Reset it when clearing `settledEl` (theme toggle, shutdown). Forgetting this causes skipped or duplicate DOM nodes.

## Entry key formats

| Pattern | Example | Used for |
|---------|---------|----------|
| `{time}\|{name}\|{msg40}` | `14:05\|Chris\|Hello` | Captions |
| `sys\|{full msg}` | `sys\|Chris joined as a guest` | One-shot system messages |
| `chat\|{chatId}` | `chat\|abc123` | Chat with server ID |
| `chat-content\|{name}\|{text}` | chat fallback | Chat without server ID |

## Debugging in Zoom

```js
__ztCaption.probe()              // attachment + redux state summary
__ztCaption.debugPending(true)   // pending render diagnostics
__ztCaption.getLog()             // raw log array
```

Redux probe details: `probeState()` in `redux.js`.

Local UI testing without Zoom: open `test-harness.html`.

## Testing checklist

After changes, verify:

- [ ] `npm run build` succeeds
- [ ] Bookmarklet loads fresh bundle (check banner timestamp at top of `zoom-transcript.js`)
- [ ] Captions appear in log after speaking
- [ ] Chat messages appear once (no spam)
- [ ] System notices (join, Team Chat boilerplate) appear once
- [ ] Bookmark button clickable (not stolen by drag)
- [ ] Copy / download output correct
- [ ] No `querySelector` errors in console for multiline messages

## Files not to edit casually

- `zoom-transcript.js` — generated; edit `src/` and rebuild
- `package-lock.json` — only when adding deps (avoid)
- `index.html` — marketing site; unrelated to recorder logic unless updating bookmarklet URL

## Adding a new one-shot system message pattern

Edit `isOneShotSystemMessage()` in `dedup.js`. Use broad but specific regex — Zoom boilerplate persists in Redux and will spam without stable IDs.

## Adding a new UI control

1. Add HTML in `ui-mount.js` `createMount()`
2. Cache ref in `ensureUiRefs()` (`ui-core.js`)
3. Wire handler in `wireMountEvents()` (`ui-core.js`)
4. Style in `styles.js`
5. If clickable, apply `shieldFromCaptionDrag()`
