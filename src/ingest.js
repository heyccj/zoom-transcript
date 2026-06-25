import { app, keys } from './state.js';
import { SETTLE_MS, MAX_INJECT_RETRIES } from './constants.js';
import { makeKey, isOneShotSystemMessage } from './dedup.js';
import { getWebclientWindow, isParentShell } from './meeting.js';
import { findReduxStore, extractLines, extractChatLines, activeSharerMap, formatTime } from './redux.js';
import { syncSeenFromLog, rebuildSpeakerStats } from './bookmarks.js';
import { dedupLog } from './dedup.js';
import { tryInjectIntoIframe } from './inject.js';
import { updateUI } from './controls.js';
import { startElapsed } from './render.js';
export function persistLog() {
  app.log = dedupLog(app.log);
  syncSeenFromLog();
  rebuildSpeakerStats();
  if (app.log.length) {
    localStorage.setItem(keys.storageKey, JSON.stringify(app.log));
  }
  updateUI();
}

export function ingestLines(lines) {
  if (app.paused) return 0;
  let added = 0;
  lines.forEach(function (line) {
    let key = makeKey(line.time, line.name, line.msg);
    if (app.seen.has(key)) return;
    app.seen.add(key);
    added++;
    app.log.push({
      key: key,
      time: line.time || formatTime(Date.now()),
      name: line.name,
      msg: line.msg,
      src: line.src
    });
  });
  if (added) startElapsed();
  return added;
}

export function ingestChatLines(lines) {
  if (app.paused) return 0;
  let added = 0;
  lines.forEach(function (line) {
    let key = isOneShotSystemMessage(line.msg)
      ? makeKey(line.time, line.name, line.msg)
      : 'chat|' + line.chatId;
    if (app.seen.has(key)) return;
    app.seen.add(key);
    added++;
    app.log.push({
      key: key,
      time: line.time || formatTime(Date.now()),
      name: line.name,
      msg: line.msg,
      src: line.src,
      chat: true
    });
  });
  if (added) {
    startElapsed();
    persistLog();
  }
  return added;
}

export function trackChatMessages(reduxState) {
  ingestChatLines(extractChatLines(reduxState));
}

app.prevSharers = null;

export function addMarker(text, src) {
  let time = formatTime(Date.now());
  let msg = '— ' + text + ' —';
  let key = makeKey(time, null, msg);
  if (app.seen.has(key)) return;
  app.seen.add(key);
  app.log.push({
    key: key,
    time: time,
    name: null,
    msg: msg,
    src: src,
    marker: true
  });
  persistLog();
}

export function addShareMarker(text) {
  if (app.paused) return;
  addMarker(text, 'share-event');
}

export function trackShareEvents(reduxState) {
  let cur;
  try {
    cur = activeSharerMap(reduxState);
  } catch (e) {
    return;
  }

  if (app.prevSharers === null) {
    app.prevSharers = cur;
    return;
  }

  Object.keys(cur).forEach(function (id) {
    if (!(id in app.prevSharers)) {
      addShareMarker(cur[id] + ' started sharing their screen');
    }
  });
  Object.keys(app.prevSharers).forEach(function (id) {
    if (!(id in cur)) {
      addShareMarker((app.prevSharers[id] || 'Someone') + ' stopped sharing');
    }
  });

  app.prevSharers = cur;
}

export function pollStore() {
  app.pollCount++;
  app.wcWin = getWebclientWindow();

  if (!app.store) {
    app.store = findReduxStore(app.wcWin.document);
    if (!app.store && isParentShell() && app.pendingInjectSource && app.injectRetries < MAX_INJECT_RETRIES) {
      app.injectRetries++;
      tryInjectIntoIframe(app.pendingInjectSource);
    }
    if (!app.store) {
      updateUI();
      return;
    }
    console.info('[ZT Captions] Redux store found.');
    updateUI();
  }

  let reduxState;
    try {
      reduxState = app.store.getState();
  } catch (e) {
    app.store = null;
    updateUI();
    return;
  }

  trackShareEvents(reduxState);
  trackChatMessages(reduxState);

  if (!app.paused) {
    let lines = extractLines(reduxState);
    let snapshot = JSON.stringify(lines.map(function (l) {
      return [l.time, l.name, l.msg, l.finished];
    }));

    if (snapshot !== app.lastSnapshot) {
      app.lastSnapshot = snapshot;
      app.pendingLines = lines;
      if (app.settleTimer) clearTimeout(app.settleTimer);
      updateUI();
      app.settleTimer = setTimeout(function () {
        app.settleTimer = null;
        ingestLines(lines);
        app.pendingLines = null;
        persistLog();
      }, SETTLE_MS);
    }
  }

  if (app.store) updateUI();
}
