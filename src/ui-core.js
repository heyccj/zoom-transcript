import { app, keys } from './state.js';
import { activeDoc, findCaptionBox, applyPanelWidth, applyLogHeight } from './caption-panel.js';
import { formatOutput } from './export.js';
import { flushPending } from './export.js';
import { teardownAutoDownloadHooks } from './export.js';
import { bookmarkIconHtml, ensureBookmarkWiring } from './bookmarks.js';
import { switchTab, toggleMode, togglePause, setPaused, setCollapsed } from './controls.js';
import { applyLogFilter } from './render.js';
import { downloadCaptions, downloadJson } from './export.js';
import { escapeHtml, shieldInputEvents } from './utils.js';
import { MIN_PANEL_WIDTH, MAX_PANEL_WIDTH, MIN_LOG_HEIGHT, MAX_LOG_HEIGHT } from './constants.js';
export function onCopyClick() {
  flushPending();
  let text = formatOutput();
  if (!text) {
    alert('No captions captured yet. Try __ztCaption.probe() in console.');
    return;
  }
  navigator.clipboard.writeText(text).then(function () {
    let btn = app.ui && app.ui.copyBtn;
    if (!btn) return;
    btn.textContent = '✓ Copied';
    setTimeout(function () { btn.textContent = '⎘ Copy'; }, 2000);
  }).catch(function () {
    console.log(text);
    alert('Clipboard blocked — output logged to console.');
  });
}

export function shutdown() {
  flushPending();
  if (app.pollTimer) clearInterval(app.pollTimer);
  app.pollTimer = null;
  if (app.settleTimer) clearTimeout(app.settleTimer);
  app.settleTimer = null;
  if (app.captionsEnableTimer) clearInterval(app.captionsEnableTimer);
  app.captionsEnableTimer = null;
  if (app.elapsedTimer) clearInterval(app.elapsedTimer);
  app.elapsedTimer = null;
  if (app.ui && app.ui.boxObserver) app.ui.boxObserver.disconnect();
  if (app.captionDomObserver) app.captionDomObserver.disconnect();
  app.captionDomObserver = null;
  teardownAutoDownloadHooks();
  let doc = activeDoc();
  ['__zt-caption-mount', '__zt-pill', '__zt-caption-dock', '__zt-caption-styles'].forEach(function (id) {
    let el = doc.getElementById(id);
    if (el) el.remove();
  });
  doc.documentElement.style.removeProperty('--zt-panel-width');
  doc.documentElement.style.removeProperty('--zt-log-height');
  app.ui = null;
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
  app.pendingLines = null;
  localStorage.removeItem(keys.storageKey);
  localStorage.removeItem(keys.meetingKey);
  localStorage.removeItem(keys.autoDownloadKey);
  localStorage.removeItem(keys.bookmarksKey);
  app.bookmarks = [];
  app.bookmarkByKey = new Map();
  app.bookmarkMode = false;
  window.__ztCaptionLoaded = false;
  delete window.__ztCaption;
  try {
    if (window.parent && window.parent !== window) {
      window.parent.__ztCaptionLoaded = false;
      delete window.parent.__ztCaption;
    }
  } catch (e) { /* cross-origin */ }
  console.info('[ZT Captions] Stopped — click your bookmark to start a fresh transcript.');
}

export function syncPrefsFromStorage() {
  app.darkMode = localStorage.getItem(keys.darkKey) === '1';
  app.collapsed = localStorage.getItem(keys.collapsedKey) === '1';
}

export function mountIsHealthy(doc) {
  let mount = doc.getElementById('__zt-caption-mount');
  let pill = doc.getElementById('__zt-pill');
  if (!mount || !pill || !mount.isConnected || !pill.isConnected) return false;
  let box = findCaptionBox(doc);
  if (box) return mount.parentElement === box && pill.parentElement === box;
  let dock = doc.getElementById('__zt-caption-dock');
  return !!(dock && mount.parentElement === dock && pill.parentElement === dock);
}

export function ensureUiRefs(doc) {
  let mount = doc.getElementById('__zt-caption-mount');
  let pill = doc.getElementById('__zt-pill');
  if (!mount || !pill) return false;
  let box = findCaptionBox(doc);
  let dock = doc.getElementById('__zt-caption-dock');
  app.ui = app.ui || {};
  app.ui.mount = mount;
  app.ui.pill = pill;
  app.ui.dock = dock;
  app.ui.dot = mount.querySelector('#__zt-dot');
  app.ui.timerEl = mount.querySelector('#__zt-timer');
  app.ui.modeBtn = mount.querySelector('#__zt-mode-btn');
  app.ui.bookmarkBtn = mount.querySelector('#__zt-bookmark-btn');
  app.ui.bookmarkDialog = mount.querySelector('#__zt-bookmark-dialog');
  app.ui.bookmarkInput = mount.querySelector('#__zt-bookmark-input');
  app.ui.bookmarkDialogTitle = mount.querySelector('#__zt-bookmark-dialog-title');
  app.ui.bookmarkRemoveBtn = mount.querySelector('#__zt-bookmark-remove');
  app.ui.pausedBanner = mount.querySelector('#__zt-paused-banner');
  app.ui.logEntriesEl = mount.querySelector('#__zt-log-entries');
  app.ui.settledEl = mount.querySelector('#__zt-settled');
  app.ui.pendingEl = mount.querySelector('#__zt-pending');
  app.ui.idleEl = mount.querySelector('#__zt-idle');
  app.ui.statsRowsEl = mount.querySelector('#__zt-stats-rows');
  app.ui.statsMetaEl = mount.querySelector('#__zt-stats-meta');
  app.ui.pauseBtn = mount.querySelector('#__zt-pause-btn');
  app.ui.copyBtn = mount.querySelector('#__zt-copy-btn');
  app.ui.searchInput = mount.querySelector('#__zt-search-input');
  app.ui.pillDot = pill.querySelector('#__zt-pill-dot');
  app.ui.pillChip = pill.querySelector('#__zt-pill-chip');
  app.ui.pillChipDot = pill.querySelector('#__zt-pill-chip-dot');
  app.ui.pillChipName = pill.querySelector('#__zt-pill-chip-name');
  app.ui.pillSpeaking = pill.querySelector('#__zt-pill-speaking');
  app.ui.pillMeta = pill.querySelector('#__zt-pill-meta');
  app.ui.usingBox = !!box;
  ensureBookmarkWiring(mount, doc);
  return true;
}

export function wireMountEvents(mount, doc) {
  mount.querySelectorAll('.__zt-tab').forEach(function (t) {
    t.classList.toggle('active', t.getAttribute('data-tab') === app.activeTab);
    t.onclick = function () { switchTab(t.getAttribute('data-tab')); };
  });
  mount.querySelectorAll('.__zt-tab-panel').forEach(function (p) {
    p.style.display = p.getAttribute('data-panel') === app.activeTab ? '' : 'none';
  });

  let nameEl = mount.querySelector('#__zt-session-name');
  function syncNameDisplay() {
    nameEl.textContent = app.sessionName || 'Name this meeting…';
    nameEl.classList.toggle('__zt-session-name--empty', !app.sessionName);
  }
  syncNameDisplay();
  nameEl.onclick = function () {
    let win = doc.defaultView || window;
    let v = win.prompt('Name this meeting:', app.sessionName);
    if (v === null) return;
    app.sessionName = v.trim();
    localStorage.setItem(keys.sessionKey, app.sessionName);
    syncNameDisplay();
  };

  let searchInput = mount.querySelector('#__zt-search-input');
  searchInput.value = app.searchQuery;
  searchInput.addEventListener('input', function () {
    app.searchQuery = searchInput.value;
    applyLogFilter();
  });

  mount.querySelector('#__zt-mode-btn').textContent = app.darkMode ? '🌙' : '☀︎';
  mount.querySelector('#__zt-mode-btn').onclick = toggleMode;
  mount.querySelector('#__zt-collapse-btn').onclick = function () { setCollapsed(true); };
  mount.querySelector('#__zt-pause-btn').onclick = togglePause;
  mount.querySelector('#__zt-banner-resume').onclick = function () { setPaused(false); };
  mount.querySelector('#__zt-copy-btn').onclick = onCopyClick;
  mount.querySelector('#__zt-stop-btn').onclick = function () {
    let win = doc.defaultView || window;
    if (!win.confirm('Stop recording and remove the caption widget? Your transcript will be cleared.')) return;
    shutdown();
  };

  let dropdown = mount.querySelector('#__zt-dropdown');
  mount.querySelector('#__zt-download-btn').onclick = function (ev) {
    ev.stopPropagation();
    let open = dropdown.classList.toggle('open');
    if (open) {
      let close = function (e2) {
        if (!dropdown.contains(e2.target)) {
          dropdown.classList.remove('open');
          doc.removeEventListener('click', close, true);
        }
      };
      doc.addEventListener('click', close, true);
    }
  };
  dropdown.querySelector('[data-format="txt"]').onclick = function () {
    dropdown.classList.remove('open');
    downloadCaptions({ auto: false, reason: 'manual' });
  };
  dropdown.querySelector('[data-format="json"]').onclick = function () {
    dropdown.classList.remove('open');
    downloadJson();
  };

  ['left', 'right', 'top', 'bottom'].forEach(function (side) {
    let horiz = side === 'left' || side === 'right';
    let sign = (side === 'left' || side === 'top') ? -1 : 1;
    let handle = doc.createElement('div');
    handle.className = '__zt-resize-handle __zt-resize-handle--' + side;
    handle.title = 'Drag to resize';
    mount.appendChild(handle);
    handle.addEventListener('mousedown', function (e) {
      e.preventDefault();
      e.stopPropagation();
      let start = horiz ? e.clientX : e.clientY;
      let startVal = horiz ? app.panelWidth : app.logHeight;
      handle.classList.add('active');
      function onMove(ev) {
        ev.preventDefault();
        let delta = sign * ((horiz ? ev.clientX : ev.clientY) - start);
        if (horiz) {
          app.panelWidth = Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, startVal + delta));
          applyPanelWidth(doc);
        } else {
          app.logHeight = Math.max(MIN_LOG_HEIGHT, Math.min(MAX_LOG_HEIGHT, startVal + delta));
          applyLogHeight(doc);
        }
      }
      function onUp() {
        doc.removeEventListener('mousemove', onMove, true);
        doc.removeEventListener('mouseup', onUp, true);
        handle.classList.remove('active');
        if (horiz) localStorage.setItem(keys.widthKey, String(app.panelWidth));
        else localStorage.setItem(keys.heightKey, String(app.logHeight));
      }
      doc.addEventListener('mousemove', onMove, true);
      doc.addEventListener('mouseup', onUp, true);
    });
  });

  shieldInputEvents(mount.querySelector('#__zt-search-input'));
  ensureBookmarkWiring(mount, doc);
}
