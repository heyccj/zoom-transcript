import { app, keys } from './state.js';
import { dedupLog, makeKey } from './dedup.js';
import { extractLines, extractChatLines } from './redux.js';
import { syncSeenFromLog, rebuildSpeakerStats } from './bookmarks.js';
import { ingestLines, ingestChatLines, pollStore, persistLog } from './ingest.js';
import { activeDoc } from './caption-panel.js';
import { updateUI } from './controls.js';
export function flushPending() {
  if (app.settleTimer) {
    clearTimeout(app.settleTimer);
    app.settleTimer = null;
  }
  app.pendingLines = null;
  pollStore();
  if (app.store) {
    try {
      let reduxState = app.store.getState();
      ingestLines(extractLines(reduxState));
      ingestChatLines(extractChatLines(reduxState));
    } catch (e) { /* ignore */ }
  }
  persistLog();
}

// Sorted speaker talk-time, mirroring the Stats tab.
export function talkTimeSummary() {
  let names = Object.keys(app.speakerStats);
  if (!names.length) return [];
  let total = 0;
  names.forEach(function (n) { total += app.speakerStats[n]; });
  names.sort(function (a, b) { return app.speakerStats[b] - app.speakerStats[a]; });
  return names.map(function (n) {
    let count = app.speakerStats[n];
    return {
      speaker: n,
      lines: count,
      pct: Math.round(count / total * 100)
    };
  });
}

export function formatOutput() {
  let lastSpeaker = null;
  let body = app.log.map(function (e) {
    let bookmarkLabel = app.bookmarkByKey.get(e.key);
    let parts = [];
    if (bookmarkLabel) parts.push('', '★ BOOKMARK: ' + bookmarkLabel);

    if (e.marker) {
      lastSpeaker = null;
      parts.push((e.time || '—') + '  ' + e.msg);
      return parts.join('\n');
    }
    let line = '';
    let label = e.name ? (e.chat ? e.name + ' · chat' : e.name) : null;
    if (label && label !== lastSpeaker) {
      line += '\n[' + label + ']\n';
      lastSpeaker = label;
    }
    line += (e.time || '—') + '  ' + (e.chat ? '[chat] ' : '') + e.msg;
    parts.push(line);
    return parts.join('\n');
  }).join('\n').trim();

  if (app.bookmarks.length) {
    body += '\n\n— Bookmarks —\n' + app.bookmarks.map(function (b) {
      return '★ ' + b.label + ' — ' + (b.time || '—') + ' · ' +
        (b.speaker || '—') + ' · ' + (b.preview || '');
    }).join('\n');
  }

  let stats = talkTimeSummary();
  if (stats.length) {
    body += '\n\n— Talk time —\n' + stats.map(function (s) {
      return s.speaker + ': ' + s.pct + '% (' + s.lines + (s.lines === 1 ? ' line' : ' lines') + ')';
    }).join('\n');
  }
  return body;
}

export function currentSessionName() {
  return app.sessionName || localStorage.getItem(keys.sessionKey) || '';
}

export function autoDownloadAlreadyHandled() {
  return localStorage.getItem(keys.autoDownloadKey) === keys.meetingId;
}

export function claimAutoDownload() {
  if (autoDownloadAlreadyHandled()) return false;
  localStorage.setItem(keys.autoDownloadKey, keys.meetingId);
  return true;
}

export function releaseAutoDownloadClaim() {
  if (localStorage.getItem(keys.autoDownloadKey) === keys.meetingId) {
    localStorage.removeItem(keys.autoDownloadKey);
  }
}

export function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function downloadFilename(ext) {
  let d = new Date();
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  let prefix = slugify(currentSessionName()) || 'captions';
  return prefix + '-' + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + '-' +
    pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + '.' + (ext || 'txt');
}

export function downloadJson() {
  flushPending();
  if (!app.log.length) {
    alert('No captions captured yet. Try __ztCaption.probe() in console.');
    return;
  }
  let payload = {
    session: currentSessionName() || null,
    exportedAt: new Date().toISOString(),
    talkTime: talkTimeSummary(),
    bookmarks: app.bookmarks.map(function (b) {
      return {
        id: b.id,
        label: b.label,
        entryKey: b.entryKey,
        time: b.time || null,
        speaker: b.speaker || null,
        preview: b.preview || null
      };
    }),
    entries: app.log.map(function (e) {
      return {
        time: e.time || null,
        speaker: e.name || null,
        text: e.msg,
        marker: !!e.marker,
        chat: !!e.chat,
        bookmark: app.bookmarkByKey.get(e.key) || null
      };
    })
  };
  let a = activeDoc().createElement('a');
  a.href = 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(payload, null, 2));
  a.download = downloadFilename('json');
  a.click();
  console.info('[ZT Captions] Downloaded JSON export.');
}

export function downloadCaptions(options) {
  options = options || {};
  let isAuto = !!options.auto;
  let reason = options.reason || 'manual';

  if (isAuto) {
    if (!claimAutoDownload()) {
      console.info('[ZT Captions] Auto-download already handled for this meeting.');
      return false;
    }
  }

  flushPending();
  let text = formatOutput();
  if (!text) {
    if (isAuto) releaseAutoDownloadClaim();
    if (!isAuto) alert('No captions captured yet. Try __ztCaption.probe() in console.');
    return false;
  }

  let a = activeDoc().createElement('a');
  a.href = 'data:text/plain;charset=utf-8,' + encodeURIComponent(text);
  a.download = downloadFilename();
  a.click();

  if (isAuto) {
    resetLog();
    localStorage.removeItem(keys.meetingKey);
    console.info('[ZT Captions] Downloaded captions (' + reason + ') — app.log cleared for next meeting.');
  } else {
    console.info('[ZT Captions] Downloaded captions (' + reason + ').');
  }
  return true;
}

export function findMeetingExitButton(target) {
  if (!target || !target.closest) return null;
  let endBtn = target.closest('button[aria-label="End"]');
  if (endBtn) return { btn: endBtn, reason: 'end-button' };
  let leaveBtn = target.closest('button[aria-label="Leave"]');
  if (leaveBtn) return { btn: leaveBtn, reason: 'leave-button' };
  let footerBtn = target.closest('button.footer-button__button, button.footer-button-base__button');
  if (footerBtn) {
    let label = ((footerBtn.getAttribute('aria-label') || '') + ' ' + (footerBtn.textContent || '')).trim();
    if (/^end$/i.test(label)) return { btn: footerBtn, reason: 'end-button' };
    if (/^leave$/i.test(label)) return { btn: footerBtn, reason: 'leave-button' };
  }
  return null;
}

export function hasTranscriptToSave() {
  if (app.log.length) return true;
  return !!(app.pendingLines && app.pendingLines.length);
}

export function teardownAutoDownloadHooks() {
  if (app.autoDownloadDoc && app.meetingExitClickHandler) {
    app.autoDownloadDoc.removeEventListener('click', app.meetingExitClickHandler, true);
  }
  if (app.hostEndedObserver) app.hostEndedObserver.disconnect();
  if (app.hostEndedTimer) clearTimeout(app.hostEndedTimer);
  if (app.autoDownloadWin) {
    if (app.tabCloseBeforeUnloadHandler) {
      app.autoDownloadWin.removeEventListener('beforeunload', app.tabCloseBeforeUnloadHandler);
    }
    if (app.tabClosePageHideHandler) {
      app.autoDownloadWin.removeEventListener('pagehide', app.tabClosePageHideHandler);
    }
  }
  app.autoDownloadDoc = null;
  app.autoDownloadWin = null;
  app.meetingExitClickHandler = null;
  app.tabCloseBeforeUnloadHandler = null;
  app.tabClosePageHideHandler = null;
  app.hostEndedObserver = null;
  app.hostEndedTimer = null;
  app.hostEndedTriggered = false;
}

export function setupAutoDownloadHooks(doc) {
  if (!doc || !doc.body || app.autoDownloadDoc === doc) return;
  teardownAutoDownloadHooks();

  app.meetingExitClickHandler = function (e) {
    let hit = findMeetingExitButton(e.target);
    if (hit) downloadCaptions({ auto: true, reason: hit.reason });
  };
  doc.addEventListener('click', app.meetingExitClickHandler, true);

  app.hostEndedObserver = new MutationObserver(function () {
    if (app.hostEndedTriggered || autoDownloadAlreadyHandled()) return;
    let nodes = doc.querySelectorAll(
      '.zm-modal-body-title, .zm-modal-body-content, .confirm-modal-content, [role="dialog"]'
    );
    for (let i = 0; i < nodes.length; i++) {
      let t = nodes[i].textContent || '';
      if (/meeting has been ended by the host/i.test(t) || /ended by host/i.test(t)) {
        if (app.hostEndedTimer) clearTimeout(app.hostEndedTimer);
        app.hostEndedTimer = setTimeout(function () {
          app.hostEndedTimer = null;
          if (app.hostEndedTriggered || autoDownloadAlreadyHandled()) return;
          app.hostEndedTriggered = true;
          downloadCaptions({ auto: true, reason: 'host-ended' });
        }, 400);
        return;
      }
    }
  });
  app.hostEndedObserver.observe(doc.body, { childList: true, subtree: true });

  // Warn on tab/window close when captions haven't been saved yet; auto-download
  // on actual unload (pagehide). beforeunload can't run custom downloads in
  // modern Chrome, but pagehide still gets a best-effort save attempt.
  let win = doc.defaultView;
  if (win) {
    app.tabCloseBeforeUnloadHandler = function (e) {
      if (autoDownloadAlreadyHandled() || !hasTranscriptToSave()) return;
      e.preventDefault();
      e.returnValue = '';
    };
    app.tabClosePageHideHandler = function (e) {
      if (e.persisted || autoDownloadAlreadyHandled()) return;
      flushPending();
      if (!hasTranscriptToSave()) return;
      downloadCaptions({ auto: true, reason: 'tab-close' });
    };
    win.addEventListener('beforeunload', app.tabCloseBeforeUnloadHandler);
    win.addEventListener('pagehide', app.tabClosePageHideHandler);
    app.autoDownloadWin = win;
  }

  app.autoDownloadDoc = doc;
}

export function resetLog() {
  if (app.settleTimer) {
    clearTimeout(app.settleTimer);
    app.settleTimer = null;
  }
  app.pendingLines = null;
  app.log = [];
  app.seen = new Set();
  app.pauseSkipped = new Set();
  app.lastSnapshot = '';
  app.renderedLogCount = 0;
  app.lastRenderedSpeaker = null;
  app.speakerColorMap = {};
  app.speakerColorIdx = 0;
  app.speakerStats = {};
  app.prevSharers = null;
  app.elapsedStart = null;
  if (app.elapsedTimer) {
    clearInterval(app.elapsedTimer);
    app.elapsedTimer = null;
  }
  localStorage.removeItem(keys.storageKey);
  localStorage.removeItem(keys.bookmarksKey);
  app.bookmarks = [];
  app.bookmarkByKey = new Map();
  app.bookmarkMode = false;
  if (app.ui && app.ui.settledEl) app.ui.settledEl.innerHTML = '';
  if (app.ui && app.ui.pendingEl) app.ui.pendingEl.innerHTML = '';
  updateUI();
}
