import { app } from './state.js';
import { makeKey } from './dedup.js';
import { escapeHtml } from './utils.js';
import { getSpeakerColor, syncBookmarkMarkers } from './bookmarks.js';
import { updatePill } from './controls.js';
export function buildEntryNode(doc, e, continued, pending) {
  let item = doc.createElement('div');
  let cls = '__zt-entry';
  if (e.marker) cls += ' __zt-entry--marker';
  if (e.chat) cls += ' __zt-entry--chat';
  if (pending) cls += ' __zt-entry--pending';
  if (continued) cls += ' __zt-entry--continued';
  else if (!e.marker) cls += ' __zt-entry--run-head';
  item.className = cls;
  item.setAttribute('data-key', e.key || '');
  if (e.name) item.setAttribute('data-name', e.name);

  let timeHtml = '<span class="__zt-entry-time">' + escapeHtml(e.time || '—') + '</span>';
  let msgHtml = '<span class="__zt-entry-msg">' + escapeHtml(e.msg) + '</span>';

  if (e.marker) {
    item.innerHTML = timeHtml + msgHtml;
  } else {
    // Name (with timestamp) on its own header line; the message block below
    // shares a single left edge. Continued entries hide the header — search
    // reveal (--show-name) brings back that entry's own time + name.
    item.innerHTML =
      '<div class="__zt-entry-header">' +
        timeHtml +
        (e.name
          ? '<span class="__zt-entry-name" style="color:' + getSpeakerColor(e.name) + '">' + escapeHtml(e.name) + '</span>'
          : '') +
      '</div>' +
      msgHtml;
  }
  return item;
}

export function logNearBottom() {
  if (!app.ui || !app.ui.logEntriesEl) return true;
  let el = app.ui.logEntriesEl;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 60;
}

export function scrollLogToBottom() {
  if (app.ui && app.ui.logEntriesEl) app.ui.logEntriesEl.scrollTop = app.ui.logEntriesEl.scrollHeight;
}

export function renderLogItems() {
  if (!app.ui || !app.ui.settledEl) return;
  if (app.renderedLogCount === app.log.length) return;
  let doc = app.ui.settledEl.ownerDocument;
  let nearBottom = logNearBottom();

  if (app.log.length < app.renderedLogCount) {
    app.ui.settledEl.innerHTML = '';
    app.renderedLogCount = 0;
    app.lastRenderedSpeaker = null;
    nearBottom = true;
  }

  // Only pop on live additions — bulk renders (initial restore, theme
  // rebuild) start from app.renderedLogCount 0 and skip the animation.
  let animateNew = app.renderedLogCount > 0;
  for (let i = app.renderedLogCount; i < app.log.length; i++) {
    let e = app.log[i];
    // Guard against duplicate DOM nodes when two recorder instances briefly
    // share the same caption mount (e.g. parent shell + iframe inject).
    let existing = app.ui.settledEl.querySelector('[data-key="' + e.key.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"]');
    if (existing) continue;
    let continued = !e.marker && !e.chat && !!e.name && e.name === app.lastRenderedSpeaker;
    let node = buildEntryNode(doc, e, continued, false);
    node.setAttribute('data-log-index', String(i));
    if (animateNew && !e.marker) {
      node.classList.add('__zt-entry--just-logged');
      node.addEventListener('animationend', function () {
        node.classList.remove('__zt-entry--just-logged');
      }, { once: true });
    }
    app.ui.settledEl.appendChild(node);
    app.lastRenderedSpeaker = (e.marker || e.chat) ? null : (e.name || null);
  }
  app.renderedLogCount = app.log.length;
  syncBookmarkMarkers();
  if (app.searchQuery.trim()) applyLogFilter();
  if (nearBottom) scrollLogToBottom();
}

export function renderPendingItems() {
  if (!app.ui || !app.ui.pendingEl) return;
  let doc = app.ui.pendingEl.ownerDocument;
  let nearBottom = logNearBottom();
  app.ui.pendingEl.innerHTML = '';
  if (app.paused || !app.settleTimer || !app.pendingLines || !app.pendingLines.length) return;

  let prevName = app.lastRenderedSpeaker;
  let appended = 0;
  app.pendingLines.forEach(function (line) {
    if (!line.msg) return;
    let key = makeKey(line.time, line.name, line.msg);
    if (app.seen.has(key)) return;
    let continued = !!line.name && line.name === prevName;
    app.ui.pendingEl.appendChild(buildEntryNode(doc, {
      key: key,
      time: line.time,
      name: line.name,
      msg: line.msg
    }, continued, true));
    prevName = line.name || null;
    appended++;
  });
  if (appended && nearBottom) scrollLogToBottom();
}

export function syncIdle() {
  if (!app.ui || !app.ui.idleEl) return;
  let empty = !app.log.length && !app.ui.pendingEl.childElementCount;
  app.ui.idleEl.style.display = empty ? 'flex' : 'none';
  if (!empty) return;
  let text = app.store
    ? 'Waiting for captions — click <strong>Show Captions</strong> in Zoom if needed'
    : 'Connecting to Zoom…';
  let html = '<div class="__zt-dot __zt-dot--waiting"></div>' + text;
  if (app.ui.idleEl.innerHTML !== html) app.ui.idleEl.innerHTML = html;
}

// ─── Search ──────────────────────────────────────────────────────────────
export function applyLogFilter() {
  if (!app.ui || !app.ui.settledEl) return;
  let q = app.searchQuery.toLowerCase().trim();
  let rows = app.ui.settledEl.querySelectorAll('.__zt-entry');
  let lastVisibleName = null;

  for (let i = 0; i < rows.length; i++) {
    let row = rows[i];
    let msgEl = row.querySelector('.__zt-entry-msg');
    let show = !q || row.textContent.toLowerCase().indexOf(q) >= 0;
    row.style.display = show ? '' : 'none';
    row.classList.remove('__zt-entry--show-name');

    if (msgEl) {
      let orig = msgEl.textContent;
      let idx = show && q ? orig.toLowerCase().indexOf(q) : -1;
      if (idx >= 0) {
        msgEl.innerHTML = escapeHtml(orig.slice(0, idx)) +
          '<mark>' + escapeHtml(orig.slice(idx, idx + q.length)) + '</mark>' +
          escapeHtml(orig.slice(idx + q.length));
      } else {
        msgEl.innerHTML = escapeHtml(orig);
      }
    }

    if (!show) continue;
    let name = row.getAttribute('data-name') || null;
    // Reveal the speaker on a continued row when the head of its run is
    // filtered out, so search results aren't anonymous.
    if (q && name && row.classList.contains('__zt-entry--continued') && name !== lastVisibleName) {
      row.classList.add('__zt-entry--show-name');
    }
    lastVisibleName = row.classList.contains('__zt-entry--marker') ? null : name;
  }
}

// ─── Stats ───────────────────────────────────────────────────────────────
export function renderStats() {
  if (!app.ui || !app.ui.statsRowsEl) return;
  let doc = app.ui.statsRowsEl.ownerDocument;
  let names = Object.keys(app.speakerStats);
  let total = 0;
  let max = 0;
  names.forEach(function (n) {
    total += app.speakerStats[n];
    if (app.speakerStats[n] > max) max = app.speakerStats[n];
  });
  names.sort(function (a, b) { return app.speakerStats[b] - app.speakerStats[a]; });

  app.ui.statsMetaEl.textContent = app.log.length + (app.log.length === 1 ? ' line' : ' lines') + ' · ' + elapsedText();

  app.ui.statsRowsEl.innerHTML = '';
  if (!names.length) {
    app.ui.statsRowsEl.innerHTML = '<div class="__zt-idle">No speakers yet</div>';
    return;
  }
  names.forEach(function (n) {
    let count = app.speakerStats[n];
    let color = getSpeakerColor(n);
    let row = doc.createElement('div');
    row.className = '__zt-stat-row';
    row.innerHTML =
      '<div class="__zt-stat-swatch" style="background:' + color + '"></div>' +
      '<div class="__zt-stat-name">' + escapeHtml(n) + '</div>' +
      '<div class="__zt-stat-bar-wrap"><div class="__zt-stat-bar" style="width:' + Math.round(count / max * 100) + '%;background:' + color + '"></div></div>' +
      '<div class="__zt-stat-pct">' + Math.round(count / total * 100) + '%</div>' +
      '<div class="__zt-stat-lines">' + count + (count === 1 ? ' line' : ' lines') + '</div>';
    app.ui.statsRowsEl.appendChild(row);
  });
}

// ─── Elapsed timer ───────────────────────────────────────────────────────
export function startElapsed() {
  if (app.elapsedStart == null) app.elapsedStart = Date.now();
  if (!app.elapsedTimer) app.elapsedTimer = setInterval(updateTimerDisplay, 1000);
}

export function elapsedText() {
  if (app.elapsedStart == null) return '0:00';
  let total = Math.max(0, Math.floor((Date.now() - app.elapsedStart) / 1000));
  return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
}

export function updateTimerDisplay() {
  if (!app.ui) return;
  if (!app.paused && app.ui.timerEl) app.ui.timerEl.textContent = elapsedText();
  if (app.collapsed) updatePill();
}
