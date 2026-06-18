import { app, keys } from './state.js';
import { makeKey } from './dedup.js';
import { extractLines, extractChatLines } from './redux.js';
import { addMarker } from './ingest.js';
import { getSpeakerColor, latestPendingSpeaker } from './bookmarks.js';
import { watchCaptionPanel } from './ui-mount.js';
import { renderLogItems, renderPendingItems, syncIdle, renderStats, scrollLogToBottom, updateTimerDisplay } from './render.js';
export function setPaused(p) {
  if (app.paused === p) return;
  app.paused = p;
  addMarker(p ? 'Recording app.paused' : 'Recording resumed', 'pause-event');
  if (app.settleTimer) {
    clearTimeout(app.settleTimer);
    app.settleTimer = null;
  }
  app.pendingLines = null;
  if (!p) {
    // Drop everything captured during the pause window: mark current state
    // lines as app.seen so they never get ingested. app.pauseSkipped survives the
    // app.seen-set rebuild in syncSeenFromLog().
    app.lastSnapshot = '';
    if (app.store) {
      try {
        let pauseState = app.store.getState();
        extractLines(pauseState).forEach(function (line) {
          let key = makeKey(line.time, line.name, line.msg);
          app.pauseSkipped.add(key);
          app.seen.add(key);
        });
        extractChatLines(pauseState).forEach(function (line) {
          let key = 'chat|' + line.chatId;
          app.pauseSkipped.add(key);
          app.seen.add(key);
        });
      } catch (e) { /* ignore */ }
    }
  }
  updateUI();
}

export function togglePause() {
  setPaused(!app.paused);
}

// ─── Light/dark mode ─────────────────────────────────────────────────────
export function applyMode() {
  syncPrefsFromStorage();
  if (!app.ui) return;
  [app.ui.mount, app.ui.pill, app.ui.dock].forEach(function (el) {
    if (el) el.classList.toggle('__zt-dark', app.darkMode);
  });
  if (app.ui.modeBtn) app.ui.modeBtn.textContent = app.darkMode ? '🌙' : '☀︎';
}

export function toggleMode() {
  app.darkMode = !app.darkMode;
  localStorage.setItem(keys.darkKey, app.darkMode ? '1' : '');
  if (app.ui && app.ui.settledEl) {
    app.ui.settledEl.innerHTML = '';
    app.renderedLogCount = 0;
    app.lastRenderedSpeaker = null;
  }
  applyMode();
  renderLogItems();
  renderPendingItems();
  updatePill();
}

// ─── Collapse ────────────────────────────────────────────────────────────
export function applyCollapsed() {
  syncPrefsFromStorage();
  if (!app.ui) return;
  if (app.ui.mount) app.ui.mount.style.display = app.collapsed ? 'none' : '';
  if (app.ui.pill) app.ui.pill.style.display = app.collapsed ? 'flex' : 'none';
}

export function setCollapsed(c) {
  app.collapsed = c;
  localStorage.setItem(keys.collapsedKey, c ? '1' : '');
  applyCollapsed();
  if (!c) scrollLogToBottom();
  updatePill();
}

// ─── Tabs ────────────────────────────────────────────────────────────────
export function switchTab(name) {
  app.activeTab = name;
  if (!app.ui || !app.ui.mount) return;
  app.ui.mount.querySelectorAll('.__zt-tab').forEach(function (t) {
    t.classList.toggle('active', t.getAttribute('data-tab') === name);
  });
  app.ui.mount.querySelectorAll('.__zt-tab-panel').forEach(function (p) {
    p.style.display = p.getAttribute('data-panel') === name ? '' : 'none';
  });
  if (name === 'stats') renderStats();
  else scrollLogToBottom();
}

// ─── Collapsed pill ──────────────────────────────────────────────────────
export function dotStateClass() {
  if (app.paused) return '__zt-dot--idle';
  if (app.settleTimer && app.pendingLines && app.pendingLines.length) return '__zt-dot--rec';
  if (app.store) return '__zt-dot--idle';
  return '__zt-dot--waiting';
}

export function updatePill() {
  if (!app.ui || !app.ui.pill) return;
  app.ui.pillDot.className = '__zt-dot __zt-pill-dot ' + dotStateClass();

  let speaking = !app.paused && !!(app.settleTimer && app.pendingLines && app.pendingLines.length);
  let speaker = latestPendingSpeaker();
  if (!speaker) {
    for (let i = app.log.length - 1; i >= 0; i--) {
      if (app.log[i].name && !app.log[i].marker) {
        speaker = app.log[i].name;
        break;
      }
    }
  }

  if (speaker) {
    app.ui.pillChip.style.display = 'flex';
    app.ui.pillChipDot.style.background = getSpeakerColor(speaker);
    app.ui.pillChipName.textContent = speaker;
    app.ui.pillSpeaking.style.display = speaking ? '' : 'none';
  } else {
    app.ui.pillChip.style.display = 'none';
    app.ui.pillSpeaking.style.display = 'none';
  }

  app.ui.pillMeta.textContent = elapsedText();
}

// ─── Main UI sync ────────────────────────────────────────────────────────
export function updateUI() {
  watchCaptionPanel();
  if (!app.ui || !app.ui.mount || !app.ui.dot) return;

  app.ui.dot.className = '__zt-dot ' + dotStateClass();

  app.ui.pausedBanner.style.display = app.paused ? 'flex' : 'none';
  app.ui.logEntriesEl.classList.toggle('__zt-log--paused', app.paused);
  if (app.paused) {
    app.ui.pauseBtn.className = '__zt-btn __zt-btn--resume';
    app.ui.pauseBtn.textContent = '▶ Resume';
  } else {
    app.ui.pauseBtn.className = '__zt-btn __zt-btn--pause';
    app.ui.pauseBtn.textContent = '⏸ Pause';
  }

  renderLogItems();
  renderPendingItems();
  syncIdle();
  if (app.activeTab === 'stats') renderStats();
  if (!app.paused) app.ui.timerEl.textContent = elapsedText();
  updatePill();
}
