import { app, keys } from './state.js';
import { makeKey } from './dedup.js';

// Streams the transcript to the local ZT Copilot companion app
// (`npm run copilot` → http://localhost:7399). Entirely fire-and-forget:
// if the server isn't running, the recorder behaves exactly as before.

const COPILOT_BASE = 'http://localhost:7399';
const RETRY_MS = 15000;      // reconnect attempts while server unreachable
const HEARTBEAT_MS = 10000;  // keepalive posts while connected but idle
const POST_TIMEOUT_MS = 2500;

let inFlight = false;
let dirty = false;
let warnedOnce = false;

function entryPayload(e) {
  return {
    key: e.key,
    time: e.time || '',
    name: e.name || null,
    msg: e.msg,
    chat: !!e.chat,
    marker: !!e.marker
  };
}

// Current in-flight caption lines, minus anything already settled into the log.
function pendingPayload() {
  if (app.paused || !app.pendingLines || !app.pendingLines.length) return [];
  let rows = [];
  app.pendingLines.forEach(function (l) {
    if (!l || !l.msg) return;
    if (app.seen.has(makeKey(l.time, l.name, l.msg))) return;
    rows.push({ time: l.time || '', name: l.name || null, msg: l.msg });
  });
  return rows;
}

export function relayToCopilot() {
  if (inFlight) {
    dirty = true;
    return;
  }
  if (!app.copilotConnected && app.copilotLastTryAt &&
      Date.now() - app.copilotLastTryAt < RETRY_MS) {
    return;
  }

  // dedupLog can shrink app.log; never let the cursor point past the end.
  if (app.copilotSentCount > app.log.length) app.copilotSentCount = app.log.length;

  let newEntries = app.log.slice(app.copilotSentCount);
  let pending = pendingPayload();
  let pendingSnapshot = JSON.stringify(pending);
  let pendingChanged = pendingSnapshot !== app.copilotPendingSnapshot;

  // Nothing new and recently talked to the server → skip (heartbeat cadence).
  if (!newEntries.length && !pendingChanged && app.copilotConnected &&
      Date.now() - app.copilotLastTryAt < HEARTBEAT_MS) {
    return;
  }

  let sentUpTo = app.log.length;
  let body = JSON.stringify({
    meetingId: keys.meetingId,
    session: app.sessionName || null,
    entries: newEntries.map(entryPayload),
    pending: pending
  });

  inFlight = true;
  app.copilotLastTryAt = Date.now();
  let ctrl = new AbortController();
  let timer = setTimeout(function () { ctrl.abort(); }, POST_TIMEOUT_MS);

  fetch(COPILOT_BASE + '/ingest', {
    method: 'POST',
    // text/plain keeps this a CORS "simple request" (no preflight).
    headers: { 'Content-Type': 'text/plain' },
    body: body,
    signal: ctrl.signal
  }).then(function (r) {
    return r.json();
  }).then(function (resp) {
    clearTimeout(timer);
    inFlight = false;
    app.copilotConnected = true;
    app.copilotSentCount = sentUpTo;
    app.copilotPendingSnapshot = pendingSnapshot;
    warnedOnce = false;
    // Server restarted and lost history → resend the full log (it dedupes by key).
    if (resp && typeof resp.have === 'number' && resp.have < app.copilotSentCount) {
      app.copilotSentCount = 0;
      dirty = true;
    }
    if (!app.copilotAnnounced) {
      app.copilotAnnounced = true;
      console.info('[ZT Captions] Copilot connected — transcript streaming to ' + COPILOT_BASE);
    }
    if (dirty) {
      dirty = false;
      relayToCopilot();
    }
  }).catch(function () {
    clearTimeout(timer);
    inFlight = false;
    dirty = false;
    if (app.copilotConnected) {
      console.info('[ZT Captions] Copilot server connection lost — will keep retrying.');
      app.copilotAnnounced = false;
    }
    app.copilotConnected = false;
    if (!warnedOnce) {
      warnedOnce = true;
      console.info('[ZT Captions] Copilot server not running (optional — `npm run copilot` enables AI suggestions).');
    }
  });
}
