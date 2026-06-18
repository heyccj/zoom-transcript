import { app } from './state.js';
import { ensureStyles } from './styles.js';
import { bookmarkIconHtml, ensureBookmarkWiring } from './bookmarks.js';
import { wireMountEvents, ensureUiRefs, mountIsHealthy } from './ui-core.js';
import { applyMode, applyCollapsed, setCollapsed } from './controls.js';
import { findCaptionBox, lockPanelWidth, activeDoc, tryDismissCaptionLanguageModal, tryShowCaptions, startCaptionsAutoEnable } from './caption-panel.js';
import { setupAutoDownloadHooks } from './export.js';
export function createMount(doc) {
  ensureStyles(doc);
  let mount = doc.getElementById('__zt-caption-mount');
  if (mount) {
    ensureBookmarkWiring(mount, doc);
    if (!mount.dataset.ztBound) {
      mount.dataset.ztBound = '1';
      wireMountEvents(mount, doc);
    }
    return mount;
  }

  mount = doc.createElement('div');
  mount.id = '__zt-caption-mount';
  mount.className = '__zt-caption-mount' + (app.darkMode ? ' __zt-dark' : '');
  if (app.collapsed) mount.style.display = 'none';
  mount.innerHTML = [
    '<div class="__zt-header">',
      '<div id="__zt-dot" class="__zt-dot __zt-dot--waiting"></div>',
      '<div id="__zt-session-name" class="__zt-session-name" title="Click to name this meeting"></div>',
      '<div class="__zt-meta">',
        '<span id="__zt-timer" class="__zt-timer">0:00</span>',
      '</div>',
      '<button id="__zt-bookmark-btn" class="__zt-btn-icon" type="button" title="Add bookmark">' + bookmarkIconHtml(12) + '</button>',
      '<button id="__zt-mode-btn" class="__zt-btn-icon" type="button" title="Toggle light/dark">☀︎</button>',
      '<button id="__zt-collapse-btn" class="__zt-btn-icon" type="button" title="Collapse">–</button>',
    '</div>',
    '<div id="__zt-paused-banner" class="__zt-paused-banner" style="display:none">',
      '⏸ Recording paused — captions are not being saved',
      '<button id="__zt-banner-resume" class="__zt-btn" type="button">Resume</button>',
    '</div>',
    '<div class="__zt-tabs">',
      '<div class="__zt-tab" data-tab="log">Log</div>',
      '<div class="__zt-tab" data-tab="stats">Stats</div>',
    '</div>',
    '<div class="__zt-tab-panel" data-panel="log">',
      '<div class="__zt-search">',
        '<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><circle cx="6.5" cy="6.5" r="5" stroke="currentColor" stroke-width="1.5"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
        '<input id="__zt-search-input" placeholder="Search transcript…" spellcheck="false">',
      '</div>',
      '<div id="__zt-log-entries" class="__zt-log-entries">',
        '<div id="__zt-idle" class="__zt-idle" style="display:none"></div>',
        '<div id="__zt-settled"></div>',
        '<div id="__zt-pending"></div>',
      '</div>',
    '</div>',
    '<div class="__zt-tab-panel" data-panel="stats">',
      '<div class="__zt-stats-header">',
        '<span class="__zt-stats-label">Talk time</span>',
        '<span id="__zt-stats-meta" class="__zt-stats-label" style="opacity:0.6"></span>',
      '</div>',
      '<div id="__zt-stats-rows"></div>',
    '</div>',
    '<div class="__zt-footer">',
      '<button id="__zt-pause-btn" class="__zt-btn __zt-btn--pause" type="button">⏸ Pause</button>',
      '<button id="__zt-copy-btn" class="__zt-btn __zt-btn--primary" type="button">⎘ Copy</button>',
      '<div class="__zt-spacer"></div>',
      '<div class="__zt-download-wrap">',
        '<button id="__zt-download-btn" class="__zt-btn" type="button">↓ Download ▾</button>',
        '<div id="__zt-dropdown" class="__zt-dropdown">',
          '<div class="__zt-dropdown-label">Export as</div>',
          '<div class="__zt-dropdown-item" data-format="txt">📄 Plain text <span>.txt</span></div>',
          '<div class="__zt-dropdown-item" data-format="json">📊 Structured <span>.json</span></div>',
        '</div>',
      '</div>',
      '<button id="__zt-stop-btn" class="__zt-btn __zt-btn--stop" type="button">■ Stop</button>',
    '</div>',
    '<div id="__zt-bookmark-dialog" class="__zt-bookmark-dialog" style="display:none" role="dialog">',
      '<div class="__zt-bookmark-dialog-card">',
        '<div id="__zt-bookmark-dialog-title" class="__zt-bookmark-dialog-title">Name bookmark</div>',
        '<input id="__zt-bookmark-input" type="text" spellcheck="false" placeholder="Bookmark label">',
        '<div class="__zt-bookmark-dialog-actions">',
          '<button id="__zt-bookmark-remove" type="button" class="__zt-btn __zt-btn--stop" style="display:none">Remove</button>',
          '<div class="__zt-bookmark-dialog-actions-right">',
            '<button id="__zt-bookmark-cancel" type="button" class="__zt-btn">Cancel</button>',
            '<button id="__zt-bookmark-save" type="button" class="__zt-btn __zt-btn--primary">Save</button>',
          '</div>',
        '</div>',
      '</div>',
    '</div>'
  ].join('');

  mount.dataset.ztBound = '1';
  wireMountEvents(mount, doc);
  return mount;
}

export function createPill(doc) {
  ensureStyles(doc);
  let pill = doc.getElementById('__zt-pill');
  if (pill) {
    if (!pill.dataset.ztBound) {
      pill.dataset.ztBound = '1';
      pill.onclick = function () { setCollapsed(false); };
    }
    return pill;
  }

  pill = doc.createElement('div');
  pill.id = '__zt-pill';
  pill.className = '__zt-pill' + (app.darkMode ? ' __zt-dark' : '');
  pill.style.display = app.collapsed ? 'flex' : 'none';
  pill.innerHTML = [
    '<div id="__zt-pill-dot" class="__zt-dot __zt-pill-dot __zt-dot--waiting"></div>',
    '<div class="__zt-pill-speakers">',
      '<div id="__zt-pill-chip" class="__zt-speaker-chip" style="display:none">',
        '<div id="__zt-pill-chip-dot" class="__zt-chip-dot"></div>',
        '<span id="__zt-pill-chip-name"></span>',
      '</div>',
      '<span id="__zt-pill-speaking" class="__zt-pill-speaking" style="display:none">speaking</span>',
    '</div>',
    '<span id="__zt-pill-meta" class="__zt-pill-meta">0:00</span>',
    '<button id="__zt-expand-btn" class="__zt-btn-icon" type="button" title="Expand">+</button>'
  ].join('');

  pill.onclick = function () { setCollapsed(false); };
  pill.dataset.ztBound = '1';
  return pill;
}

export function keepCaptionBoxVisible(doc, box) {
  if (!box) return;
  lockPanelWidth(box);
  box.style.setProperty('display', 'flex', 'important');
  box.style.setProperty('visibility', 'visible', 'important');
  box.style.setProperty('opacity', '1', 'important');

  let wrap = box.closest('.lt-subtitle-wrap');
  if (wrap) {
    lockPanelWidth(wrap);
    wrap.style.setProperty('display', 'block', 'important');
    wrap.style.setProperty('visibility', 'visible', 'important');
  }
}

export function ensurePinDock(doc) {
  ensureStyles(doc);
  let dock = doc.getElementById('__zt-caption-dock');
  if (!dock) {
    dock = doc.createElement('div');
    dock.id = '__zt-caption-dock';
    dock.className = '__zt-caption-dock';
    doc.body.appendChild(dock);
  }
  lockPanelWidth(dock);
  return dock;
}

app.boxAttachTimer = null;

export function scheduleAttachIfNeeded(doc, box) {
  if (app.boxAttachTimer) clearTimeout(app.boxAttachTimer);
  app.boxAttachTimer = setTimeout(function () {
    app.boxAttachTimer = null;
    let mount = doc.getElementById('__zt-caption-mount');
    if (!mount || !mount.isConnected || mount.parentElement !== box) {
      attachMount(doc);
    }
  }, 50);
}

export function observeCaptionBox(doc, box) {
  if (app.ui && app.ui.boxObserver && app.ui.observedBox === box) return;

  if (app.ui && app.ui.boxObserver) app.ui.boxObserver.disconnect();
  let obs = new MutationObserver(function () {
    scheduleAttachIfNeeded(doc, box);
  });
  obs.observe(box, { childList: true });
  if (!app.ui) app.ui = {};
  app.ui.boxObserver = obs;
  app.ui.observedBox = box;
}

export function startCaptionDomWatch(doc) {
  if (app.captionDomObserver) return;
  app.captionDomObserver = new MutationObserver(function () {
    let mount = doc.getElementById('__zt-caption-mount');
    if (!mount || !mount.isConnected) {
      watchCaptionPanel();
    }
  });
  app.captionDomObserver.observe(doc.body, { childList: true, subtree: true });
}

export function attachMount(doc) {
  let mount = doc.getElementById('__zt-caption-mount');
  if (!mount) mount = createMount(doc);
  let pill = doc.getElementById('__zt-pill');
  if (!pill) pill = createPill(doc);

  let box = findCaptionBox(doc);
  let dock = ensurePinDock(doc);
  let usingBox = false;

  if (box) {
    keepCaptionBoxVisible(doc, box);
    observeCaptionBox(doc, box);
    if (mount.parentElement !== box) box.appendChild(mount);
    if (pill.parentElement !== box) box.appendChild(pill);
    dock.style.display = 'none';
    usingBox = true;

    if (box.style.bottom) dock.style.bottom = box.style.bottom;

    if (!app.attachBoxLogged) {
      app.attachBoxLogged = true;
      console.info('[ZT Captions] Attached inside caption box.');
    }
  } else {
    if (mount.parentElement !== dock) dock.appendChild(mount);
    if (pill.parentElement !== dock) dock.appendChild(pill);
    dock.style.display = 'block';

    if (!app.attachDockLogged) {
      app.attachDockLogged = true;
      console.info('[ZT Captions] Caption box hidden — keeping pinned recorder visible.');
    }
  }

  startCaptionDomWatch(doc);

  ensureUiRefs(doc);

  applyMode();
  applyCollapsed();
  return true;
}

app.lastPanelWatchAt = 0;

export function watchCaptionPanel() {
  // updateUI can fire several times per poll tick; the panel scan only
  // needs to run once per tick.
  let now = Date.now();
  if (now - app.lastPanelWatchAt < 250) return;
  app.lastPanelWatchAt = now;

  let doc;
  try {
    doc = activeDoc();
  } catch (e) {
    return;
  }

  tryDismissCaptionLanguageModal(doc);
  setupAutoDownloadHooks(doc);
  tryShowCaptions(doc);
  startCaptionsAutoEnable(doc);
  if (!mountIsHealthy(doc)) {
    attachMount(doc);
  } else {
    ensureUiRefs(doc);
    applyMode();
    applyCollapsed();
  }
}
