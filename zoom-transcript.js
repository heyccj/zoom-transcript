(function () {
  if (window.__ztCaptionLoaded) {
    console.warn('[ZT Captions] Already running in this frame.');
    return window.__ztCaption;
  }
  window.__ztCaptionLoaded = true;

  const POLL_MS = 800;
  const SETTLE_MS = 3000;
  const CAPTION_PANEL_WIDTH = 500;
  const MAX_INJECT_RETRIES = 40;
  let injectAttempted = false;
  let pendingInjectSource = null;
  let injectRetries = 0;

  // ─── Dedup ───────────────────────────────────────────────────────────────
  function makeKey(time, name, msg) {
    return (time || '') + '|' + (name || '') + '|' + msg.slice(0, 40);
  }

  function isProgressiveUpdate(prev, time, name, msg) {
    if (prev.time !== time || prev.name !== name) return false;
    return msg.indexOf(prev.msg) === 0 || prev.msg.indexOf(msg) === 0;
  }

  function dedupLog(entries) {
    let result = [];
    entries.forEach(function (e) {
      let matchIdx = -1;
      for (let j = result.length - 1; j >= 0; j--) {
        let prev = result[j];
        if (prev.time !== e.time || prev.name !== e.name) continue;
        if (isProgressiveUpdate(prev, e.time, e.name, e.msg)) {
          matchIdx = j;
          break;
        }
      }
      if (matchIdx >= 0) {
        if (e.msg.length >= result[matchIdx].msg.length) {
          result[matchIdx].msg = e.msg;
        }
      } else {
        result.push({
          key: e.key,
          time: e.time,
          name: e.name,
          msg: e.msg,
          src: e.src,
          marker: e.marker
        });
      }
    });
    result.forEach(function (e) {
      e.key = makeKey(e.time, e.name, e.msg);
    });
    let keySeen = new Set();
    return result.filter(function (e) {
      if (keySeen.has(e.key)) return false;
      keySeen.add(e.key);
      return true;
    });
  }

  function getMeetingId(win) {
    try {
      let path = win.location.pathname;
      let match = path.match(/\/wc\/(\d+)/) || path.match(/\/j\/(\d+)/);
      return match ? match[1] : path + win.location.search;
    } catch (e) {
      return 'unknown';
    }
  }

  function isMeetingDoc(doc) {
    return !!(
      doc.getElementById('full-transcription') ||
      doc.getElementById('live-transcription-subtitle') ||
      doc.getElementById('zmmtg-root') ||
      doc.getElementById('wc-container') ||
      doc.querySelector('.lt-full-transcript__item')
    );
  }

  // ─── Webclient / Redux access ───────────────────────────────────────────
  function getWebclientWindow() {
    if (isMeetingDoc(document)) return window;

    let iframe = document.getElementById('webclient');
    if (iframe && iframe.contentWindow) {
      try {
        if (iframe.contentDocument && iframe.contentDocument.body) {
          return iframe.contentWindow;
        }
      } catch (e) { /* cross-origin */ }
    }
    return window;
  }

  function isParentShell() {
    return !!document.getElementById('webclient') && !isMeetingDoc(document);
  }

  function looksLikeStore(obj) {
    return obj &&
      typeof obj.getState === 'function' &&
      typeof obj.subscribe === 'function' &&
      typeof obj.dispatch === 'function';
  }

  function storeFromFiber(fiber, seen) {
    if (!fiber || seen.has(fiber)) return null;
    seen.add(fiber);

    let props = fiber.memoizedProps;
    if (props) {
      if (looksLikeStore(props.store)) return props.store;
      if (props.value && looksLikeStore(props.value.store)) return props.value.store;
    }

    let state = fiber.memoizedState;
    while (state) {
      if (looksLikeStore(state.memoizedState)) return state.memoizedState;
      if (state.queue && looksLikeStore(state.queue.lastRenderedState)) {
        return state.queue.lastRenderedState;
      }
      state = state.next;
    }

    return (
      storeFromFiber(fiber.child, seen) ||
      storeFromFiber(fiber.sibling, seen)
    );
  }

  function collectFibers(node, out, limit) {
    if (!node || out.length >= limit) return;
    let keys = Object.keys(node);
    for (let i = 0; i < keys.length; i++) {
      let k = keys[i];
      if (k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactContainer$') === 0) {
        out.push(node[k]);
      }
    }
    for (let c = node.firstChild; c; c = c.nextSibling) {
      collectFibers(c, out, limit);
    }
  }

  function findReduxStore(doc) {
    let roots = [
      doc.getElementById('zmmtg-root'),
      doc.getElementById('root'),
      doc.getElementById('wc-container'),
      doc.body
    ].filter(Boolean);

    let fibers = [];
    roots.forEach(function (root) { collectFibers(root, fibers, 40); });

    for (let i = 0; i < fibers.length; i++) {
      let store = storeFromFiber(fibers[i], new Set());
      if (store) return store;
    }
    return null;
  }

  function attendeeLists(state) {
    let lists = [];
    if (state.attendeesList && state.attendeesList.attendeesList) {
      lists.push(state.attendeesList.attendeesList);
    }
    if (state.attendeesList && Array.isArray(state.attendeesList.list)) {
      lists.push(state.attendeesList.list);
    }
    return lists;
  }

  function eachAttendee(state, fn) {
    attendeeLists(state).forEach(function (list) {
      list.forEach(function (a) {
        if (!a) return;
        fn(a, a.userId != null ? a.userId : a.zoomID);
      });
    });
  }

  function attendeeNameMap(state) {
    let map = {};
    eachAttendee(state, function (a, id) {
      let name = a.displayName || a.name;
      if (id != null && name) map[id] = name;
    });
    return map;
  }

  function activeSharerMap(state) {
    let map = {};
    eachAttendee(state, function (a, id) {
      if (!a.sharerOn || id == null) return;
      map[id] = a.displayName || a.name || 'Someone';
    });
    return map;
  }

  function resolveName(msg, names) {
    if (msg.isCaptioner) return '(Captioner)';
    if (msg.user && msg.user.displayName) return msg.user.displayName;
    if (msg.displayName) return msg.displayName;
    if (msg.previousDisplayName) return msg.previousDisplayName;
    if (msg.userId != null && names[msg.userId]) return names[msg.userId];
    return null;
  }

  function normalizeText(text) {
    if (!text) return '';
    return String(text).replace(/\uFFFD/g, '').trim();
  }

  // Format a Unix-ms timestamp as h:mm:ss. Non-numeric values (in case Zoom
  // ever supplies a preformatted string) pass through untouched.
  function formatTime(value) {
    let ms = typeof value === 'number' ? value : NaN;
    if (isNaN(ms) && /^\d{10,}$/.test(String(value))) ms = Number(value);
    if (isNaN(ms)) return value == null ? '' : String(value);
    let d = new Date(ms);
    let m = String(d.getMinutes()).padStart(2, '0');
    let s = String(d.getSeconds()).padStart(2, '0');
    return d.getHours() + ':' + m + ':' + s;
  }

  function ltBuckets(state) {
    let buckets = [];
    if (state.liveTranscription) buckets.push(state.liveTranscription);
    if (state.newLiveTranscription && state.newLiveTranscription !== state.liveTranscription) {
      buckets.push(state.newLiveTranscription);
    }
    return buckets;
  }

  function linesFromAllMessages(state, names) {
    let rows = [];
    let seenKeys = new Set();

    ltBuckets(state).forEach(function (lt) {
      if (!lt || !lt.allMessages) return;
      let order = Array.isArray(lt.messagesOrder) ? lt.messagesOrder.slice() : [];
      let ids = order.length ? order : Object.keys(lt.allMessages);

      ids.forEach(function (id) {
        let msg = lt.allMessages[id];
        if (!msg) return;
        let text = normalizeText(msg.message || msg.decryptedMessage || msg.text);
        if (!text) return;
        let time = msg.messageTime ? formatTime(msg.messageTime) : '';
        let name = resolveName(msg, names);
        let key = makeKey(time, name, text);
        if (seenKeys.has(key)) return;
        seenKeys.add(key);
        rows.push({
          time: time,
          name: name,
          msg: text,
          src: 'allMessages',
          finished: msg.isFinished !== false
        });
      });
    });

    return rows;
  }

  function linesFromNewLTMessage(state, names) {
    let rows = [];

    ltBuckets(state).forEach(function (lt) {
      if (!lt || !lt.newLTMessage) return;
      Object.keys(lt.newLTMessage).forEach(function (id) {
        let msg = lt.newLTMessage[id];
        let text = normalizeText(msg.text || msg.message);
        if (!text) return;
        rows.push({
          time: msg.messageTime ? formatTime(msg.messageTime) : '',
          name: resolveName(msg, names),
          msg: text,
          src: 'newLTMessage',
          finished: msg.isFinished !== false
        });
      });
    });

    return rows;
  }

  function linesFromMessageLatest(state) {
    let text = normalizeText(state.meeting && state.meeting.messageLatest);
    if (!text) return [];
    return [{
      time: formatTime(Date.now()),
      name: null,
      msg: text,
      src: 'messageLatest',
      finished: true
    }];
  }

  function extractLines(state) {
    let names = attendeeNameMap(state);
    let fromAll = linesFromAllMessages(state, names);
    if (fromAll.length) return fromAll;

    let fromNew = linesFromNewLTMessage(state, names);
    if (fromNew.length) return fromNew;

    return linesFromMessageLatest(state);
  }

  function probeState(state) {
    let lt = ltBuckets(state);
    return {
      attendeeCount: Object.keys(attendeeNameMap(state)).length,
      liveTranscriptionKeys: lt.map(function (b) {
        return {
          allMessages: b.allMessages ? Object.keys(b.allMessages).length : 0,
          messagesOrder: b.messagesOrder ? b.messagesOrder.length : 0,
          newLTMessage: b.newLTMessage ? Object.keys(b.newLTMessage).length : 0,
          hasLTStarted: !!b.hasLTStarted
        };
      }),
      messageLatest: !!(state.meeting && state.meeting.messageLatest),
      lines: extractLines(state).slice(-5)
    };
  }

  // ─── State ───────────────────────────────────────────────────────────────
  let wcWin = getWebclientWindow();
  const meetingId = getMeetingId(wcWin);
  const storageKey = '__ztCaptionLog';
  const meetingKey = '__ztCaptionMeetingId';
  const sessionKey = '__ztCaptionSession';
  const autoDownloadKey = '__ztCaptionAutoDownloaded';
  const darkKey = '__ztCaptionDark';
  const collapsedKey = '__ztCaptionCollapsed';
  const widthKey = '__ztCaptionWidth';
  const MIN_PANEL_WIDTH = 320;
  const MAX_PANEL_WIDTH = 900;
  const heightKey = '__ztCaptionHeight';
  const MIN_LOG_HEIGHT = 100;
  const MAX_LOG_HEIGHT = 700;
  const DEFAULT_LOG_HEIGHT = 160;

  if (localStorage.getItem(meetingKey) !== meetingId) {
    localStorage.removeItem(storageKey);
    localStorage.removeItem(sessionKey);
    localStorage.removeItem(autoDownloadKey);
  }
  localStorage.setItem(meetingKey, meetingId);

  let log = dedupLog(JSON.parse(localStorage.getItem(storageKey) || '[]'));
  let seen = new Set(log.map(function (l) { return l.key; }));
  let pauseSkipped = new Set();
  let store = null;
  let pollTimer = null;
  let settleTimer = null;
  let lastSnapshot = '';
  let pollCount = 0;
  let pendingLines = null;
  let openCaptionAttemptAt = 0;
  let captionsEnableTimer = null;
  let captionsEnabledOnce = false;
  let langModalSaveAt = 0;
  let renderedLogCount = 0;
  let lastRenderedSpeaker = null;
  let ui = null;
  let attachBoxLogged = false;
  let attachDockLogged = false;
  let captionDomObserver = null;
  let autoDownloadDoc = null;
  let autoDownloadWin = null;
  let meetingExitClickHandler = null;
  let tabCloseBeforeUnloadHandler = null;
  let tabClosePageHideHandler = null;
  let hostEndedObserver = null;
  let hostEndedTimer = null;
  let hostEndedTriggered = false;
  let speakerColorMap = {};
  let speakerColorIdx = 0;
  let sessionName = localStorage.getItem(sessionKey) || '';
  let paused = false;
  let darkMode = localStorage.getItem(darkKey) === '1';
  let collapsed = localStorage.getItem(collapsedKey) === '1';
  let activeTab = 'log';
  let elapsedStart = null;
  let elapsedTimer = null;
  let speakerStats = {};
  let searchQuery = '';
  let panelWidth = (function () {
    let w = parseInt(localStorage.getItem(widthKey), 10);
    if (isNaN(w)) return CAPTION_PANEL_WIDTH;
    return Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, w));
  })();
  let logHeight = (function () {
    let h = parseInt(localStorage.getItem(heightKey), 10);
    if (isNaN(h)) return DEFAULT_LOG_HEIGHT;
    return Math.max(MIN_LOG_HEIGHT, Math.min(MAX_LOG_HEIGHT, h));
  })();

  const SPEAKER_PALETTE_DARK = ['#7dd3fc', '#f9a8d4', '#fcd34d', '#86efac', '#c4b5fd', '#fb923c', '#67e8f9', '#f87171'];
  const SPEAKER_PALETTE_LIGHT = ['#0284c7', '#be185d', '#b45309', '#15803d', '#7c3aed', '#c2410c', '#0891b2', '#b91c1c'];

  function getSpeakerColor(name) {
    if (!name) return darkMode ? '#9aa3af' : '#6b7280';
    if (speakerColorMap[name] == null) {
      speakerColorMap[name] = speakerColorIdx % SPEAKER_PALETTE_DARK.length;
      speakerColorIdx++;
    }
    let palette = darkMode ? SPEAKER_PALETTE_DARK : SPEAKER_PALETTE_LIGHT;
    return palette[speakerColorMap[name]];
  }

  function latestPendingSpeaker() {
    if (!pendingLines) return null;
    for (let i = pendingLines.length - 1; i >= 0; i--) {
      if (pendingLines[i].msg && pendingLines[i].name) return pendingLines[i].name;
    }
    return null;
  }

  function syncSeenFromLog() {
    seen = new Set(log.map(function (l) { return l.key; }));
    pauseSkipped.forEach(function (k) { seen.add(k); });
  }

  function rebuildSpeakerStats() {
    speakerStats = {};
    log.forEach(function (e) {
      if (!e.name || e.marker) return;
      speakerStats[e.name] = (speakerStats[e.name] || 0) + 1;
    });
  }

  function persistLog() {
    log = dedupLog(log);
    syncSeenFromLog();
    rebuildSpeakerStats();
    if (log.length) {
      localStorage.setItem(storageKey, JSON.stringify(log));
    }
    updateUI();
  }

  function ingestLines(lines) {
    if (paused) return 0;
    let added = 0;
    lines.forEach(function (line) {
      let key = makeKey(line.time, line.name, line.msg);
      if (seen.has(key)) return;
      seen.add(key);
      added++;
      log.push({
        key: key,
        time: line.time,
        name: line.name,
        msg: line.msg,
        src: line.src
      });
    });
    if (added) startElapsed();
    return added;
  }

  let prevSharers = null;

  function addMarker(text, src) {
    let time = formatTime(Date.now());
    let msg = '— ' + text + ' —';
    let key = makeKey(time, null, msg);
    if (seen.has(key)) return;
    seen.add(key);
    log.push({
      key: key,
      time: time,
      name: null,
      msg: msg,
      src: src,
      marker: true
    });
    persistLog();
  }

  function addShareMarker(text) {
    if (paused) return;
    addMarker(text, 'share-event');
  }

  function trackShareEvents(state) {
    let cur;
    try {
      cur = activeSharerMap(state);
    } catch (e) {
      return;
    }

    if (prevSharers === null) {
      prevSharers = cur;
      return;
    }

    Object.keys(cur).forEach(function (id) {
      if (!(id in prevSharers)) {
        addShareMarker(cur[id] + ' started sharing their screen');
      }
    });
    Object.keys(prevSharers).forEach(function (id) {
      if (!(id in cur)) {
        addShareMarker((prevSharers[id] || 'Someone') + ' stopped sharing');
      }
    });

    prevSharers = cur;
  }

  function tryInjectIntoIframe(source) {
    if (injectAttempted || !source) return false;
    let iframe = document.getElementById('webclient');
    if (!iframe || !iframe.contentWindow || !iframe.contentDocument) {
      // Iframe not ready yet — keep the source so pollStore can retry.
      pendingInjectSource = source;
      return false;
    }

    pendingInjectSource = null;
    try {
      if (iframe.contentWindow.__ztCaptionLoaded) return true;
      injectAttempted = true;
      let script = iframe.contentDocument.createElement('script');
      script.textContent = source;
      iframe.contentDocument.head.appendChild(script);
      updateUI();
      console.info('[ZT Captions] Injected into #webclient iframe.');
      return true;
    } catch (e) {
      console.warn('[ZT Captions] Could not inject into iframe:', e);
      return false;
    }
  }

  function pollStore() {
    pollCount++;
    wcWin = getWebclientWindow();

    if (!store) {
      store = findReduxStore(wcWin.document);
      if (!store && isParentShell() && pendingInjectSource && injectRetries < MAX_INJECT_RETRIES) {
        injectRetries++;
        tryInjectIntoIframe(pendingInjectSource);
      }
      if (!store) {
        updateUI();
        return;
      }
      console.info('[ZT Captions] Redux store found.');
      updateUI();
    }

    let state;
    try {
      state = store.getState();
    } catch (e) {
      store = null;
      updateUI();
      return;
    }

    trackShareEvents(state);

    if (!paused) {
      let lines = extractLines(state);
      let snapshot = JSON.stringify(lines.map(function (l) {
        return [l.time, l.name, l.msg, l.finished];
      }));

      if (snapshot !== lastSnapshot) {
        lastSnapshot = snapshot;
        pendingLines = lines;
        if (settleTimer) clearTimeout(settleTimer);
        updateUI();
        settleTimer = setTimeout(function () {
          settleTimer = null;
          ingestLines(lines);
          pendingLines = null;
          persistLog();
        }, SETTLE_MS);
      }
    }

    if (store) updateUI();
  }

  // ─── Caption panel UI (on-screen subtitles, not transcript sidebar) ─────
  function activeDoc() {
    wcWin = getWebclientWindow();
    return wcWin.document;
  }

  function findCaptionBox(doc) {
    let sub = doc.getElementById('live-transcription-subtitle');
    if (sub && sub.closest) {
      let inBox = sub.closest('.live-transcription-subtitle__box');
      if (inBox) return inBox;
    }
    return doc.querySelector('.live-transcription-subtitle__box');
  }

  function findCaptionHost(doc) {
    return findCaptionBox(doc) || doc.querySelector('.lt-subtitle-wrap');
  }

  function captionsVisible(doc) {
    let sub = doc.getElementById('live-transcription-subtitle');
    if (!sub) return false;
    if (sub.style.display === 'none') return false;
    let box = sub.closest('.live-transcription-subtitle__box');
    if (box && box.style.display === 'none') return false;
    return true;
  }

  function lockPanelWidth(el) {
    if (!el) return;
    el.style.setProperty('width', panelWidth + 'px', 'important');
    el.style.setProperty('min-width', panelWidth + 'px', 'important');
    el.style.setProperty('max-width', panelWidth + 'px', 'important');
    el.style.setProperty('box-sizing', 'border-box', 'important');
  }

  function applyPanelWidth(doc) {
    doc.documentElement.style.setProperty('--zt-panel-width', panelWidth + 'px');
    let box = findCaptionBox(doc);
    if (box) {
      lockPanelWidth(box);
      let wrap = box.closest('.lt-subtitle-wrap');
      if (wrap) lockPanelWidth(wrap);
    }
    let dock = doc.getElementById('__zt-caption-dock');
    if (dock) lockPanelWidth(dock);
  }

  function applyLogHeight(doc) {
    doc.documentElement.style.setProperty('--zt-log-height', logHeight + 'px');
  }

  function findShowCaptionsButton(doc) {
    let candidates = doc.querySelectorAll('button[title], button[aria-label]');
    let i;
    for (i = 0; i < candidates.length; i++) {
      let label = ((candidates[i].getAttribute('title') || '') + ' ' +
        (candidates[i].getAttribute('aria-label') || '')).trim();
      if (/^show captions$/i.test(label)) return candidates[i];
    }
    for (i = 0; i < candidates.length; i++) {
      let req = ((candidates[i].getAttribute('title') || '') + ' ' +
        (candidates[i].getAttribute('aria-label') || '')).trim();
      if (/^request caption/i.test(req)) return candidates[i];
    }
    return null;
  }

  function findCaptionLanguageModal(doc) {
    let dialog = doc.querySelector('.new-LT__selector-language-dialog');
    if (dialog) return dialog.closest('.zm-modal') || dialog;
    let modals = doc.querySelectorAll('.lt-select-language');
    for (let i = 0; i < modals.length; i++) {
      if (modals[i].textContent.indexOf('Set the caption language') >= 0) {
        return modals[i];
      }
    }
    return null;
  }

  function selectEnglishInLanguageModal(doc, modal) {
    let valueEl = modal.querySelector('.transcription-language__single-value');
    let current = valueEl ? valueEl.textContent.trim() : '';
    if (/^english$/i.test(current)) return true;

    let control = modal.querySelector('.transcription-language__control');
    if (control) control.click();

    let options = doc.querySelectorAll(
      '.transcription-language__option, [class*="transcription-language__option"], [role="option"]'
    );
    let i;
    for (i = 0; i < options.length; i++) {
      let label = options[i].textContent.trim();
      if (/^english$/i.test(label)) {
        options[i].click();
        return true;
      }
    }
    return false;
  }

  function tryDismissCaptionLanguageModal(doc) {
    let modal = findCaptionLanguageModal(doc);
    if (!modal) return false;
    if (Date.now() - langModalSaveAt < 1500) return true;

    selectEnglishInLanguageModal(doc, modal);

    let valueEl = modal.querySelector('.transcription-language__single-value');
    let current = valueEl ? valueEl.textContent.trim() : '';
    if (!/^english$/i.test(current)) return false;

    let saveBtn = modal.querySelector('.zm-modal-footer .zm-btn--primary');
    if (!saveBtn) {
      let buttons = modal.querySelectorAll('.zm-modal-footer button, button.zm-btn--primary');
      for (let i = 0; i < buttons.length; i++) {
        if (/^save$/i.test(buttons[i].textContent.trim())) {
          saveBtn = buttons[i];
          break;
        }
      }
    }
    if (!saveBtn) return false;

    langModalSaveAt = Date.now();
    saveBtn.click();
    console.info('[ZT Captions] Caption language modal — English + Save.');
    return true;
  }

  function tryShowCaptions(doc, force) {
    if (captionsVisible(doc)) {
      captionsEnabledOnce = true;
      return true;
    }
    if (!force && Date.now() - openCaptionAttemptAt < 3000) return false;

    let btn = findShowCaptionsButton(doc);
    if (!btn) return false;

    openCaptionAttemptAt = Date.now();
    btn.click();
    console.info('[ZT Captions] Clicked Show Captions.');
    setTimeout(function () {
      try {
        tryDismissCaptionLanguageModal(activeDoc());
      } catch (e) { /* ignore */ }
    }, 400);
    return true;
  }

  function startCaptionsAutoEnable(doc) {
    if (captionsEnableTimer || captionsEnabledOnce) return;

    let attempts = 0;
    let maxAttempts = 40;

    function tick() {
      if (captionsVisible(doc)) {
        captionsEnabledOnce = true;
        if (captionsEnableTimer) clearInterval(captionsEnableTimer);
        captionsEnableTimer = null;
        return;
      }
      attempts++;
      tryShowCaptions(doc, attempts <= 8);
      if (attempts >= maxAttempts && captionsEnableTimer) {
        clearInterval(captionsEnableTimer);
        captionsEnableTimer = null;
        console.warn('[ZT Captions] Could not auto-enable captions — click Show Captions manually.');
      }
    }

    tryShowCaptions(doc, true);
    tick();
    captionsEnableTimer = setInterval(tick, 3000);
  }

  function ensureStyles(doc) {
    if (doc.getElementById('__zt-caption-styles')) return;
    let style = doc.createElement('style');
    style.id = '__zt-caption-styles';
    style.textContent = `
      :root {
        --zt-panel-width: ${panelWidth}px;
        --zt-log-height: ${logHeight}px;

        --zt-widget-bg:           rgba(255,255,255,0.97);
        --zt-widget-border:       rgba(0,0,0,0.09);
        --zt-text-primary:        #111827;
        --zt-text-secondary:      #6b7280;
        --zt-text-dim:            #9ca3af;
        --zt-text-msg:            #374151;
        --zt-text-marker:         #9ca3af;
        --zt-text-idle:           rgba(0,0,0,0.3);
        --zt-text-idle-strong:    #2563eb;
        --zt-session-color:       #111827;
        --zt-session-placeholder: #9ca3af;
        --zt-tab-inactive:        #9ca3af;
        --zt-tab-active-text:     #111827;
        --zt-tab-active-line:     #2563eb;
        --zt-tab-border:          rgba(0,0,0,0.08);
        --zt-search-bg:           rgba(0,0,0,0.04);
        --zt-search-border:       rgba(0,0,0,0.1);
        --zt-search-text:         #111827;
        --zt-search-placeholder:  #9ca3af;
        --zt-entry-border:        rgba(0,0,0,0.05);
        --zt-btn-bg:              rgba(0,0,0,0.05);
        --zt-btn-border:          rgba(0,0,0,0.1);
        --zt-btn-text:            #374151;
        --zt-btn-hover-bg:        rgba(0,0,0,0.09);
        --zt-btn-pause-text:      #92400e;
        --zt-btn-pause-border:    rgba(146,64,14,0.2);
        --zt-btn-pause-bg:        rgba(146,64,14,0.06);
        --zt-btn-pause-hover:     rgba(146,64,14,0.1);
        --zt-btn-stop-text:       #b91c1c;
        --zt-btn-stop-border:     rgba(185,28,28,0.2);
        --zt-btn-stop-bg:         rgba(185,28,28,0.06);
        --zt-btn-stop-hover:      rgba(185,28,28,0.1);
        --zt-btn-primary-text:    #1d4ed8;
        --zt-btn-primary-border:  rgba(29,78,216,0.2);
        --zt-btn-primary-bg:      rgba(29,78,216,0.06);
        --zt-btn-primary-hover:   rgba(29,78,216,0.1);
        --zt-btn-resume-text:     #15803d;
        --zt-btn-resume-border:   rgba(21,128,61,0.2);
        --zt-btn-resume-bg:       rgba(21,128,61,0.06);
        --zt-icon-btn-bg:         rgba(0,0,0,0.05);
        --zt-icon-btn-border:     rgba(0,0,0,0.1);
        --zt-icon-btn-text:       #6b7280;
        --zt-icon-btn-active-bg:  rgba(37,99,235,0.08);
        --zt-icon-btn-active-border: rgba(37,99,235,0.25);
        --zt-icon-btn-active-text: #1d4ed8;
        --zt-footer-border:       rgba(0,0,0,0.07);
        --zt-scrollbar:           rgba(0,0,0,0.14);
        --zt-dropdown-bg:         #ffffff;
        --zt-dropdown-border:     rgba(0,0,0,0.1);
        --zt-dropdown-hover:      rgba(0,0,0,0.04);
        --zt-dropdown-label:      #9ca3af;
        --zt-dropdown-ext:        #9ca3af;
        --zt-dropdown-shadow:     0 8px 24px rgba(0,0,0,0.14);
        --zt-paused-bg:           rgba(161,98,7,0.06);
        --zt-paused-border:       rgba(161,98,7,0.18);
        --zt-paused-text:         #92400e;
        --zt-collapsed-bg:        rgba(255,255,255,0.97);
        --zt-collapsed-hover:     rgba(248,249,250,0.99);
        --zt-chip-bg:             rgba(0,0,0,0.06);
        --zt-stats-label:         #9ca3af;
        --zt-stats-bar-bg:        rgba(0,0,0,0.07);
        --zt-stat-lines-text:     #9ca3af;
        --zt-stat-name-text:      #374151;
        --zt-mark-bg:             rgba(250,204,21,0.25);
        --zt-mark-text:           #92400e;
      }
      .__zt-dark {
        --zt-widget-bg:           rgba(0,0,0,0.82);
        --zt-widget-border:       rgba(255,255,255,0.08);
        --zt-text-primary:        #e8e8e8;
        --zt-text-secondary:      #9aa3af;
        --zt-text-dim:            #4b5563;
        --zt-text-msg:            #d1d5db;
        --zt-text-marker:         #6b7280;
        --zt-text-idle:           rgba(255,255,255,0.35);
        --zt-text-idle-strong:    #7dd3fc;
        --zt-session-color:       #e8e8e8;
        --zt-session-placeholder: #4b5563;
        --zt-tab-inactive:        #6b7280;
        --zt-tab-active-text:     #e8e8e8;
        --zt-tab-active-line:     #7dd3fc;
        --zt-tab-border:          rgba(255,255,255,0.08);
        --zt-search-bg:           rgba(255,255,255,0.06);
        --zt-search-border:       rgba(255,255,255,0.1);
        --zt-search-text:         #e8e8e8;
        --zt-search-placeholder:  #4b5563;
        --zt-entry-border:        rgba(255,255,255,0.04);
        --zt-btn-bg:              rgba(255,255,255,0.08);
        --zt-btn-border:          rgba(255,255,255,0.1);
        --zt-btn-text:            #d1d5db;
        --zt-btn-hover-bg:        rgba(255,255,255,0.14);
        --zt-btn-pause-text:      #fcd34d;
        --zt-btn-pause-border:    rgba(252,211,77,0.2);
        --zt-btn-pause-bg:        rgba(252,211,77,0.07);
        --zt-btn-pause-hover:     rgba(252,211,77,0.14);
        --zt-btn-stop-text:       #f87171;
        --zt-btn-stop-border:     rgba(248,113,113,0.2);
        --zt-btn-stop-bg:         rgba(248,113,113,0.07);
        --zt-btn-stop-hover:      rgba(248,113,113,0.14);
        --zt-btn-primary-text:    #7dd3fc;
        --zt-btn-primary-border:  rgba(125,211,252,0.2);
        --zt-btn-primary-bg:      rgba(125,211,252,0.07);
        --zt-btn-primary-hover:   rgba(125,211,252,0.14);
        --zt-btn-resume-text:     #4ade80;
        --zt-btn-resume-border:   rgba(74,222,128,0.2);
        --zt-btn-resume-bg:       rgba(74,222,128,0.07);
        --zt-icon-btn-bg:         rgba(255,255,255,0.08);
        --zt-icon-btn-border:     rgba(255,255,255,0.1);
        --zt-icon-btn-text:       #aaa;
        --zt-icon-btn-active-bg:  rgba(99,102,241,0.25);
        --zt-icon-btn-active-border: rgba(99,102,241,0.4);
        --zt-icon-btn-active-text: #a5b4fc;
        --zt-footer-border:       rgba(255,255,255,0.07);
        --zt-scrollbar:           rgba(255,255,255,0.15);
        --zt-dropdown-bg:         #1f2937;
        --zt-dropdown-border:     rgba(255,255,255,0.12);
        --zt-dropdown-hover:      rgba(255,255,255,0.07);
        --zt-dropdown-label:      #6b7280;
        --zt-dropdown-ext:        #6b7280;
        --zt-dropdown-shadow:     0 8px 24px rgba(0,0,0,0.5);
        --zt-paused-bg:           rgba(252,211,77,0.08);
        --zt-paused-border:       rgba(252,211,77,0.18);
        --zt-paused-text:         #fcd34d;
        --zt-collapsed-bg:        rgba(0,0,0,0.82);
        --zt-collapsed-hover:     rgba(0,0,0,0.88);
        --zt-chip-bg:             rgba(255,255,255,0.06);
        --zt-stats-label:         #6b7280;
        --zt-stats-bar-bg:        rgba(255,255,255,0.08);
        --zt-stat-lines-text:     #4b5563;
        --zt-stat-name-text:      #e8e8e8;
        --zt-mark-text:           #fde68a;
      }

      /* ── Mount + structural ── */
      .__zt-caption-mount {
        position: relative;
        display: block;
        width: 100%;
        flex: 0 0 auto;
        align-self: stretch;
        margin-top: 6px;
        pointer-events: auto;
        font-family: system-ui, -apple-system, sans-serif;
        box-sizing: border-box;
        background: var(--zt-widget-bg);
        border: 1px solid var(--zt-widget-border);
        border-radius: 10px;
        padding: 8px 10px 10px;
        box-shadow: 0 4px 18px rgba(0,0,0,0.3);
        transition: background 0.2s, border-color 0.2s;
      }
      .__zt-caption-mount *, .__zt-pill * { box-sizing: border-box; }
      .__zt-caption-mount input {
        user-select: text !important;
        -webkit-user-select: text !important;
        pointer-events: auto !important;
      }
      .__zt-resize-handle {
        position: absolute;
        z-index: 1;
      }
      .__zt-resize-handle::after {
        content: '';
        position: absolute;
        border-radius: 2px;
        transition: background 0.15s;
      }
      .__zt-resize-handle:hover::after,
      .__zt-resize-handle.active::after { background: var(--zt-icon-btn-active-border); }
      .__zt-resize-handle--left,
      .__zt-resize-handle--right {
        top: 0;
        bottom: 0;
        width: 16px;
        cursor: ew-resize;
      }
      .__zt-resize-handle--right { right: -8px; }
      .__zt-resize-handle--left { left: -8px; }
      .__zt-resize-handle--left::after,
      .__zt-resize-handle--right::after {
        top: 0;
        bottom: 0;
        left: 6px;
        width: 4px;
      }
      .__zt-resize-handle--top,
      .__zt-resize-handle--bottom {
        left: 0;
        right: 0;
        height: 16px;
        cursor: ns-resize;
      }
      .__zt-resize-handle--bottom { bottom: -8px; }
      .__zt-resize-handle--top { top: -8px; }
      .__zt-resize-handle--top::after,
      .__zt-resize-handle--bottom::after {
        left: 0;
        right: 0;
        top: 6px;
        height: 4px;
      }
      .live-transcription-subtitle__box:has(.__zt-caption-mount) {
        flex-wrap: wrap;
        align-items: stretch;
        width: var(--zt-panel-width) !important;
        min-width: var(--zt-panel-width) !important;
        max-width: var(--zt-panel-width) !important;
        box-sizing: border-box !important;
        display: flex !important;
        visibility: visible !important;
        opacity: 1 !important;
      }
      .live-transcription-subtitle__box:has(.__zt-caption-mount) [id="live-transcription-subtitle"] {
        display: none !important;
      }
      .__zt-caption-dock {
        position: fixed;
        left: 50%;
        transform: translateX(-50%);
        bottom: 68px;
        z-index: 2147483646;
        width: var(--zt-panel-width);
        min-width: var(--zt-panel-width);
        max-width: var(--zt-panel-width);
        padding: 0;
        pointer-events: auto;
        box-sizing: border-box;
        background: transparent;
      }

      /* ── Header ── */
      .__zt-header {
        display: flex;
        align-items: center;
        gap: 8px;
        height: 32px;
        margin-bottom: 6px;
      }
      .__zt-dot {
        width: 9px;
        height: 9px;
        border-radius: 50%;
        flex-shrink: 0;
        background: #6b7280;
      }
      .__zt-dot--rec {
        background: #ef4444;
        box-shadow: 0 0 8px rgba(239,68,68,0.7);
        animation: __zt-blink 1s ease-in-out infinite;
      }
      .__zt-dot--idle { background: #22c55e; box-shadow: none; animation: none; }
      .__zt-dot--waiting { background: #f59e0b; box-shadow: none; animation: none; }
      @keyframes __zt-blink { 0%,100%{opacity:1} 50%{opacity:0.2} }
      .__zt-session-name {
        flex: 1;
        color: var(--zt-session-color);
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        min-width: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        border-radius: 4px;
        padding: 3px 4px;
        margin: -3px -4px;
        transition: background 0.15s;
      }
      .__zt-session-name:hover { background: var(--zt-btn-bg); }
      .__zt-session-name--empty { color: var(--zt-session-placeholder); font-weight: 400; font-style: italic; }
      .__zt-meta {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-shrink: 0;
      }
      .__zt-timer {
        color: var(--zt-text-secondary);
        font-size: 11px;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .__zt-btn-icon {
        background: var(--zt-icon-btn-bg);
        border: 1px solid var(--zt-icon-btn-border);
        color: var(--zt-icon-btn-text);
        width: 24px;
        height: 24px;
        border-radius: 5px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 11px;
        padding: 0;
        transition: background 0.15s, color 0.15s;
        flex-shrink: 0;
        font-family: inherit;
      }
      .__zt-btn-icon:hover { background: var(--zt-btn-hover-bg); color: var(--zt-text-primary); }

      /* ── Paused banner ── */
      .__zt-paused-banner {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        padding: 6px 8px;
        background: var(--zt-paused-bg);
        border: 1px solid var(--zt-paused-border);
        border-radius: 6px;
        margin-bottom: 6px;
        font-size: 12px;
        color: var(--zt-paused-text);
      }
      .__zt-paused-banner .__zt-btn { padding: 3px 8px; font-size: 10px; margin-left: 4px; }

      /* ── Tabs ── */
      .__zt-tabs {
        display: flex;
        gap: 2px;
        margin-bottom: 8px;
        border-bottom: 1px solid var(--zt-tab-border);
      }
      .__zt-tab {
        padding: 5px 12px;
        font-size: 11px;
        font-weight: 600;
        color: var(--zt-tab-inactive);
        cursor: pointer;
        border-bottom: 2px solid transparent;
        margin-bottom: -1px;
        transition: color 0.15s, border-color 0.15s;
        white-space: nowrap;
      }
      .__zt-tab:hover { color: var(--zt-text-secondary); }
      .__zt-tab.active { color: var(--zt-tab-active-text); border-bottom-color: var(--zt-tab-active-line); }

      /* ── Search ── */
      .__zt-search {
        display: none; /* temporarily hidden — restore to flex to bring back search */
        align-items: center;
        gap: 6px;
        background: var(--zt-search-bg);
        border: 1px solid var(--zt-search-border);
        border-radius: 6px;
        padding: 5px 9px;
        margin-bottom: 6px;
        color: var(--zt-search-text);
        transition: background 0.2s;
      }
      .__zt-search svg { opacity: 0.35; flex-shrink: 0; }
      .__zt-search input {
        flex: 1;
        min-width: 0;
        background: transparent;
        border: none;
        outline: none;
        color: var(--zt-search-text);
        font-size: 12px;
        caret-color: var(--zt-tab-active-line);
        font-family: inherit;
        padding: 0;
      }
      .__zt-search input::placeholder { color: var(--zt-search-placeholder); }

      /* ── Log entries ── */
      .__zt-log-entries {
        height: var(--zt-log-height);
        overflow-y: auto;
        overflow-x: hidden;
        padding-right: 2px;
      }
      .__zt-log-entries::-webkit-scrollbar { width: 3px; }
      .__zt-log-entries::-webkit-scrollbar-track { background: transparent; }
      .__zt-log-entries::-webkit-scrollbar-thumb { background: var(--zt-scrollbar); border-radius: 2px; }
      .__zt-log--paused { opacity: 0.45; pointer-events: none; }
      .__zt-entry {
        display: block;
        padding: 1px 0;
        font-size: 12px;
        line-height: 1.45;
      }
      .__zt-entry-header {
        display: flex;
        align-items: baseline;
        gap: 6px;
        margin-bottom: 1px;
      }
      .__zt-entry-time {
        color: var(--zt-text-dim);
        font-size: 10px;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
        flex-shrink: 0;
        min-width: 50px;
      }
      .__zt-entry-name {
        font-size: 11px;
        font-weight: 700;
        white-space: nowrap;
      }
      .__zt-entry-msg {
        display: block;
        color: var(--zt-text-msg);
        word-wrap: break-word;
        padding-left: 56px;
      }
      .__zt-entry-msg mark {
        background: var(--zt-mark-bg);
        color: var(--zt-mark-text);
        border-radius: 2px;
        padding: 0 1px;
      }
      .__zt-entry--marker {
        display: flex;
        align-items: baseline;
        gap: 6px;
      }
      .__zt-entry--marker .__zt-entry-msg {
        color: var(--zt-text-marker);
        font-style: italic;
        font-size: 11px;
        padding-left: 0;
        flex: 1;
        min-width: 0;
      }
      .__zt-entry--run-head,
      .__zt-entry--marker {
        border-top: 1px solid var(--zt-entry-border);
        margin-top: 4px;
        padding-top: 5px;
      }
      #__zt-settled > .__zt-entry:first-child {
        border-top: none;
        margin-top: 0;
        padding-top: 1px;
      }
      .__zt-entry--continued .__zt-entry-header { display: none; }
      .__zt-entry--show-name .__zt-entry-header { display: flex; }
      /* In-flight lines get a pulsing dot in the left gutter; once a line is
         logged the dot disappears and it renders like every other entry. */
      .__zt-entry--pending .__zt-entry-msg { position: relative; }
      .__zt-entry--pending .__zt-entry-msg::before {
        content: '';
        position: absolute;
        left: 44px;
        top: 0.45em;
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #f59e0b;
        animation: __zt-blink 1s ease-in-out infinite;
      }
      /* Just-logged lines run a one-shot pop: the gutter dot turns green,
         swells slightly, and vanishes. */
      .__zt-entry--just-logged .__zt-entry-msg { position: relative; }
      .__zt-entry--just-logged .__zt-entry-msg::before {
        content: '';
        position: absolute;
        left: 44px;
        top: 0.45em;
        width: 6px;
        height: 6px;
        border-radius: 50%;
        animation: __zt-pop 0.55s ease-out forwards;
      }
      @keyframes __zt-pop {
        0%   { background: #f59e0b; transform: scale(1);    opacity: 1; }
        35%  { background: #22c55e; transform: scale(1);    opacity: 1; }
        65%  { background: #22c55e; transform: scale(1.45); opacity: 0.9; }
        100% { background: #22c55e; transform: scale(0.3);  opacity: 0; }
      }
      .__zt-idle {
        color: var(--zt-text-idle);
        font-style: italic;
        font-size: 13px;
        display: flex;
        align-items: center;
        gap: 6px;
        min-height: 36px;
        padding: 8px 0;
      }
      .__zt-idle strong { color: var(--zt-text-idle-strong); margin: 0 4px; font-style: normal; }

      /* ── Stats ── */
      /* Match the log panel's user-set height so switching tabs doesn't
         change the widget size. */
      .__zt-tab-panel[data-panel="stats"] {
        height: var(--zt-log-height);
        overflow-y: auto;
        overflow-x: hidden;
      }
      .__zt-tab-panel[data-panel="stats"]::-webkit-scrollbar { width: 3px; }
      .__zt-tab-panel[data-panel="stats"]::-webkit-scrollbar-track { background: transparent; }
      .__zt-tab-panel[data-panel="stats"]::-webkit-scrollbar-thumb { background: var(--zt-scrollbar); border-radius: 2px; }
      .__zt-stats-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 8px;
      }
      .__zt-stats-label {
        color: var(--zt-stats-label);
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }
      .__zt-stat-row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 5px 0;
        border-bottom: 1px solid var(--zt-entry-border);
      }
      .__zt-stat-row:last-child { border-bottom: none; }
      .__zt-stat-swatch {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex-shrink: 0;
      }
      .__zt-stat-name {
        font-size: 12px;
        color: var(--zt-stat-name-text);
        flex: 1;
        min-width: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .__zt-stat-bar-wrap {
        width: 80px;
        height: 4px;
        background: var(--zt-stats-bar-bg);
        border-radius: 2px;
        overflow: hidden;
        flex-shrink: 0;
      }
      .__zt-stat-bar { height: 100%; border-radius: 2px; }
      .__zt-stat-pct {
        color: var(--zt-text-secondary);
        font-size: 11px;
        font-variant-numeric: tabular-nums;
        width: 28px;
        text-align: right;
        flex-shrink: 0;
      }
      .__zt-stat-lines {
        color: var(--zt-stat-lines-text);
        font-size: 10px;
        width: 44px;
        text-align: right;
        flex-shrink: 0;
      }

      /* ── Footer ── */
      .__zt-footer {
        display: flex;
        align-items: center;
        gap: 5px;
        margin-top: 8px;
        padding-top: 8px;
        border-top: 1px solid var(--zt-footer-border);
      }
      .__zt-btn {
        background: var(--zt-btn-bg);
        border: 1px solid var(--zt-btn-border);
        color: var(--zt-btn-text);
        border-radius: 5px;
        padding: 5px 10px;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 5px;
        white-space: nowrap;
        transition: background 0.15s, color 0.15s;
        font-family: inherit;
      }
      .__zt-btn:hover { background: var(--zt-btn-hover-bg); }
      .__zt-btn--pause { color: var(--zt-btn-pause-text); border-color: var(--zt-btn-pause-border); background: var(--zt-btn-pause-bg); }
      .__zt-btn--pause:hover { background: var(--zt-btn-pause-hover); }
      .__zt-btn--stop { color: var(--zt-btn-stop-text); border-color: var(--zt-btn-stop-border); background: var(--zt-btn-stop-bg); }
      .__zt-btn--stop:hover { background: var(--zt-btn-stop-hover); }
      .__zt-btn--primary { color: var(--zt-btn-primary-text); border-color: var(--zt-btn-primary-border); background: var(--zt-btn-primary-bg); }
      .__zt-btn--primary:hover { background: var(--zt-btn-primary-hover); }
      .__zt-btn--resume { color: var(--zt-btn-resume-text); border-color: var(--zt-btn-resume-border); background: var(--zt-btn-resume-bg); }
      .__zt-spacer { flex: 1; }

      /* ── Download dropdown ── */
      .__zt-download-wrap { position: relative; }
      .__zt-dropdown {
        position: absolute;
        bottom: calc(100% + 5px);
        right: 0;
        background: var(--zt-dropdown-bg);
        border: 1px solid var(--zt-dropdown-border);
        border-radius: 7px;
        overflow: hidden;
        min-width: 130px;
        box-shadow: var(--zt-dropdown-shadow);
        display: none;
        z-index: 2147483647;
      }
      .__zt-dropdown.open { display: block; }
      .__zt-dropdown-label {
        padding: 7px 12px 4px;
        font-size: 10px;
        font-weight: 600;
        color: var(--zt-dropdown-label);
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }
      .__zt-dropdown-item {
        padding: 7px 12px;
        font-size: 12px;
        color: var(--zt-btn-text);
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 8px;
        white-space: nowrap;
        transition: background 0.12s;
      }
      .__zt-dropdown-item:hover { background: var(--zt-dropdown-hover); }
      .__zt-dropdown-item span { color: var(--zt-dropdown-ext); font-size: 10px; flex: 1; text-align: right; }

      /* ── Collapsed pill ── */
      .__zt-pill {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        flex: 0 0 auto;
        align-self: stretch;
        margin-top: 6px;
        padding: 8px 10px;
        pointer-events: auto;
        font-family: system-ui, -apple-system, sans-serif;
        box-sizing: border-box;
        background: var(--zt-collapsed-bg);
        border: 1px solid var(--zt-widget-border);
        border-radius: 10px;
        cursor: pointer;
        box-shadow: 0 4px 18px rgba(0,0,0,0.3);
        transition: background 0.15s;
      }
      .__zt-pill:hover { background: var(--zt-collapsed-hover); }
      .__zt-pill-dot { width: 8px; height: 8px; }
      .__zt-pill-speakers {
        flex: 1;
        display: flex;
        align-items: center;
        gap: 4px;
        min-width: 0;
      }
      .__zt-pill-speaking { font-size: 10px; color: var(--zt-text-secondary); opacity: 0.5; }
      .__zt-pill-meta {
        font-size: 11px;
        color: var(--zt-text-secondary);
        white-space: nowrap;
      }
      .__zt-pill-meta strong { color: var(--zt-text-primary); }
      .__zt-speaker-chip {
        display: flex;
        align-items: center;
        gap: 4px;
        background: var(--zt-chip-bg);
        border-radius: 20px;
        padding: 2px 7px 2px 3px;
        font-size: 10px;
        font-weight: 600;
        color: var(--zt-text-primary);
        min-width: 0;
      }
      .__zt-speaker-chip span {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .__zt-chip-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        flex-shrink: 0;
      }
    `;
    doc.head.appendChild(style);
  }

  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function onCopyClick() {
    flushPending();
    let text = formatOutput();
    if (!text) {
      alert('No captions captured yet. Try __ztCaption.probe() in console.');
      return;
    }
    navigator.clipboard.writeText(text).then(function () {
      let btn = ui && ui.copyBtn;
      if (!btn) return;
      btn.textContent = '✓ Copied';
      setTimeout(function () { btn.textContent = '⎘ Copy'; }, 2000);
    }).catch(function () {
      console.log(text);
      alert('Clipboard blocked — output logged to console.');
    });
  }

  function shutdown() {
    if (pollTimer) clearInterval(pollTimer);
    if (settleTimer) clearTimeout(settleTimer);
    if (captionsEnableTimer) clearInterval(captionsEnableTimer);
    captionsEnableTimer = null;
    if (elapsedTimer) clearInterval(elapsedTimer);
    elapsedTimer = null;
    if (ui && ui.boxObserver) ui.boxObserver.disconnect();
    if (captionDomObserver) captionDomObserver.disconnect();
    teardownAutoDownloadHooks();
    let doc = activeDoc();
    ['__zt-caption-mount', '__zt-pill', '__zt-caption-dock', '__zt-caption-styles'].forEach(function (id) {
      let el = doc.getElementById(id);
      if (el) el.remove();
    });
    doc.documentElement.style.removeProperty('--zt-panel-width');
    window.__ztCaptionLoaded = false;
    delete window.__ztCaption;
  }

  // Zoom's caption box is a react-draggable with global hotkeys on the
  // document: without this, mousedown on the search input starts a box drag
  // instead of focusing, and keystrokes trigger Zoom shortcuts. Shield ONLY
  // the input — shielding the whole widget breaks dragging the box entirely.
  function shieldInputEvents(el) {
    if (!el) return;
    ['mousedown', 'mouseup', 'click', 'dblclick', 'pointerdown', 'pointerup',
      'touchstart', 'keydown', 'keypress', 'keyup'].forEach(function (type) {
      el.addEventListener(type, function (e) { e.stopPropagation(); });
    });
  }

  function syncPrefsFromStorage() {
    darkMode = localStorage.getItem(darkKey) === '1';
    collapsed = localStorage.getItem(collapsedKey) === '1';
  }

  function mountIsHealthy(doc) {
    let mount = doc.getElementById('__zt-caption-mount');
    let pill = doc.getElementById('__zt-pill');
    if (!mount || !pill || !mount.isConnected || !pill.isConnected) return false;
    let box = findCaptionBox(doc);
    if (box) return mount.parentElement === box && pill.parentElement === box;
    let dock = doc.getElementById('__zt-caption-dock');
    return !!(dock && mount.parentElement === dock && pill.parentElement === dock);
  }

  function ensureUiRefs(doc) {
    let mount = doc.getElementById('__zt-caption-mount');
    let pill = doc.getElementById('__zt-pill');
    if (!mount || !pill) return false;
    let box = findCaptionBox(doc);
    let dock = doc.getElementById('__zt-caption-dock');
    ui = ui || {};
    ui.mount = mount;
    ui.pill = pill;
    ui.dock = dock;
    ui.dot = mount.querySelector('#__zt-dot');
    ui.timerEl = mount.querySelector('#__zt-timer');
    ui.modeBtn = mount.querySelector('#__zt-mode-btn');
    ui.pausedBanner = mount.querySelector('#__zt-paused-banner');
    ui.logEntriesEl = mount.querySelector('#__zt-log-entries');
    ui.settledEl = mount.querySelector('#__zt-settled');
    ui.pendingEl = mount.querySelector('#__zt-pending');
    ui.idleEl = mount.querySelector('#__zt-idle');
    ui.statsRowsEl = mount.querySelector('#__zt-stats-rows');
    ui.statsMetaEl = mount.querySelector('#__zt-stats-meta');
    ui.pauseBtn = mount.querySelector('#__zt-pause-btn');
    ui.copyBtn = mount.querySelector('#__zt-copy-btn');
    ui.searchInput = mount.querySelector('#__zt-search-input');
    ui.pillDot = pill.querySelector('#__zt-pill-dot');
    ui.pillChip = pill.querySelector('#__zt-pill-chip');
    ui.pillChipDot = pill.querySelector('#__zt-pill-chip-dot');
    ui.pillChipName = pill.querySelector('#__zt-pill-chip-name');
    ui.pillSpeaking = pill.querySelector('#__zt-pill-speaking');
    ui.pillMeta = pill.querySelector('#__zt-pill-meta');
    ui.usingBox = !!box;
    return true;
  }

  function wireMountEvents(mount, doc) {
    mount.querySelectorAll('.__zt-tab').forEach(function (t) {
      t.classList.toggle('active', t.getAttribute('data-tab') === activeTab);
      t.onclick = function () { switchTab(t.getAttribute('data-tab')); };
    });
    mount.querySelectorAll('.__zt-tab-panel').forEach(function (p) {
      p.style.display = p.getAttribute('data-panel') === activeTab ? '' : 'none';
    });

    let nameEl = mount.querySelector('#__zt-session-name');
    function syncNameDisplay() {
      nameEl.textContent = sessionName || 'Name this meeting…';
      nameEl.classList.toggle('__zt-session-name--empty', !sessionName);
    }
    syncNameDisplay();
    nameEl.onclick = function () {
      let win = doc.defaultView || window;
      let v = win.prompt('Name this meeting:', sessionName);
      if (v === null) return;
      sessionName = v.trim();
      localStorage.setItem(sessionKey, sessionName);
      syncNameDisplay();
    };

    let searchInput = mount.querySelector('#__zt-search-input');
    searchInput.value = searchQuery;
    searchInput.addEventListener('input', function () {
      searchQuery = searchInput.value;
      applyLogFilter();
    });

    mount.querySelector('#__zt-mode-btn').textContent = darkMode ? '🌙' : '☀︎';
    mount.querySelector('#__zt-mode-btn').onclick = toggleMode;
    mount.querySelector('#__zt-collapse-btn').onclick = function () { setCollapsed(true); };
    mount.querySelector('#__zt-pause-btn').onclick = togglePause;
    mount.querySelector('#__zt-banner-resume').onclick = function () { setPaused(false); };
    mount.querySelector('#__zt-copy-btn').onclick = onCopyClick;
    mount.querySelector('#__zt-stop-btn').onclick = shutdown;

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
        let startVal = horiz ? panelWidth : logHeight;
        handle.classList.add('active');
        function onMove(ev) {
          ev.preventDefault();
          let delta = sign * ((horiz ? ev.clientX : ev.clientY) - start);
          if (horiz) {
            panelWidth = Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, startVal + delta));
            applyPanelWidth(doc);
          } else {
            logHeight = Math.max(MIN_LOG_HEIGHT, Math.min(MAX_LOG_HEIGHT, startVal + delta));
            applyLogHeight(doc);
          }
        }
        function onUp() {
          doc.removeEventListener('mousemove', onMove, true);
          doc.removeEventListener('mouseup', onUp, true);
          handle.classList.remove('active');
          if (horiz) localStorage.setItem(widthKey, String(panelWidth));
          else localStorage.setItem(heightKey, String(logHeight));
        }
        doc.addEventListener('mousemove', onMove, true);
        doc.addEventListener('mouseup', onUp, true);
      });
    });

    shieldInputEvents(mount.querySelector('#__zt-search-input'));
  }

  function createMount(doc) {
    ensureStyles(doc);
    let mount = doc.getElementById('__zt-caption-mount');
    if (mount) {
      if (!mount.dataset.ztBound) {
        mount.dataset.ztBound = '1';
        wireMountEvents(mount, doc);
      }
      return mount;
    }

    mount = doc.createElement('div');
    mount.id = '__zt-caption-mount';
    mount.className = '__zt-caption-mount' + (darkMode ? ' __zt-dark' : '');
    if (collapsed) mount.style.display = 'none';
    mount.innerHTML = [
      '<div class="__zt-header">',
        '<div id="__zt-dot" class="__zt-dot __zt-dot--waiting"></div>',
        '<div id="__zt-session-name" class="__zt-session-name" title="Click to name this meeting"></div>',
        '<div class="__zt-meta">',
          '<span id="__zt-timer" class="__zt-timer">0:00</span>',
        '</div>',
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
      '</div>'
    ].join('');

    mount.dataset.ztBound = '1';
    wireMountEvents(mount, doc);
    return mount;
  }

  function createPill(doc) {
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
    pill.className = '__zt-pill' + (darkMode ? ' __zt-dark' : '');
    pill.style.display = collapsed ? 'flex' : 'none';
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

  function keepCaptionBoxVisible(doc, box) {
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

  function ensurePinDock(doc) {
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

  let boxAttachTimer = null;

  function scheduleAttachIfNeeded(doc, box) {
    if (boxAttachTimer) clearTimeout(boxAttachTimer);
    boxAttachTimer = setTimeout(function () {
      boxAttachTimer = null;
      let mount = doc.getElementById('__zt-caption-mount');
      if (!mount || !mount.isConnected || mount.parentElement !== box) {
        attachMount(doc);
      }
    }, 50);
  }

  function observeCaptionBox(doc, box) {
    if (ui && ui.boxObserver && ui.observedBox === box) return;

    if (ui && ui.boxObserver) ui.boxObserver.disconnect();
    let obs = new MutationObserver(function () {
      scheduleAttachIfNeeded(doc, box);
    });
    obs.observe(box, { childList: true });
    if (!ui) ui = {};
    ui.boxObserver = obs;
    ui.observedBox = box;
  }

  function startCaptionDomWatch(doc) {
    if (captionDomObserver) return;
    captionDomObserver = new MutationObserver(function () {
      let mount = doc.getElementById('__zt-caption-mount');
      if (!mount || !mount.isConnected) {
        watchCaptionPanel();
      }
    });
    captionDomObserver.observe(doc.body, { childList: true, subtree: true });
  }

  function attachMount(doc) {
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

      if (!attachBoxLogged) {
        attachBoxLogged = true;
        console.info('[ZT Captions] Attached inside caption box.');
      }
    } else {
      if (mount.parentElement !== dock) dock.appendChild(mount);
      if (pill.parentElement !== dock) dock.appendChild(pill);
      dock.style.display = 'block';

      if (!attachDockLogged) {
        attachDockLogged = true;
        console.info('[ZT Captions] Caption box hidden — keeping pinned recorder visible.');
      }
    }

    startCaptionDomWatch(doc);

    ensureUiRefs(doc);

    applyMode();
    applyCollapsed();
    return true;
  }

  let lastPanelWatchAt = 0;

  function watchCaptionPanel() {
    // updateUI can fire several times per poll tick; the panel scan only
    // needs to run once per tick.
    let now = Date.now();
    if (now - lastPanelWatchAt < 250) return;
    lastPanelWatchAt = now;

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

  // ─── Log rendering ───────────────────────────────────────────────────────
  function buildEntryNode(doc, e, continued, pending) {
    let item = doc.createElement('div');
    let cls = '__zt-entry';
    if (e.marker) cls += ' __zt-entry--marker';
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

  function logNearBottom() {
    if (!ui || !ui.logEntriesEl) return true;
    let el = ui.logEntriesEl;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  }

  function scrollLogToBottom() {
    if (ui && ui.logEntriesEl) ui.logEntriesEl.scrollTop = ui.logEntriesEl.scrollHeight;
  }

  function renderLogItems() {
    if (!ui || !ui.settledEl) return;
    if (renderedLogCount === log.length) return;
    let doc = ui.settledEl.ownerDocument;
    let nearBottom = logNearBottom();

    if (log.length < renderedLogCount) {
      ui.settledEl.innerHTML = '';
      renderedLogCount = 0;
      lastRenderedSpeaker = null;
      nearBottom = true;
    }

    // Only pop on live additions — bulk renders (initial restore, theme
    // rebuild) start from renderedLogCount 0 and skip the animation.
    let animateNew = renderedLogCount > 0;
    for (let i = renderedLogCount; i < log.length; i++) {
      let e = log[i];
      // Guard against duplicate DOM nodes when two recorder instances briefly
      // share the same caption mount (e.g. parent shell + iframe inject).
      let existing = ui.settledEl.querySelector('[data-key="' + e.key.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"]');
      if (existing) continue;
      let continued = !e.marker && !!e.name && e.name === lastRenderedSpeaker;
      let node = buildEntryNode(doc, e, continued, false);
      if (animateNew && !e.marker) {
        node.classList.add('__zt-entry--just-logged');
        node.addEventListener('animationend', function () {
          node.classList.remove('__zt-entry--just-logged');
        }, { once: true });
      }
      ui.settledEl.appendChild(node);
      lastRenderedSpeaker = e.marker ? null : (e.name || null);
    }
    renderedLogCount = log.length;
    if (searchQuery.trim()) applyLogFilter();
    if (nearBottom) scrollLogToBottom();
  }

  function renderPendingItems() {
    if (!ui || !ui.pendingEl) return;
    let doc = ui.pendingEl.ownerDocument;
    let nearBottom = logNearBottom();
    ui.pendingEl.innerHTML = '';
    if (paused || !settleTimer || !pendingLines || !pendingLines.length) return;

    let prevName = lastRenderedSpeaker;
    let appended = 0;
    pendingLines.forEach(function (line) {
      if (!line.msg) return;
      let key = makeKey(line.time, line.name, line.msg);
      if (seen.has(key)) return;
      let continued = !!line.name && line.name === prevName;
      ui.pendingEl.appendChild(buildEntryNode(doc, {
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

  function syncIdle() {
    if (!ui || !ui.idleEl) return;
    let empty = !log.length && !ui.pendingEl.childElementCount;
    ui.idleEl.style.display = empty ? 'flex' : 'none';
    if (!empty) return;
    let text = store
      ? 'Waiting for captions — click <strong>Show Captions</strong> in Zoom if needed'
      : 'Connecting to Zoom…';
    let html = '<div class="__zt-dot __zt-dot--waiting"></div>' + text;
    if (ui.idleEl.innerHTML !== html) ui.idleEl.innerHTML = html;
  }

  // ─── Search ──────────────────────────────────────────────────────────────
  function applyLogFilter() {
    if (!ui || !ui.settledEl) return;
    let q = searchQuery.toLowerCase().trim();
    let rows = ui.settledEl.querySelectorAll('.__zt-entry');
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
  function renderStats() {
    if (!ui || !ui.statsRowsEl) return;
    let doc = ui.statsRowsEl.ownerDocument;
    let names = Object.keys(speakerStats);
    let total = 0;
    let max = 0;
    names.forEach(function (n) {
      total += speakerStats[n];
      if (speakerStats[n] > max) max = speakerStats[n];
    });
    names.sort(function (a, b) { return speakerStats[b] - speakerStats[a]; });

    ui.statsMetaEl.textContent = log.length + (log.length === 1 ? ' line' : ' lines') + ' · ' + elapsedText();

    ui.statsRowsEl.innerHTML = '';
    if (!names.length) {
      ui.statsRowsEl.innerHTML = '<div class="__zt-idle">No speakers yet</div>';
      return;
    }
    names.forEach(function (n) {
      let count = speakerStats[n];
      let color = getSpeakerColor(n);
      let row = doc.createElement('div');
      row.className = '__zt-stat-row';
      row.innerHTML =
        '<div class="__zt-stat-swatch" style="background:' + color + '"></div>' +
        '<div class="__zt-stat-name">' + escapeHtml(n) + '</div>' +
        '<div class="__zt-stat-bar-wrap"><div class="__zt-stat-bar" style="width:' + Math.round(count / max * 100) + '%;background:' + color + '"></div></div>' +
        '<div class="__zt-stat-pct">' + Math.round(count / total * 100) + '%</div>' +
        '<div class="__zt-stat-lines">' + count + (count === 1 ? ' line' : ' lines') + '</div>';
      ui.statsRowsEl.appendChild(row);
    });
  }

  // ─── Elapsed timer ───────────────────────────────────────────────────────
  function startElapsed() {
    if (elapsedStart == null) elapsedStart = Date.now();
    if (!elapsedTimer) elapsedTimer = setInterval(updateTimerDisplay, 1000);
  }

  function elapsedText() {
    if (elapsedStart == null) return '0:00';
    let total = Math.max(0, Math.floor((Date.now() - elapsedStart) / 1000));
    return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
  }

  function updateTimerDisplay() {
    if (!ui) return;
    if (!paused && ui.timerEl) ui.timerEl.textContent = elapsedText();
    if (collapsed) updatePill();
  }

  // ─── Pause ───────────────────────────────────────────────────────────────
  function setPaused(p) {
    if (paused === p) return;
    paused = p;
    addMarker(p ? 'Recording paused' : 'Recording resumed', 'pause-event');
    if (settleTimer) {
      clearTimeout(settleTimer);
      settleTimer = null;
    }
    pendingLines = null;
    if (!p) {
      // Drop everything captured during the pause window: mark current state
      // lines as seen so they never get ingested. pauseSkipped survives the
      // seen-set rebuild in syncSeenFromLog().
      lastSnapshot = '';
      if (store) {
        try {
          extractLines(store.getState()).forEach(function (line) {
            let key = makeKey(line.time, line.name, line.msg);
            pauseSkipped.add(key);
            seen.add(key);
          });
        } catch (e) { /* ignore */ }
      }
    }
    updateUI();
  }

  function togglePause() {
    setPaused(!paused);
  }

  // ─── Light/dark mode ─────────────────────────────────────────────────────
  function applyMode() {
    syncPrefsFromStorage();
    if (!ui) return;
    [ui.mount, ui.pill, ui.dock].forEach(function (el) {
      if (el) el.classList.toggle('__zt-dark', darkMode);
    });
    if (ui.modeBtn) ui.modeBtn.textContent = darkMode ? '🌙' : '☀︎';
  }

  function toggleMode() {
    darkMode = !darkMode;
    localStorage.setItem(darkKey, darkMode ? '1' : '');
    if (ui && ui.settledEl) {
      ui.settledEl.innerHTML = '';
      renderedLogCount = 0;
      lastRenderedSpeaker = null;
    }
    applyMode();
    renderLogItems();
    renderPendingItems();
    updatePill();
  }

  // ─── Collapse ────────────────────────────────────────────────────────────
  function applyCollapsed() {
    syncPrefsFromStorage();
    if (!ui) return;
    if (ui.mount) ui.mount.style.display = collapsed ? 'none' : '';
    if (ui.pill) ui.pill.style.display = collapsed ? 'flex' : 'none';
  }

  function setCollapsed(c) {
    collapsed = c;
    localStorage.setItem(collapsedKey, c ? '1' : '');
    applyCollapsed();
    if (!c) scrollLogToBottom();
    updatePill();
  }

  // ─── Tabs ────────────────────────────────────────────────────────────────
  function switchTab(name) {
    activeTab = name;
    if (!ui || !ui.mount) return;
    ui.mount.querySelectorAll('.__zt-tab').forEach(function (t) {
      t.classList.toggle('active', t.getAttribute('data-tab') === name);
    });
    ui.mount.querySelectorAll('.__zt-tab-panel').forEach(function (p) {
      p.style.display = p.getAttribute('data-panel') === name ? '' : 'none';
    });
    if (name === 'stats') renderStats();
    else scrollLogToBottom();
  }

  // ─── Collapsed pill ──────────────────────────────────────────────────────
  function dotStateClass() {
    if (paused) return '__zt-dot--idle';
    if (settleTimer && pendingLines && pendingLines.length) return '__zt-dot--rec';
    if (store) return '__zt-dot--idle';
    return '__zt-dot--waiting';
  }

  function updatePill() {
    if (!ui || !ui.pill) return;
    ui.pillDot.className = '__zt-dot __zt-pill-dot ' + dotStateClass();

    let speaking = !paused && !!(settleTimer && pendingLines && pendingLines.length);
    let speaker = latestPendingSpeaker();
    if (!speaker) {
      for (let i = log.length - 1; i >= 0; i--) {
        if (log[i].name && !log[i].marker) {
          speaker = log[i].name;
          break;
        }
      }
    }

    if (speaker) {
      ui.pillChip.style.display = 'flex';
      ui.pillChipDot.style.background = getSpeakerColor(speaker);
      ui.pillChipName.textContent = speaker;
      ui.pillSpeaking.style.display = speaking ? '' : 'none';
    } else {
      ui.pillChip.style.display = 'none';
      ui.pillSpeaking.style.display = 'none';
    }

    ui.pillMeta.textContent = elapsedText();
  }

  // ─── Main UI sync ────────────────────────────────────────────────────────
  function updateUI() {
    watchCaptionPanel();
    if (!ui || !ui.mount || !ui.dot) return;

    ui.dot.className = '__zt-dot ' + dotStateClass();

    ui.pausedBanner.style.display = paused ? 'flex' : 'none';
    ui.logEntriesEl.classList.toggle('__zt-log--paused', paused);
    if (paused) {
      ui.pauseBtn.className = '__zt-btn __zt-btn--resume';
      ui.pauseBtn.textContent = '▶ Resume';
    } else {
      ui.pauseBtn.className = '__zt-btn __zt-btn--pause';
      ui.pauseBtn.textContent = '⏸ Pause';
    }

    renderLogItems();
    renderPendingItems();
    syncIdle();
    if (activeTab === 'stats') renderStats();
    if (!paused) ui.timerEl.textContent = elapsedText();
    updatePill();
  }

  // Cancel the settle debounce and capture whatever is pending right now.
  function flushPending() {
    if (settleTimer) {
      clearTimeout(settleTimer);
      settleTimer = null;
    }
    pendingLines = null;
    pollStore();
    if (store) {
      try {
        ingestLines(extractLines(store.getState()));
      } catch (e) { /* ignore */ }
    }
    persistLog();
  }

  // Sorted speaker talk-time, mirroring the Stats tab.
  function talkTimeSummary() {
    let names = Object.keys(speakerStats);
    if (!names.length) return [];
    let total = 0;
    names.forEach(function (n) { total += speakerStats[n]; });
    names.sort(function (a, b) { return speakerStats[b] - speakerStats[a]; });
    return names.map(function (n) {
      let count = speakerStats[n];
      return {
        speaker: n,
        lines: count,
        pct: Math.round(count / total * 100)
      };
    });
  }

  function formatOutput() {
    let lastSpeaker = null;
    let body = log.map(function (e) {
      if (e.marker) {
        lastSpeaker = null;
        return (e.time || '—') + '  ' + e.msg;
      }
      let line = '';
      if (e.name && e.name !== lastSpeaker) {
        line += '\n[' + e.name + ']\n';
        lastSpeaker = e.name;
      }
      line += (e.time || '—') + '  ' + e.msg;
      return line;
    }).join('\n').trim();

    let stats = talkTimeSummary();
    if (stats.length) {
      body += '\n\n— Talk time —\n' + stats.map(function (s) {
        return s.speaker + ': ' + s.pct + '% (' + s.lines + (s.lines === 1 ? ' line' : ' lines') + ')';
      }).join('\n');
    }
    return body;
  }

  function currentSessionName() {
    return sessionName || localStorage.getItem(sessionKey) || '';
  }

  function autoDownloadAlreadyHandled() {
    return localStorage.getItem(autoDownloadKey) === meetingId;
  }

  function claimAutoDownload() {
    if (autoDownloadAlreadyHandled()) return false;
    localStorage.setItem(autoDownloadKey, meetingId);
    return true;
  }

  function releaseAutoDownloadClaim() {
    if (localStorage.getItem(autoDownloadKey) === meetingId) {
      localStorage.removeItem(autoDownloadKey);
    }
  }

  function slugify(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  function downloadFilename(ext) {
    let d = new Date();
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    let prefix = slugify(currentSessionName()) || 'captions';
    return prefix + '-' + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + '-' +
      pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + '.' + (ext || 'txt');
  }

  function downloadJson() {
    flushPending();
    if (!log.length) {
      alert('No captions captured yet. Try __ztCaption.probe() in console.');
      return;
    }
    let payload = {
      session: currentSessionName() || null,
      exportedAt: new Date().toISOString(),
      talkTime: talkTimeSummary(),
      entries: log.map(function (e) {
        return {
          time: e.time || null,
          speaker: e.name || null,
          text: e.msg,
          marker: !!e.marker
        };
      })
    };
    let a = activeDoc().createElement('a');
    a.href = 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(payload, null, 2));
    a.download = downloadFilename('json');
    a.click();
    console.info('[ZT Captions] Downloaded JSON export.');
  }

  function downloadCaptions(options) {
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
      localStorage.removeItem(meetingKey);
      console.info('[ZT Captions] Downloaded captions (' + reason + ') — log cleared for next meeting.');
    } else {
      console.info('[ZT Captions] Downloaded captions (' + reason + ').');
    }
    return true;
  }

  function findMeetingExitButton(target) {
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

  function hasTranscriptToSave() {
    if (log.length) return true;
    return !!(pendingLines && pendingLines.length);
  }

  function teardownAutoDownloadHooks() {
    if (autoDownloadDoc && meetingExitClickHandler) {
      autoDownloadDoc.removeEventListener('click', meetingExitClickHandler, true);
    }
    if (hostEndedObserver) hostEndedObserver.disconnect();
    if (hostEndedTimer) clearTimeout(hostEndedTimer);
    if (autoDownloadWin) {
      if (tabCloseBeforeUnloadHandler) {
        autoDownloadWin.removeEventListener('beforeunload', tabCloseBeforeUnloadHandler);
      }
      if (tabClosePageHideHandler) {
        autoDownloadWin.removeEventListener('pagehide', tabClosePageHideHandler);
      }
    }
    autoDownloadDoc = null;
    autoDownloadWin = null;
    meetingExitClickHandler = null;
    tabCloseBeforeUnloadHandler = null;
    tabClosePageHideHandler = null;
    hostEndedObserver = null;
    hostEndedTimer = null;
    hostEndedTriggered = false;
  }

  function setupAutoDownloadHooks(doc) {
    if (!doc || !doc.body || autoDownloadDoc === doc) return;
    teardownAutoDownloadHooks();

    meetingExitClickHandler = function (e) {
      let hit = findMeetingExitButton(e.target);
      if (hit) downloadCaptions({ auto: true, reason: hit.reason });
    };
    doc.addEventListener('click', meetingExitClickHandler, true);

    hostEndedObserver = new MutationObserver(function () {
      if (hostEndedTriggered || autoDownloadAlreadyHandled()) return;
      let nodes = doc.querySelectorAll(
        '.zm-modal-body-title, .zm-modal-body-content, .confirm-modal-content, [role="dialog"]'
      );
      for (let i = 0; i < nodes.length; i++) {
        let t = nodes[i].textContent || '';
        if (/meeting has been ended by the host/i.test(t) || /ended by host/i.test(t)) {
          if (hostEndedTimer) clearTimeout(hostEndedTimer);
          hostEndedTimer = setTimeout(function () {
            hostEndedTimer = null;
            if (hostEndedTriggered || autoDownloadAlreadyHandled()) return;
            hostEndedTriggered = true;
            downloadCaptions({ auto: true, reason: 'host-ended' });
          }, 400);
          return;
        }
      }
    });
    hostEndedObserver.observe(doc.body, { childList: true, subtree: true });

    // Warn on tab/window close when captions haven't been saved yet; auto-download
    // on actual unload (pagehide). beforeunload can't run custom downloads in
    // modern Chrome, but pagehide still gets a best-effort save attempt.
    let win = doc.defaultView;
    if (win) {
      tabCloseBeforeUnloadHandler = function (e) {
        if (autoDownloadAlreadyHandled() || !hasTranscriptToSave()) return;
        e.preventDefault();
        e.returnValue = '';
      };
      tabClosePageHideHandler = function (e) {
        if (e.persisted || autoDownloadAlreadyHandled()) return;
        flushPending();
        if (!hasTranscriptToSave()) return;
        downloadCaptions({ auto: true, reason: 'tab-close' });
      };
      win.addEventListener('beforeunload', tabCloseBeforeUnloadHandler);
      win.addEventListener('pagehide', tabClosePageHideHandler);
      autoDownloadWin = win;
    }

    autoDownloadDoc = doc;
  }

  function resetLog() {
    if (settleTimer) {
      clearTimeout(settleTimer);
      settleTimer = null;
    }
    pendingLines = null;
    log = [];
    seen = new Set();
    pauseSkipped = new Set();
    lastSnapshot = '';
    renderedLogCount = 0;
    lastRenderedSpeaker = null;
    speakerColorMap = {};
    speakerColorIdx = 0;
    speakerStats = {};
    prevSharers = null;
    elapsedStart = null;
    if (elapsedTimer) {
      clearInterval(elapsedTimer);
      elapsedTimer = null;
    }
    localStorage.removeItem(storageKey);
    if (ui && ui.settledEl) ui.settledEl.innerHTML = '';
    if (ui && ui.pendingEl) ui.pendingEl.innerHTML = '';
    updateUI();
  }

  window.__ztCaption = {
    getLog: function () { return log.slice(); },
    probe: function () {
      wcWin = getWebclientWindow();
      let found = findReduxStore(wcWin.document);
      let info = {
        frame: window === wcWin ? 'webclient' : 'parent-shell',
        wcUrl: wcWin.location.href,
        storeFound: !!found,
        storeActive: !!store,
        lineCount: log.length,
        captionBoxFound: !!findCaptionBox(wcWin.document),
        captionPanelAttached: !!(function () {
          let m = wcWin.document.getElementById('__zt-caption-mount');
          return m && m.isConnected;
        })(),
        captionDockVisible: !!(function () {
          let d = wcWin.document.getElementById('__zt-caption-dock');
          return d && d.style.display !== 'none';
        })()
      };
      if (found) {
        try {
          info.state = probeState(found.getState());
        } catch (e) {
          info.stateError = String(e);
        }
      }
      console.log('[ZT Captions] probe', info);
      return info;
    },
    findStore: function () {
      wcWin = getWebclientWindow();
      return findReduxStore(wcWin.document);
    }
  };

  // Auto-inject into iframe when loaded via <script src="..."> from parent shell
  if (isParentShell() && document.currentScript) {
    let boot = document.currentScript;
    if (boot.src) {
      fetch(boot.src).then(function (r) { return r.text(); }).then(function (src) {
        tryInjectIntoIframe(src);
      }).catch(function (e) {
        console.warn('[ZT Captions] Could not fetch script for iframe inject:', e);
      });
    } else if (boot.textContent) {
      tryInjectIntoIframe(boot.textContent);
    }
  }

  // Parent shell only bootstraps the iframe copy — running the full recorder
  // here too would double-ingest captions and double-render the log.
  if (isParentShell()) {
    let bootScript = document.currentScript;
    let injectRetry = setInterval(function () {
      let win = getWebclientWindow();
      if (win.__ztCaptionLoaded) {
        clearInterval(injectRetry);
        return;
      }
      if (pendingInjectSource) tryInjectIntoIframe(pendingInjectSource);
      else if (bootScript && bootScript.textContent) tryInjectIntoIframe(bootScript.textContent);
    }, 500);
    setTimeout(function () { clearInterval(injectRetry); }, 60000);

    window.__ztCaption = {
      getLog: function () {
        let cap = getWebclientWindow().__ztCaption;
        return cap ? cap.getLog() : [];
      },
      probe: function () {
        let cap = getWebclientWindow().__ztCaption;
        return cap ? cap.probe() : { error: 'iframe recorder not loaded yet' };
      },
      findStore: function () {
        return findReduxStore(getWebclientWindow().document);
      }
    };

    console.info('[ZT Captions] Parent shell bootstrap — recorder runs in #webclient iframe.');
    return window.__ztCaption;
  }

  // pollStore drives the panel watcher each tick via updateUI -> watchCaptionPanel.
  pollTimer = setInterval(pollStore, POLL_MS);
  pollStore();
  try {
    startCaptionsAutoEnable(activeDoc());
  } catch (e) { /* iframe not ready yet */ }
  updateUI();

  console.info('[ZT Captions] Ready. Debug with __ztCaption.probe()');
  return window.__ztCaption;
})();
