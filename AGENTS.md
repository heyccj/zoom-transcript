# AGENTS.md — ZT Captions (zoom-transcript)

Guide for AI coding agents working on this repository.

## What this is

A **vanilla ES-module bookmarklet** (no React/Vue) bundled with esbuild into a single IIFE (`zoom-transcript.js`). It runs inside the Zoom web client, reads captions and chat from Zoom's internal Redux store, and renders a transcript panel in the DOM. An optional localhost sidecar (`copilot/`) streams that transcript to a second-screen AI page.

**Do not** add npm runtime dependencies — the bundle must stay a single self-contained file loadable from a CDN. The copilot server is the same rule: Node 18+ built-ins only.

## Build

```bash
npm run build    # src/index.js → zoom-transcript.js (with UTC banner comment)
npm run watch    # rebuild on save
npm run copilot  # localhost AI companion → http://localhost:7399 (not bundled)
```

Always run `npm run build` after `src/` changes. The deployed artifact is `zoom-transcript.js` — commit it when pushing fixes users will load via bookmarklet. Restart `npm run copilot` after changing `copilot/server.js` or `copilot/config.json`.

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
- **`app.copilotConnected` / `app.copilotSentCount`** — relay status; reset in `resetLog()` and `shutdown()`.

### Poll loop (`ingest.js` → `pollStore`)

Every `POLL_MS` (800ms):

1. Find/hold Redux store (`redux.js` → `findReduxStore`)
2. Ingest chat immediately (`extractChatLines` → `ingestChatLines`)
3. Track screen-share start/stop markers
4. Snapshot caption lines; if changed, reset `SETTLE_MS` (3000ms) timer
5. On settle: `ingestLines` → `persistLog` → `updateUI` → `relayToCopilot()`
6. Every tick also calls `relayToCopilot()` so in-flight pending captions (and heartbeats) reach the copilot without waiting for settle — Zoom can hold lines pending for minutes.

Chat path has **no settle delay**. Caption path does. Copilot relay is fire-and-forget on both paths.

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
| Copilot relay (transcript → localhost) | `copilot-relay.js` |
| Copilot server + AI suggestions | `copilot/server.js` (not bundled) |
| Copilot page UI | `copilot/public/index.html` (not bundled) |

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

### 8. Copilot relay must stay a CORS simple request

`copilot-relay.js` POSTs `text/plain` to localhost from the zoom.us origin. Changing the content type to `application/json`, adding custom headers, or using a method other than POST will trigger a preflight that Zoom's CSP may block. Keep the body JSON-as-text.

## Copilot companion app (`copilot/`)

Optional localhost sidecar (`npm run copilot` → `http://localhost:7399`) that receives the live transcript and shows AI suggestions on a second screen. **Zero npm deps** (Node 18+ built-ins only) — same rule as the bundle.

### Bookmarklet side

- `src/copilot-relay.js` fires from `pollStore` (pending captions + heartbeats) and `persistLog` (settled entries). Entirely fire-and-forget; if the server is down the recorder is unaffected.
- Uses `Content-Type: text/plain` so the POST stays a CORS simple request (no preflight). Do not switch this to `application/json`.
- Server dedupes by entry key, so re-sending is always safe. `/ingest` replies `{have: n}`; the relay resets `copilotSentCount` and resends everything when the server restarts mid-meeting.
- Panel header shows a green **AI** badge when `app.copilotConnected` is true (`ui-mount.js` / `controls.js`). `__ztCaption.probe()` reports `copilot: { connected, sentEntries, lastTryAt }`.

### Server

| Route | Purpose |
|-------|---------|
| `POST /ingest` | Settled `entries` + current `pending` snapshot from the bookmarklet |
| `GET /events` | SSE: init + live entries, pending, On you list, suggestions, held-back count, directives, feedback, Q&A, stale/live status |
| `POST /brief` | Save meeting objectives (also written to `copilot/brief.json`). Accepts JSON `{text}` or a raw text body (`curl --data-binary @brief.md`) |
| `POST /ask` | Immediate suggestion cycle (bypasses the interval and the cooldown, not repeat/mute checks) |
| `POST /query` | Free-form question against the live transcript. Steering text (`stop mentioning X`, `don't …`, `focus on …`, no trailing `?`) becomes a standing directive instead |
| `POST /feedback` | `{id, verdict: up\|down\|mute}` on a shown suggestion |
| `POST /directive` | `{remove: id}` lifts a standing directive |
| `POST /vault` | `{dismiss: slug}` stops using a loaded note (false match) |
| `GET /` | Serves `copilot/public/index.html` |

- Config: `copilot/config.json` (gitignored — copy `config.example.json`) or `ANTHROPIC_API_KEY`. Fields: `apiKey`, `model` (example uses `claude-haiku-5-5`), `effort` (optional; sends `output_config.effort` and raises `max_tokens` for thinking headroom. Leave unset on `claude-haiku-4-5`, which rejects it), `myName`, `suggestIntervalMs` (default 20000), `minNewWords` (30), `suggestCooldownMs` (45000), `repeatWindowMs` (600000), `maxTokens`, `port`. `vaultPath`, `vaultExclude` (slugs), `vaultAliases` (`{"spoken name": "slug"}`). `PORT`, `MODEL`, and `EFFORT` env vars override config (handy for side-by-side test instances).
- Personal context: optional `copilot/profile.md` (gitignored, see `profile.example.md`) is added to the cached system prompt as "ABOUT THE USER". Read once at startup. The repo is public, so personal details go there, never in `server.js`.
- **Vault context** (optional, `vaultPath` in config): a notes folder laid out as `<vaultPath>/projects/<slug>/_PROJECT.md`. Only those files are read; `vaultExclude` drops slugs. At startup `loadVaultIndex()` builds aliases per project from the slug, the H1 title, parenthetical acronyms, an optional `aliases:` frontmatter line, `vaultAliases` in config, and capitalized mishearings from `<vaultPath>/_GLOSSARY.md`. Acronyms of 3 letters or fewer match only in capitals. When the brief or a settled line names a project, `vaultExcerpt()` (overview, newest status, risks, open items; ≤5000 chars) is **appended to `settledText`** as a `[vault]` block, never inserted earlier, so caching holds. Max 15 project notes per meeting. Two more sources: a `NOTES:` line in the brief names up to 6 vault-relative `.md` paths to read in full (≤12000 chars each), and **people notes** in `projects/management/` (`1-1_<person>.md`, `1-1-practice_<person>.md`, `<date>_<person>-1-1-prep.md`) load when that person first speaks (max 3; one-word names prefix-match the first name, so `volt` matches "Voltaire"; `vaultPeople` maps a Zoom name to a person slug). `readVaultFile()` refuses anything outside `vaultPath`, non-markdown, any filename containing key/secret/credential/password/token, and any file whose content looks like an API key or private key. No privacy filtering beyond that, by design: the page is the user's own second screen. Dismissing appends a retraction line rather than removing text. Cards can cite a loaded note via `SOURCE:`. Brief-triggered notes are re-scanned after `resetMeeting()`.
- Settled lines append to `copilot/transcripts/` as they arrive. Pending lines are not written until settled.
- If no `/ingest` for ~30s while a meeting is active, the page shows a stale-feed alarm.
- AI loop: one in-flight call at a time. A routine cycle needs `suggestIntervalMs` elapsed **and** `minNewWords` of new speech (settled + pending). Do not trigger on "pending changed": pending captions change on nearly every poll, which is what caused a card every ~10s in the first live test. A chat message, the user's first name in a settled line from someone else, or the user voicing uncertainty while a vault note is loaded (`UNCERTAINTY_RE`) sets a fast trigger (5s minimum gap). The full path a reply takes from model output to the page is mapped in the comment above `runSuggestionCycle()`. Read that before changing the loop.
- Suggestion reply format: one model call carrying two independent jobs, each of which may be NONE while the other is not. **CARD**: `URGENCY` (`none|info|act-now|answer`) / `TOPIC` (kebab slug) / `DO` (instruction starting with a verb) / `SAY` (words to say out loud) / `SOURCE` (the `[vault]` note id a card leans on). **LEDGER**: `ADD` (`asked|proposed|committed | text | who`, up to two lines) / `CLOSE` (ids of answered items). The format and the volatile per-cycle levers live in the loop's uncached tail; the durable "when to speak" policy lives **once** in the cached system prompt (`baseSystemBlocks()`), which the tail points back to rather than restating. `/query` answers reuse the system prompt but not the card format.
- Cards are coaching, never recaps: the user heard the meeting. `isRecap()` drops a DO that starts like a description ("Greg is asking…", "Steve's raising…"). The one exception is an `answer` card: when the user voices uncertainty about a fact a loaded `[vault]` note settles, the card states that fact in `SAY`, cites the note in `SOURCE`, skips `isRecap()`, and renders violet as "From your notes". It requires a loaded-note `SOURCE` or it falls back to `info`. The tail includes `speakingStats()` (user's share of words in the last 3 min, when they last spoke) so behavior tips rest on numbers.
- Suggestions are **not streamed** to the page: `holdBackReason()` checks the finished reply first. It drops: text containing a directive's phrase, muted topics, a similar topic slug or ≥50% content-word overlap with any card shown within `repeatWindowMs`, card text that overlaps an On you item, and `info` cards within `suggestCooldownMs` of the last card (`act-now` and `answer` skip the cooldown so they land while the moment is live). `act-now` is downgraded to `info` unless someone else said the user's name or asked a question in the last 60s (or in pending captions), and at most one `act-now` per 90s. Held-back replies are logged to the server console and counted on the page. The model rephrases rather than repeats, so the prompt's "do not repeat" alone does not work.
- **On you list** (`state.onYou`, replaced the old LLM "meeting pulse"): items directly on the user. `asked` and `proposed` start open and close via `CLOSE`; `committed` items stay as action items. `applyOnYou()` dedupes same-kind items at ≥50% content-word overlap. A new `asked` item fires the Notification + chime. Broadcast as `onyou` with the full list.
- Two prompts share the same cached system + profile + brief + settled-transcript prefix (`baseSystemBlocks()` + `transcriptBlocks()`). The settled-transcript block must stay **append-only** or prompt caching breaks.

### Page (`copilot/public/index.html`)

Suggestion-first, dark UI. **On you** strip at top (kind label, text, who; open asked items in amber, answered items struck through; Copy button exports them as action items; meta line shows held-back count and AI errors). Urgency-styled cards (`info` / `act-now` / `answer` shown violet as "From your notes" / `/query` answers / standing instructions). Suggestion cards show DO as plain text and SAY as a green quote block, with 👍 / 👎 / Mute topic buttons. Dismissing a standing-instruction card removes the directive. A chip row under the header lists loaded vault notes (✕ dismisses one), and cards that rely on a note show "from your notes · Name". The brief box has **Copy prep prompt**: a prompt to paste into Claude Code running in the notes folder, which drafts a brief (GOAL / ON ME / RAISE / FACTS / PEOPLE / WATCH) and POSTs it to `/brief`. Blank ask box + Nudge now. Transcript is a collapsed footer drawer, not a fixed column. `act-now` cards and new `asked` items fire a Notification + optional chime.

**Prompter mode** (`@media (max-width: 600px)`): for a small window parked by the camera. Everything hides except `#prompter`, which shows the latest card (DO white, SAY green in quotes) or a new `asked` item (amber), auto-sized by `fitPrompt()`. Prompts dim after 60s. The stale-feed banner and AI errors still show. Chrome windows can't go much below ~500px wide, so headless screenshots at 400px are cropped, not reflowed; test at ~560px.

### Testing without Zoom

`npm run copilot`, serve the repo (`python3 -m http.server 7400`), open `test-harness.html` — captions flow end-to-end into the copilot page.

## Entry key formats

| Pattern | Example | Used for |
|---------|---------|----------|
| `{time}\|{name}\|{msg40}` | `14:05\|Chris\|Hello` | Captions |
| `sys\|{full msg}` | `sys\|Chris joined as a guest` | One-shot system messages |
| `chat\|{chatId}` | `chat\|abc123` | Chat with server ID |
| `chat-content\|{name}\|{text}` | chat fallback | Chat without server ID |

## Debugging in Zoom

```js
__ztCaption.probe()              // attachment + redux state summary + copilot connectivity
__ztCaption.debugPending(true)   // pending render diagnostics
__ztCaption.getLog()             // raw log array
```

Redux probe details: `probeState()` in `redux.js`. `probe().copilot` is `{ connected, sentEntries, lastTryAt }`.

Local UI testing without Zoom: open `test-harness.html`. For copilot, also run `npm run copilot`.

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
- [ ] With `npm run copilot` running, green **AI** badge appears and `__ztCaption.probe().copilot.connected` is true
- [ ] Without the copilot server, the recorder still captures / copies / downloads (relay fails silently)
- [ ] Copilot page: pending lines appear quickly, On you items appear once and close when answered, stale banner appears if the Zoom tab stops posting
- [ ] Copilot cards: no card leads with the user's name, the same topic does not come back reworded, 👍/👎/Mute update the card, `stop mentioning X` in the ask box shows a standing-instruction card and X stops appearing

## Files not to edit casually

- `zoom-transcript.js` — generated; edit `src/` and rebuild
- `package-lock.json` — only when adding deps (avoid)
- `index.html` — marketing site; unrelated to recorder logic unless updating bookmarklet URL
- `copilot/config.json` / `copilot/brief.json` / `copilot/profile.md` / `copilot/transcripts/` — local secrets, personal context, and meeting data; gitignored, never commit

## Adding a new one-shot system message pattern

Edit `isOneShotSystemMessage()` in `dedup.js`. Use broad but specific regex — Zoom boilerplate persists in Redux and will spam without stable IDs.

## Adding a new UI control

1. Add HTML in `ui-mount.js` `createMount()`
2. Cache ref in `ensureUiRefs()` (`ui-core.js`)
3. Wire handler in `wireMountEvents()` (`ui-core.js`)
4. Style in `styles.js`
5. If clickable, apply `shieldFromCaptionDrag()`
