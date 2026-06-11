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
    return result;
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

    ltBuckets(state).forEach(function (lt) {
      if (!lt || !lt.allMessages) return;
      let order = Array.isArray(lt.messagesOrder) ? lt.messagesOrder.slice() : [];
      let ids = order.length ? order : Object.keys(lt.allMessages);

      ids.forEach(function (id) {
        let msg = lt.allMessages[id];
        if (!msg) return;
        let text = normalizeText(msg.message || msg.decryptedMessage || msg.text);
        if (!text) return;
        rows.push({
          time: msg.messageTime || '',
          name: resolveName(msg, names),
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
          time: msg.messageTime || '',
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
      time: new Date().toLocaleTimeString(),
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

  if (localStorage.getItem(meetingKey) !== meetingId) {
    localStorage.removeItem(storageKey);
  }
  localStorage.setItem(meetingKey, meetingId);

  let log = dedupLog(JSON.parse(localStorage.getItem(storageKey) || '[]'));
  let seen = new Set(log.map(function (l) { return l.key; }));
  let store = null;
  let pollTimer = null;
  let settleTimer = null;
  let status = 'Looking for Redux store...';
  let lastSnapshot = '';
  let pollCount = 0;
  let pendingLines = null;
  let statusFlash = '';
  let statusFlashUntil = 0;
  let uiMountedHost = null;
  let openCaptionAttemptAt = 0;
  let captionsEnableTimer = null;
  let captionsEnabledOnce = false;
  let langModalSaveAt = 0;
  let renderedLogCount = 0;
  let ui = null;
  let attachBoxLogged = false;
  let attachDockLogged = false;
  let captionDomObserver = null;
  let autoDownloadDoc = null;
  let meetingExitClickHandler = null;
  let hostEndedObserver = null;
  let lastAutoDownloadAt = 0;
  let speakerColorMap = {};
  let speakerColorIdx = 0;
  const SPEAKER_PALETTE = ['#7dd3fc', '#f9a8d4', '#fcd34d', '#86efac', '#c4b5fd', '#fb923c', '#67e8f9', '#f87171'];

  function getSpeakerColor(name) {
    if (!name) return '#9aa3af';
    if (!speakerColorMap[name]) {
      speakerColorMap[name] = SPEAKER_PALETTE[speakerColorIdx % SPEAKER_PALETTE.length];
      speakerColorIdx++;
    }
    return speakerColorMap[name];
  }

  function latestPendingSpeaker() {
    if (!pendingLines) return null;
    for (let i = pendingLines.length - 1; i >= 0; i--) {
      if (pendingLines[i].msg && pendingLines[i].name) return pendingLines[i].name;
    }
    return null;
  }

  function displayStatus() {
    if (statusFlash && Date.now() < statusFlashUntil) return statusFlash;

    if (settleTimer && pendingLines && pendingLines.length) {
      let who = latestPendingSpeaker();
      return who ? 'Recording — ' + who : 'Recording…';
    }

    return 'Listening…';
  }

  function syncSeenFromLog() {
    seen = new Set(log.map(function (l) { return l.key; }));
  }

  function persistLog() {
    log = dedupLog(log);
    syncSeenFromLog();
    if (log.length) {
      localStorage.setItem(storageKey, JSON.stringify(log));
    }
    updateUI();
  }

  function ingestLines(lines) {
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
    return added;
  }

  let prevSharers = null;

  function addShareMarker(text) {
    let time = new Date().toLocaleTimeString();
    let msg = '— ' + text + ' —';
    let key = makeKey(time, null, msg);
    if (seen.has(key)) return;
    seen.add(key);
    log.push({
      key: key,
      time: time,
      name: null,
      msg: msg,
      src: 'share-event',
      marker: true
    });
    persistLog();
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
      status = 'Injected into #webclient iframe...';
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
      if (!store && isParentShell() && pollCount === 4) {
        status = 'Run in #webclient iframe console, or reload with script source available.';
        updateUI();
      }
      if (!store) {
        if (isParentShell()) {
          status = 'Waiting for Redux in #webclient (' + pollCount + ')...';
        } else {
          status = 'Waiting for Redux store (' + pollCount + ')...';
        }
        updateUI();
        return;
      }
      status = 'Connected — waiting for captions';
      console.info('[ZT Captions] Redux store found.');
      updateUI();
    }

    let state;
    try {
      state = store.getState();
    } catch (e) {
      store = null;
      status = 'Redux store lost — retrying...';
      updateUI();
      return;
    }

    trackShareEvents(state);

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
        let added = ingestLines(lines);
        pendingLines = null;
        if (added) {
          statusFlash = 'Logged ' + added + (added === 1 ? ' line' : ' lines');
          statusFlashUntil = Date.now() + 2000;
        }
        persistLog();
      }, SETTLE_MS);
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
    el.style.setProperty('width', CAPTION_PANEL_WIDTH + 'px', 'important');
    el.style.setProperty('min-width', CAPTION_PANEL_WIDTH + 'px', 'important');
    el.style.setProperty('max-width', CAPTION_PANEL_WIDTH + 'px', 'important');
    el.style.setProperty('box-sizing', 'border-box', 'important');
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
        --zt-panel-width: ${CAPTION_PANEL_WIDTH}px;
      }
      .__zt-caption-mount {
        display: block;
        width: 100%;
        flex: 0 0 auto;
        align-self: stretch;
        margin-top: 6px;
        pointer-events: auto;
        font-family: system-ui, sans-serif;
        box-sizing: border-box;
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
      .__zt-caption-bar {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        padding: 6px 10px;
        background: rgba(0, 0, 0, 0.72);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 8px;
        color: #e8e8e8;
        font-size: 11px;
      }
      .__zt-caption-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex-shrink: 0;
        background: #555;
      }
      .__zt-caption-dot--rec {
        background: #ef4444 !important;
        box-shadow: 0 0 8px rgba(239, 68, 68, 0.8);
        animation: __zt-rec-blink 1s ease-in-out infinite;
      }
      @keyframes __zt-rec-blink {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.25; }
      }
      .__zt-caption-status {
        flex: 1;
        min-width: 0;
        color: #ccc;
        line-height: 1.35;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .__zt-caption-meta {
        color: #fff;
        font-weight: 700;
        white-space: nowrap;
        flex-shrink: 0;
      }
      .__zt-caption-actions {
        display: flex;
        gap: 4px;
        flex-wrap: wrap;
        flex-shrink: 0;
      }
      .__zt-caption-actions button {
        background: rgba(255, 255, 255, 0.1);
        border: 1px solid rgba(255, 255, 255, 0.14);
        color: #fff;
        border-radius: 5px;
        padding: 3px 8px;
        font-size: 10px;
        font-weight: 600;
        cursor: pointer;
      }
      .__zt-caption-actions button:hover {
        background: rgba(255, 255, 255, 0.18);
      }
      .__zt-caption-log {
        margin-top: 6px;
        max-height: 140px;
        overflow-y: auto;
        overflow-x: hidden;
        padding: 6px 8px;
        background: rgba(0, 0, 0, 0.55);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 8px;
        width: 100%;
        box-sizing: border-box;
      }
      .__zt-log-item {
        font-size: 12px;
        line-height: 1.4;
        color: #f3f3f3;
        margin-bottom: 6px;
        word-wrap: break-word;
      }
      .__zt-log-item:last-child {
        margin-bottom: 0;
      }
      .__zt-log-item--marker {
        color: #9aa3af;
        font-style: italic;
      }
      .__zt-log-time {
        color: #9aa3af;
        font-size: 10px;
        margin-right: 6px;
      }
      .__zt-log-name {
        font-size: 10px;
        font-weight: 700;
        margin-right: 6px;
      }
      .live-transcription-subtitle__box:has(.__zt-caption-mount) [id="live-transcription-subtitle"] {
        display: none !important;
      }
      #__zt-live-overlay {
        display: flex;
        flex-direction: column;
        gap: 2px;
        width: 100%;
        box-sizing: border-box;
      }
      .__zt-live-row {
        display: flex;
        align-items: flex-start;
        gap: 6px;
        padding: 2px 0;
      }
      .__zt-live-avatar {
        display: inline-flex;
        flex-shrink: 0;
      }
      .__zt-live-text {
        flex: 1;
        min-width: 0;
        line-height: 1.4;
        word-wrap: break-word;
      }
      .__zt-w {
        color: #fff;
        transition: color 0.4s ease;
      }
      .__zt-w--rec {
        color: #4ade80;
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
        padding: 8px 10px;
        pointer-events: auto;
        box-sizing: border-box;
        background: rgba(0, 0, 0, 0.78);
        border-radius: 8px;
        box-shadow: 0 4px 18px rgba(0, 0, 0, 0.45);
      }
      .__zt-caption-idle-line {
        color: rgba(255, 255, 255, 0.45);
        font-style: italic;
        font-size: 12px;
        line-height: 1.4;
        margin-bottom: 6px;
        display: flex;
        align-items: center;
        min-height: 24px;
      }
      .__zt-caption-fallback {
        position: fixed;
        bottom: 16px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 2147483646;
        width: var(--zt-panel-width);
        pointer-events: auto;
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

  function onSaveClick() {
    downloadCaptions({ auto: false, reason: 'manual' });
  }

  function onCopyClick() {
    flushPending();
    let text = formatOutput();
    if (!text) {
      alert('No captions captured yet. Try __ztCaption.probe() in console.');
      return;
    }
    navigator.clipboard.writeText(text).then(function () {
      let btn = ui && ui.mount && ui.mount.querySelector('#__zt-caption-copy');
      if (!btn) return;
      btn.textContent = 'Copied!';
      setTimeout(function () { btn.textContent = 'Copy'; }, 2000);
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
    if (ui && ui.boxObserver) ui.boxObserver.disconnect();
    if (captionDomObserver) captionDomObserver.disconnect();
    teardownAutoDownloadHooks();
    let doc = activeDoc();
    let mount = doc.getElementById('__zt-caption-mount');
    if (mount) mount.remove();
    let dock = doc.getElementById('__zt-caption-dock');
    if (dock) dock.remove();
    let idle = doc.getElementById('__zt-caption-idle');
    if (idle) idle.remove();
    let fallback = doc.getElementById('__zt-caption-fallback');
    if (fallback) fallback.remove();
    let overlay = doc.getElementById('__zt-live-overlay');
    if (overlay) overlay.remove();
    let styles = doc.getElementById('__zt-caption-styles');
    if (styles) styles.remove();
    window.__ztCaptionLoaded = false;
    delete window.__ztCaption;
  }

  function createMount(doc) {
    ensureStyles(doc);
    let mount = doc.createElement('div');
    mount.id = '__zt-caption-mount';
    mount.className = '__zt-caption-mount';
    mount.innerHTML = [
      '<div class="__zt-caption-bar">',
        '<div id="__zt-caption-dot" class="__zt-caption-dot"></div>',
        '<div id="__zt-caption-status" class="__zt-caption-status">Initializing…</div>',
        '<span id="__zt-caption-count" class="__zt-caption-meta">0 saved</span>',
        '<div class="__zt-caption-actions">',
          '<button id="__zt-caption-copy" type="button">Copy</button>',
          '<button id="__zt-caption-save" type="button">Download</button>',
          '<button id="__zt-caption-close" type="button">Stop</button>',
        '</div>',
      '</div>',
      '<div id="__zt-caption-log" class="__zt-caption-log"></div>'
    ].join('');

    mount.querySelector('#__zt-caption-save').onclick = onSaveClick;
    mount.querySelector('#__zt-caption-copy').onclick = onCopyClick;
    mount.querySelector('#__zt-caption-close').onclick = shutdown;

    return mount;
  }

  function getLiveSubtitleRows(doc) {
    return doc.querySelectorAll('[id="live-transcription-subtitle"]');
  }

  function hasLiveCaptionText(doc) {
    let rows = getLiveSubtitleRows(doc);
    for (let i = 0; i < rows.length; i++) {
      let line = rows[i].querySelector('.live-transcription-subtitle__item, .live-transcription-subtitle__yellowitem');
      if (line && line.textContent && line.textContent.trim()) return true;
    }
    return false;
  }

  function normalizeCaptionText(text) {
    return String(text || '').replace(/\uFFFD/g, '').replace(/\s+/g, ' ').trim();
  }

  // Cache of normalized log messages, rebuilt only when the log changes
  // (ingest appends in place; dedup/reset replace the array entirely).
  let msgsCacheSrc = null;
  let msgsCacheLen = -1;
  let msgsCache = [];

  function normalizedLogMsgs() {
    if (msgsCacheSrc !== log || msgsCacheLen !== log.length) {
      msgsCache = [];
      for (let i = 0; i < log.length; i++) {
        let m = normalizeCaptionText(log[i].msg);
        if (m) msgsCache.push(m);
      }
      msgsCacheSrc = log;
      msgsCacheLen = log.length;
    }
    return msgsCache;
  }

  // Length of the leading portion of `norm` covered by saved log entries.
  // Zoom may concatenate several utterances into one subtitle row, so keep
  // consuming consecutive log entries against the remainder of the text.
  function recordedPrefixLength(norm) {
    if (!norm) return 0;

    let msgs = normalizedLogMsgs();

    let pos = 0;
    let advanced = true;
    while (advanced && pos < norm.length) {
      advanced = false;
      while (norm.charAt(pos) === ' ') pos++;
      let rest = norm.slice(pos);
      if (!rest) break;

      let best = 0;
      for (let j = msgs.length - 1; j >= 0; j--) {
        let msg = msgs[j];
        // Remainder is a prefix of a saved entry (log already holds a longer
        // merged version) — everything visible is recorded.
        if (rest.length <= msg.length && msg.indexOf(rest) === 0) return norm.length;
        if (msg.length > best && rest.indexOf(msg) === 0) best = msg.length;
      }

      if (best > 0) {
        pos += best;
        advanced = true;
      }
    }
    return pos;
  }

  // Number of leading words of `norm` that are recorded, snapped to a word boundary.
  function recordedWordCount(norm, words) {
    let n = recordedPrefixLength(norm);
    if (n <= 0) return 0;
    if (n >= norm.length) return words.length;
    let cut = norm.charAt(n) === ' ' ? n : norm.lastIndexOf(' ', n);
    if (cut <= 0) return 0;
    return norm.slice(0, cut).split(' ').length;
  }

  function updateRowWords(doc, textWrap, words, recCount) {
    while (textWrap.children.length > words.length) {
      textWrap.removeChild(textWrap.lastChild);
    }
    for (let i = 0; i < words.length; i++) {
      let s = textWrap.children[i];
      if (!s) {
        s = doc.createElement('span');
        s.className = '__zt-w';
        textWrap.appendChild(s);
      }
      let t = words[i] + ' ';
      if (s.textContent !== t) s.textContent = t;
      if (i < recCount) s.classList.add('__zt-w--rec');
      else s.classList.remove('__zt-w--rec');
    }
  }

  function renderLiveOverlay(doc) {
    let box = findCaptionBox(doc);
    if (!box) return;

    let ov = box.querySelector('#__zt-live-overlay');
    if (!ov) {
      ov = doc.createElement('div');
      ov.id = '__zt-live-overlay';
      box.appendChild(ov);
    }

    let rows = box.querySelectorAll('[id="live-transcription-subtitle"]');
    let used = 0;

    for (let i = 0; i < rows.length; i++) {
      let native = rows[i];
      let line = native.querySelector('.live-transcription-subtitle__item, .live-transcription-subtitle__yellowitem');
      let norm = normalizeCaptionText(line ? line.textContent : '');
      if (!norm) continue;

      let reps = ov.querySelectorAll('.__zt-live-row');
      let rep = reps[used];
      if (!rep) {
        rep = doc.createElement('div');
        rep.className = '__zt-live-row';
        rep.innerHTML = '<span class="__zt-live-avatar"></span><span class="__zt-live-text"></span>';
        ov.appendChild(rep);
      }
      used++;

      let avatarHolder = rep.querySelector('.__zt-live-avatar');
      let nativeAvatar = native.querySelector('.zmu-data-selector-item__icon');
      let avatarKey = nativeAvatar
        ? (nativeAvatar.tagName === 'IMG' ? nativeAvatar.getAttribute('src') : nativeAvatar.outerHTML)
        : '';
      if (rep.getAttribute('data-avatar') !== avatarKey) {
        rep.setAttribute('data-avatar', avatarKey);
        avatarHolder.innerHTML = '';
        if (nativeAvatar) avatarHolder.appendChild(nativeAvatar.cloneNode(true));
      }

      let words = norm.split(' ');
      updateRowWords(doc, rep.querySelector('.__zt-live-text'), words, recordedWordCount(norm, words));
    }

    let allReps = ov.querySelectorAll('.__zt-live-row');
    for (let j = allReps.length - 1; j >= used; j--) {
      allReps[j].remove();
    }

    syncIdleLine(doc, ov);
  }

  function syncIdleLine(doc, container) {
    if (!container) return;
    let idle = doc.getElementById('__zt-caption-idle');
    if (!hasLiveCaptionText(doc)) {
      if (!idle) {
        idle = doc.createElement('div');
        idle.id = '__zt-caption-idle';
        idle.className = '__zt-caption-idle-line';
        idle.textContent = 'Listening…';
      }
      if (idle.parentElement !== container) {
        container.insertBefore(idle, container.firstChild);
      }
    } else if (idle) {
      idle.remove();
    }
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

  function createFallback(doc) {
    ensureStyles(doc);
    let fallback = doc.createElement('div');
    fallback.id = '__zt-caption-fallback';
    fallback.className = '__zt-caption-fallback';
    fallback.style.display = 'none';
    fallback.appendChild(createMount(doc));
    doc.body.appendChild(fallback);
    return fallback;
  }

  function observeCaptionBox(doc, box) {
    if (ui && ui.boxObserver && ui.observedBox === box) return;

    if (ui && ui.boxObserver) ui.boxObserver.disconnect();
    let obs = new MutationObserver(function () {
      let mount = doc.getElementById('__zt-caption-mount');
      if (!mount || !mount.isConnected || mount.parentElement !== box) {
        attachMount(doc);
      }
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

    let box = findCaptionBox(doc);
    let dock = ensurePinDock(doc);
    let usingBox = false;

    if (box) {
      keepCaptionBoxVisible(doc, box);
      observeCaptionBox(doc, box);
      if (mount.parentElement !== box) box.appendChild(mount);
      dock.style.display = 'none';
      uiMountedHost = box;
      usingBox = true;

      if (box.style.bottom) dock.style.bottom = box.style.bottom;

      if (!attachBoxLogged) {
        attachBoxLogged = true;
        console.info('[ZT Captions] Attached inside caption box.');
      }
    } else {
      syncIdleLine(doc, dock);
      if (mount.parentElement !== dock) dock.appendChild(mount);
      dock.style.display = 'block';
      uiMountedHost = null;

      if (!attachDockLogged) {
        attachDockLogged = true;
        console.info('[ZT Captions] Caption box hidden — keeping pinned recorder visible.');
      }
    }

    startCaptionDomWatch(doc);

    let fallback = doc.getElementById('__zt-caption-fallback');
    if (fallback) fallback.style.display = 'none';

    ui = ui || {};
    ui.mount = mount;
    ui.dock = dock;
    ui.fallback = fallback;
    ui.dot = mount.querySelector('#__zt-caption-dot');
    ui.statusEl = mount.querySelector('#__zt-caption-status');
    ui.countEl = mount.querySelector('#__zt-caption-count');
    ui.logEl = mount.querySelector('#__zt-caption-log');
    ui.usingBox = usingBox;
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
    attachMount(doc);
    try {
      renderLiveOverlay(doc);
    } catch (e) { /* ignore */ }

    if (ui && ui.statusEl && !store) {
      ui.statusEl.textContent = status;
    }
  }

  function renderLogItems() {
    if (!ui || !ui.logEl) return;
    if (renderedLogCount === log.length) return;

    if (log.length < renderedLogCount) {
      ui.logEl.innerHTML = '';
      renderedLogCount = 0;
    }

    for (let i = renderedLogCount; i < log.length; i++) {
      let e = log[i];
      let item = ui.logEl.ownerDocument.createElement('div');
      item.className = '__zt-log-item' + (e.marker ? ' __zt-log-item--marker' : '');
      item.setAttribute('data-key', e.key);
      item.innerHTML =
        '<span class="__zt-log-time">' + escapeHtml(e.time || '—') + '</span>' +
        (e.name
          ? '<span class="__zt-log-name" style="color:' + getSpeakerColor(e.name) + '">' + escapeHtml(e.name) + '</span>'
          : '') +
        '<span class="__zt-log-msg">' + escapeHtml(e.msg) + '</span>';
      ui.logEl.appendChild(item);
    }
    renderedLogCount = log.length;
    ui.logEl.scrollTop = ui.logEl.scrollHeight;
  }

  function updateUI() {
    watchCaptionPanel();
    if (!ui || !ui.statusEl) return;

    ui.countEl.textContent = log.length + ' saved';
    ui.statusEl.textContent = store ? displayStatus() : status;

    if (store && settleTimer && pendingLines && pendingLines.length &&
        !(statusFlash && Date.now() < statusFlashUntil)) {
      let who = latestPendingSpeaker();
      if (who) {
        ui.statusEl.innerHTML = 'Recording — <span style="color:' +
          getSpeakerColor(who) + ';font-weight:700">' + escapeHtml(who) + '</span>';
      }
    }

    if (settleTimer && pendingLines && pendingLines.length) {
      ui.dot.classList.add('__zt-caption-dot--rec');
      ui.dot.style.background = '';
      ui.dot.style.boxShadow = '';
    } else if (store) {
      ui.dot.classList.remove('__zt-caption-dot--rec');
      ui.dot.style.background = '#22c55e';
      ui.dot.style.boxShadow = 'none';
    } else {
      ui.dot.classList.remove('__zt-caption-dot--rec');
      ui.dot.style.background = '#f59e0b';
      ui.dot.style.boxShadow = 'none';
    }

    renderLogItems();
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

  function formatOutput() {
    let lastSpeaker = null;
    return log.map(function (e) {
      let line = '';
      if (e.name && e.name !== lastSpeaker) {
        line += '\n[' + e.name + ']\n';
        lastSpeaker = e.name;
      }
      line += (e.time || '—') + '  ' + e.msg;
      return line;
    }).join('\n').trim();
  }

  function downloadFilename() {
    let d = new Date();
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    return 'captions-' + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + '-' +
      pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + '.txt';
  }

  function downloadCaptions(options) {
    options = options || {};
    let isAuto = !!options.auto;
    let reason = options.reason || 'manual';

    if (isAuto && Date.now() - lastAutoDownloadAt < 5000) return false;

    flushPending();
    let text = formatOutput();
    if (!text) {
      if (!isAuto) alert('No captions captured yet. Try __ztCaption.probe() in console.');
      return false;
    }

    let a = activeDoc().createElement('a');
    a.href = 'data:text/plain;charset=utf-8,' + encodeURIComponent(text);
    a.download = downloadFilename();
    a.click();

    if (isAuto) {
      lastAutoDownloadAt = Date.now();
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

  function teardownAutoDownloadHooks() {
    if (autoDownloadDoc && meetingExitClickHandler) {
      autoDownloadDoc.removeEventListener('click', meetingExitClickHandler, true);
    }
    if (hostEndedObserver) hostEndedObserver.disconnect();
    autoDownloadDoc = null;
    meetingExitClickHandler = null;
    hostEndedObserver = null;
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
      let nodes = doc.querySelectorAll(
        '.zm-modal-body-title, .zm-modal-body-content, .confirm-modal-content, [role="dialog"]'
      );
      for (let i = 0; i < nodes.length; i++) {
        let t = nodes[i].textContent || '';
        if (/meeting has been ended by the host/i.test(t) || /ended by host/i.test(t)) {
          downloadCaptions({ auto: true, reason: 'host-ended' });
          return;
        }
      }
    });
    hostEndedObserver.observe(doc.body, { childList: true, subtree: true });
    autoDownloadDoc = doc;
  }

  function resetLog() {
    if (settleTimer) {
      clearTimeout(settleTimer);
      settleTimer = null;
    }
    pendingLines = null;
    statusFlash = '';
    statusFlashUntil = 0;
    log = [];
    seen = new Set();
    lastSnapshot = '';
    renderedLogCount = 0;
    speakerColorMap = {};
    speakerColorIdx = 0;
    prevSharers = null;
    localStorage.removeItem(storageKey);
    if (ui && ui.logEl) ui.logEl.innerHTML = '';
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
