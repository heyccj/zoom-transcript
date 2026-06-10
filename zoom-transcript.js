(function () {
  if (window.__ztCaptionLoaded) {
    console.warn('[ZT Captions] Already running in this frame.');
    return window.__ztCaption;
  }
  window.__ztCaptionLoaded = true;

  var POLL_MS = 800;
  var SETTLE_MS = 3000;
  var CAPTION_PANEL_WIDTH = 500;
  var injectAttempted = false;

  // ─── Dedup ───────────────────────────────────────────────────────────────
  function makeKey(time, name, msg) {
    return (time || '') + '|' + (name || '') + '|' + msg.slice(0, 40);
  }

  function isProgressiveUpdate(prev, time, name, msg) {
    if (prev.time !== time || prev.name !== name) return false;
    return msg.indexOf(prev.msg) === 0 || prev.msg.indexOf(msg) === 0;
  }

  function dedupLog(entries) {
    var result = [];
    entries.forEach(function (e) {
      var matchIdx = -1;
      for (var j = result.length - 1; j >= 0; j--) {
        var prev = result[j];
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
          src: e.src
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
      var path = win.location.pathname;
      var match = path.match(/\/wc\/(\d+)/) || path.match(/\/j\/(\d+)/);
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

    var iframe = document.getElementById('webclient');
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

    var props = fiber.memoizedProps;
    if (props) {
      if (looksLikeStore(props.store)) return props.store;
      if (props.value && looksLikeStore(props.value.store)) return props.value.store;
    }

    var state = fiber.memoizedState;
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
    var keys = Object.keys(node);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactContainer$') === 0) {
        out.push(node[k]);
      }
    }
    for (var c = node.firstChild; c; c = c.nextSibling) {
      collectFibers(c, out, limit);
    }
  }

  function findReduxStore(doc) {
    var roots = [
      doc.getElementById('zmmtg-root'),
      doc.getElementById('root'),
      doc.getElementById('wc-container'),
      doc.body
    ].filter(Boolean);

    var fibers = [];
    roots.forEach(function (root) { collectFibers(root, fibers, 40); });

    for (var i = 0; i < fibers.length; i++) {
      var store = storeFromFiber(fibers[i], new Set());
      if (store) return store;
    }
    return null;
  }

  function attendeeNameMap(state) {
    var map = {};
    var lists = [];

    if (state.attendeesList && state.attendeesList.attendeesList) {
      lists.push(state.attendeesList.attendeesList);
    }
    if (state.attendeesList && Array.isArray(state.attendeesList.list)) {
      lists.push(state.attendeesList.list);
    }

    lists.forEach(function (list) {
      list.forEach(function (a) {
        if (!a) return;
        var id = a.userId != null ? a.userId : a.zoomID;
        var name = a.displayName || a.name;
        if (id != null && name) map[id] = name;
      });
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
    var buckets = [];
    if (state.liveTranscription) buckets.push(state.liveTranscription);
    if (state.newLiveTranscription && state.newLiveTranscription !== state.liveTranscription) {
      buckets.push(state.newLiveTranscription);
    }
    return buckets;
  }

  function linesFromAllMessages(state, names) {
    var rows = [];

    ltBuckets(state).forEach(function (lt) {
      if (!lt || !lt.allMessages) return;
      var order = Array.isArray(lt.messagesOrder) ? lt.messagesOrder.slice() : [];
      var ids = order.length ? order : Object.keys(lt.allMessages);

      ids.forEach(function (id) {
        var msg = lt.allMessages[id];
        if (!msg) return;
        var text = normalizeText(msg.message || msg.decryptedMessage || msg.text);
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
    var rows = [];

    ltBuckets(state).forEach(function (lt) {
      if (!lt || !lt.newLTMessage) return;
      Object.keys(lt.newLTMessage).forEach(function (id) {
        var msg = lt.newLTMessage[id];
        var text = normalizeText(msg.text || msg.message);
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
    var text = normalizeText(state.meeting && state.meeting.messageLatest);
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
    var names = attendeeNameMap(state);
    var fromAll = linesFromAllMessages(state, names);
    if (fromAll.length) return fromAll;

    var fromNew = linesFromNewLTMessage(state, names);
    if (fromNew.length) return fromNew;

    return linesFromMessageLatest(state);
  }

  function probeState(state) {
    var lt = ltBuckets(state);
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
  var wcWin = getWebclientWindow();
  var meetingId = getMeetingId(wcWin);
  var storageKey = '__ztCaptionLog';
  var meetingKey = '__ztCaptionMeetingId';

  if (localStorage.getItem(meetingKey) !== meetingId) {
    localStorage.removeItem(storageKey);
  }
  localStorage.setItem(meetingKey, meetingId);

  var log = dedupLog(JSON.parse(localStorage.getItem(storageKey) || '[]'));
  var seen = new Set(log.map(function (l) { return l.key; }));
  var store = null;
  var pollTimer = null;
  var settleTimer = null;
  var lastCapturedTime = null;
  var status = 'Looking for Redux store...';
  var lastSnapshot = '';
  var pollCount = 0;
  var pendingLines = null;
  var statusFlash = '';
  var statusFlashUntil = 0;
  var uiMountedHost = null;
  var openCaptionAttemptAt = 0;
  var captionsEnableTimer = null;
  var captionsEnabledOnce = false;
  var langModalSaveAt = 0;
  var panelWatchTimer = null;
  var renderedLogCount = 0;
  var ui = null;
  var captionDomObserver = null;
  var autoDownloadDoc = null;
  var meetingExitClickHandler = null;
  var hostEndedObserver = null;
  var lastAutoDownloadAt = 0;
  var speakerColorMap = {};
  var speakerColorIdx = 0;
  var SPEAKER_PALETTE = ['#7dd3fc', '#f9a8d4', '#fcd34d', '#86efac', '#c4b5fd', '#fb923c', '#67e8f9', '#f87171'];

  function getSpeakerColor(name) {
    if (!name) return '#9aa3af';
    if (!speakerColorMap[name]) {
      speakerColorMap[name] = SPEAKER_PALETTE[speakerColorIdx % SPEAKER_PALETTE.length];
      speakerColorIdx++;
    }
    return speakerColorMap[name];
  }

  function displayStatus() {
    if (statusFlash && Date.now() < statusFlashUntil) return statusFlash;

    if (settleTimer && pendingLines && pendingLines.length) {
      return 'Capturing…';
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
      lastCapturedTime = new Date().toLocaleTimeString();
      localStorage.setItem(storageKey, JSON.stringify(log));
    }
    updateUI();
  }

  function ingestLines(lines) {
    var added = 0;
    lines.forEach(function (line) {
      var key = makeKey(line.time, line.name, line.msg);
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

  function tryInjectIntoIframe(source) {
    if (injectAttempted || !source) return false;
    var iframe = document.getElementById('webclient');
    if (!iframe || !iframe.contentWindow || !iframe.contentDocument) return false;

    try {
      if (iframe.contentWindow.__ztCaptionLoaded) return true;
      injectAttempted = true;
      var script = iframe.contentDocument.createElement('script');
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

    var state;
    try {
      state = store.getState();
    } catch (e) {
      store = null;
      status = 'Redux store lost — retrying...';
      updateUI();
      return;
    }

    var lines = extractLines(state);
    var snapshot = JSON.stringify(lines.map(function (l) {
      return [l.time, l.name, l.msg, l.finished];
    }));

    if (snapshot !== lastSnapshot) {
      lastSnapshot = snapshot;
      pendingLines = lines;
      if (settleTimer) clearTimeout(settleTimer);
      updateUI();
      settleTimer = setTimeout(function () {
        settleTimer = null;
        var added = ingestLines(lines);
        pendingLines = null;
        if (added) {
          statusFlash = 'Logged ' + added + (added === 1 ? ' line' : ' lines');
          statusFlashUntil = Date.now() + 2000;
        }
        persistLog();
      }, SETTLE_MS);
    }

    if (store) updateUI();
    watchCaptionPanel();
  }

  // ─── Caption panel UI (on-screen subtitles, not transcript sidebar) ─────
  function activeDoc() {
    wcWin = getWebclientWindow();
    return wcWin.document;
  }

  function findCaptionBox(doc) {
    var sub = doc.getElementById('live-transcription-subtitle');
    if (sub && sub.closest) {
      var inBox = sub.closest('.live-transcription-subtitle__box');
      if (inBox) return inBox;
    }
    return doc.querySelector('.live-transcription-subtitle__box');
  }

  function findCaptionHost(doc) {
    return findCaptionBox(doc) || doc.querySelector('.lt-subtitle-wrap');
  }

  function captionsVisible(doc) {
    var sub = doc.getElementById('live-transcription-subtitle');
    if (!sub) return false;
    if (sub.style.display === 'none') return false;
    var box = sub.closest('.live-transcription-subtitle__box');
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
    var candidates = doc.querySelectorAll('button[title], button[aria-label]');
    var i;
    for (i = 0; i < candidates.length; i++) {
      var label = ((candidates[i].getAttribute('title') || '') + ' ' +
        (candidates[i].getAttribute('aria-label') || '')).trim();
      if (/^show captions$/i.test(label)) return candidates[i];
    }
    for (i = 0; i < candidates.length; i++) {
      var req = ((candidates[i].getAttribute('title') || '') + ' ' +
        (candidates[i].getAttribute('aria-label') || '')).trim();
      if (/^request caption/i.test(req)) return candidates[i];
    }
    return null;
  }

  function findCaptionLanguageModal(doc) {
    var dialog = doc.querySelector('.new-LT__selector-language-dialog');
    if (dialog) return dialog.closest('.zm-modal') || dialog;
    var modals = doc.querySelectorAll('.lt-select-language');
    for (var i = 0; i < modals.length; i++) {
      if (modals[i].textContent.indexOf('Set the caption language') >= 0) {
        return modals[i];
      }
    }
    return null;
  }

  function selectEnglishInLanguageModal(doc, modal) {
    var valueEl = modal.querySelector('.transcription-language__single-value');
    var current = valueEl ? valueEl.textContent.trim() : '';
    if (/^english$/i.test(current)) return true;

    var control = modal.querySelector('.transcription-language__control');
    if (control) control.click();

    var options = doc.querySelectorAll(
      '.transcription-language__option, [class*="transcription-language__option"], [role="option"]'
    );
    var i;
    for (i = 0; i < options.length; i++) {
      var label = options[i].textContent.trim();
      if (/^english$/i.test(label)) {
        options[i].click();
        return true;
      }
    }
    return false;
  }

  function tryDismissCaptionLanguageModal(doc) {
    var modal = findCaptionLanguageModal(doc);
    if (!modal) return false;
    if (Date.now() - langModalSaveAt < 1500) return true;

    selectEnglishInLanguageModal(doc, modal);

    var valueEl = modal.querySelector('.transcription-language__single-value');
    var current = valueEl ? valueEl.textContent.trim() : '';
    if (!/^english$/i.test(current)) return false;

    var saveBtn = modal.querySelector('.zm-modal-footer .zm-btn--primary');
    if (!saveBtn) {
      var buttons = modal.querySelectorAll('.zm-modal-footer button, button.zm-btn--primary');
      for (var i = 0; i < buttons.length; i++) {
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

    var btn = findShowCaptionsButton(doc);
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

    var attempts = 0;
    var maxAttempts = 40;

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
    var style = doc.createElement('style');
    style.id = '__zt-caption-styles';
    style.textContent = [
      '.__zt-caption-mount{display:block;width:100%;flex:0 0 auto;align-self:stretch;',
      'margin-top:6px;pointer-events:auto;font-family:system-ui,sans-serif;box-sizing:border-box}',
      '.live-transcription-subtitle__box:has(.__zt-caption-mount){flex-wrap:wrap;align-items:stretch;',
      'width:' + CAPTION_PANEL_WIDTH + 'px !important;min-width:' + CAPTION_PANEL_WIDTH + 'px !important;',
      'max-width:' + CAPTION_PANEL_WIDTH + 'px !important;box-sizing:border-box !important}',
      '.live-transcription-subtitle__box:has(.__zt-caption-mount) #live-transcription-subtitle{width:100%;max-width:100%}',
      '.__zt-caption-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 10px;',
      'background:rgba(0,0,0,0.72);border:1px solid rgba(255,255,255,0.12);border-radius:8px;color:#e8e8e8;font-size:11px}',
      '.__zt-caption-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;background:#555}',
      '.__zt-caption-dot--rec{background:#ef4444 !important;box-shadow:0 0 8px rgba(239,68,68,0.8);',
      'animation:__zt-rec-blink 1s ease-in-out infinite}',
      '@keyframes __zt-rec-blink{0%,100%{opacity:1}50%{opacity:0.25}}',
      '.__zt-caption-status{flex:1;min-width:0;color:#ccc;line-height:1.35;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.__zt-caption-meta{color:#fff;font-weight:700;white-space:nowrap;flex-shrink:0}',
      '.__zt-caption-actions{display:flex;gap:4px;flex-wrap:wrap;flex-shrink:0}',
      '.__zt-caption-actions button{background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.14);',
      'color:#fff;border-radius:5px;padding:3px 8px;font-size:10px;font-weight:600;cursor:pointer}',
      '.__zt-caption-actions button:hover{background:rgba(255,255,255,0.18)}',
      '.__zt-caption-log{margin-top:6px;max-height:140px;overflow-y:auto;overflow-x:hidden;padding:6px 8px;',
      'background:rgba(0,0,0,0.55);border:1px solid rgba(255,255,255,0.08);border-radius:8px;width:100%;box-sizing:border-box}',
      '.__zt-log-item{font-size:12px;line-height:1.4;color:#f3f3f3;margin-bottom:6px;word-wrap:break-word}',
      '.__zt-log-item:last-child{margin-bottom:0}',
      '.__zt-log-time{color:#9aa3af;font-size:10px;margin-right:6px}',
      '.__zt-log-name{font-size:10px;font-weight:700;margin-right:6px}',
      '[id="live-transcription-subtitle"] .live-transcription-subtitle__item{transition:color 0.4s ease}',
      '[id="live-transcription-subtitle"].__zt-recorded .live-transcription-subtitle__item{color:#4ade80 !important}',
      '.__zt-avatar-wrap{position:relative;display:inline-flex;flex-shrink:0}',
      '.__zt-recorded-badge{position:absolute;top:-3px;right:-3px;width:14px;height:14px;border-radius:50%;',
      'background:#22c55e;color:#fff;font-size:9px;font-weight:700;display:flex;align-items:center;',
      'justify-content:center;line-height:1;pointer-events:none;z-index:1;',
      'animation:__zt-badge-in 0.3s ease-out forwards}',
      '@keyframes __zt-badge-in{from{opacity:0;transform:scale(0.4)}to{opacity:1;transform:scale(1)}}',
      '.__zt-caption-dock{position:fixed;left:50%;transform:translateX(-50%);bottom:68px;z-index:2147483646;',
      'width:' + CAPTION_PANEL_WIDTH + 'px;min-width:' + CAPTION_PANEL_WIDTH + 'px;max-width:' + CAPTION_PANEL_WIDTH + 'px;',
      'padding:8px 10px;pointer-events:auto;box-sizing:border-box;',
      'background:rgba(0,0,0,0.78);border-radius:8px;box-shadow:0 4px 18px rgba(0,0,0,0.45)}',
      '.__zt-caption-idle-line{color:rgba(255,255,255,0.45);font-style:italic;font-size:12px;',
      'line-height:1.4;margin-bottom:6px;display:flex;align-items:center;min-height:24px}',
      '.live-transcription-subtitle__box:has(.__zt-caption-mount){display:flex !important;',
      'visibility:visible !important;opacity:1 !important}',
      '.live-transcription-subtitle__box:has(.__zt-caption-mount) #live-transcription-subtitle{display:flex !important}',
      '.__zt-caption-fallback{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:2147483646;',
      'width:' + CAPTION_PANEL_WIDTH + 'px;pointer-events:auto}'
    ].join('');
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
    var text = formatOutput();
    if (!text) {
      alert('No captions captured yet. Try __ztCaption.probe() in console.');
      return;
    }
    navigator.clipboard.writeText(text).then(function () {
      var btn = ui && ui.mount && ui.mount.querySelector('#__zt-caption-copy');
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
    if (panelWatchTimer) clearInterval(panelWatchTimer);
    if (settleTimer) clearTimeout(settleTimer);
    if (captionsEnableTimer) clearInterval(captionsEnableTimer);
    captionsEnableTimer = null;
    if (ui && ui.boxObserver) ui.boxObserver.disconnect();
    if (ui && ui.subObserver) ui.subObserver.disconnect();
    if (captionDomObserver) captionDomObserver.disconnect();
    teardownAutoDownloadHooks();
    var doc = activeDoc();
    var mount = doc.getElementById('__zt-caption-mount');
    if (mount) mount.remove();
    var dock = doc.getElementById('__zt-caption-dock');
    if (dock) dock.remove();
    var idle = doc.getElementById('__zt-caption-idle');
    if (idle) idle.remove();
    var fallback = doc.getElementById('__zt-caption-fallback');
    if (fallback) fallback.remove();
    var badges = doc.querySelectorAll('.__zt-recorded-badge');
    for (var i = 0; i < badges.length; i++) badges[i].remove();
    var recorded = doc.querySelectorAll('.__zt-recorded');
    for (var j = 0; j < recorded.length; j++) recorded[j].classList.remove('__zt-recorded');
    var styles = doc.getElementById('__zt-caption-styles');
    if (styles) styles.remove();
    window.__ztCaptionLoaded = false;
    delete window.__ztCaption;
  }

  function createMount(doc) {
    ensureStyles(doc);
    var mount = doc.createElement('div');
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
    var rows = getLiveSubtitleRows(doc);
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].style.display === 'none') continue;
      var line = rows[i].querySelector('.live-transcription-subtitle__item, .live-transcription-subtitle__yellowitem');
      if (line && line.textContent && line.textContent.trim()) return true;
    }
    return false;
  }

  function normalizeCaptionText(text) {
    return String(text || '').replace(/\uFFFD/g, '').replace(/\s+/g, ' ').trim();
  }

  function isSubtitleRecorded(text) {
    var norm = normalizeCaptionText(text);
    if (!norm) return false;
    for (var i = log.length - 1; i >= 0; i--) {
      var msg = normalizeCaptionText(log[i].msg);
      if (!msg) continue;
      if (msg === norm || norm.indexOf(msg) === 0 || msg.indexOf(norm) === 0) return true;
    }
    return false;
  }

  function ensureRecordedBadge(doc, row) {
    if (row.querySelector('.__zt-recorded-badge')) return;
    var avatar = row.querySelector('.zmu-data-selector-item__icon');
    if (!avatar) return;

    var wrap = avatar.closest('.__zt-avatar-wrap');
    if (!wrap) {
      wrap = doc.createElement('span');
      wrap.className = '__zt-avatar-wrap';
      avatar.parentNode.insertBefore(wrap, avatar);
      wrap.appendChild(avatar);
    }

    var badge = doc.createElement('span');
    badge.className = '__zt-recorded-badge';
    badge.setAttribute('aria-hidden', 'true');
    badge.textContent = '✓';
    wrap.appendChild(badge);
  }

  function markRecordedSubtitles(doc) {
    var rows = getLiveSubtitleRows(doc);
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var line = row.querySelector('.live-transcription-subtitle__item, .live-transcription-subtitle__yellowitem');
      var text = line ? line.textContent : '';

      if (isSubtitleRecorded(text)) {
        if (!row.classList.contains('__zt-recorded')) {
          row.classList.add('__zt-recorded');
        }
        ensureRecordedBadge(doc, row);
      } else {
        row.classList.remove('__zt-recorded');
        var badge = row.querySelector('.__zt-recorded-badge');
        if (badge) badge.remove();
      }
    }
  }

  function syncIdleLine(doc, container) {
    if (!container) return;
    var idle = doc.getElementById('__zt-caption-idle');
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

    var rows = box.querySelectorAll('[id="live-transcription-subtitle"]');
    for (var i = 0; i < rows.length; i++) {
      rows[i].style.setProperty('display', 'flex', 'important');
    }

    var wrap = box.closest('.lt-subtitle-wrap');
    if (wrap) {
      lockPanelWidth(wrap);
      wrap.style.setProperty('display', 'block', 'important');
      wrap.style.setProperty('visibility', 'visible', 'important');
    }

    syncIdleLine(doc, box);
  }

  function ensurePinDock(doc) {
    ensureStyles(doc);
    var dock = doc.getElementById('__zt-caption-dock');
    if (!dock) {
      dock = doc.createElement('div');
      dock.id = '__zt-caption-dock';
      dock.className = '__zt-caption-dock';
      doc.body.appendChild(dock);
    }
    lockPanelWidth(dock);
    return dock;
  }

  function observeSubtitleVisibility(doc, box) {
    if (ui && ui.subObserver && ui.observedSub === box) return;

    if (ui && ui.subObserver) ui.subObserver.disconnect();
    var obs = new MutationObserver(function () {
      var rows = box.querySelectorAll('[id="live-transcription-subtitle"]');
      var needsFix = false;
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].style.display === 'none') {
          needsFix = true;
          break;
        }
      }
      if (needsFix) keepCaptionBoxVisible(doc, box);
    });
    obs.observe(box, { attributes: true, attributeFilter: ['style'], subtree: true });
    if (!ui) ui = {};
    ui.subObserver = obs;
    ui.observedSub = box;
  }

  function createFallback(doc) {
    ensureStyles(doc);
    var fallback = doc.createElement('div');
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
    var obs = new MutationObserver(function () {
      var mount = doc.getElementById('__zt-caption-mount');
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
      var mount = doc.getElementById('__zt-caption-mount');
      if (!mount || !mount.isConnected) {
        watchCaptionPanel();
      }
    });
    captionDomObserver.observe(doc.body, { childList: true, subtree: true });
  }

  function attachMount(doc) {
    var mount = doc.getElementById('__zt-caption-mount');
    if (!mount) mount = createMount(doc);

    var box = findCaptionBox(doc);
    var dock = ensurePinDock(doc);
    var usingBox = false;

    if (box) {
      keepCaptionBoxVisible(doc, box);
      observeCaptionBox(doc, box);
      observeSubtitleVisibility(doc, box);
      if (mount.parentElement !== box) box.appendChild(mount);
      dock.style.display = 'none';
      uiMountedHost = box;
      usingBox = true;

      if (box.style.bottom) dock.style.bottom = box.style.bottom;

      if (!attachMount.logged) {
        attachMount.logged = true;
        console.info('[ZT Captions] Attached inside caption box.');
      }
    } else {
      syncIdleLine(doc, dock);
      if (mount.parentElement !== dock) dock.appendChild(mount);
      dock.style.display = 'block';
      uiMountedHost = null;

      if (!attachMount.dockLogged) {
        attachMount.dockLogged = true;
        console.info('[ZT Captions] Caption box hidden — keeping pinned recorder visible.');
      }
    }

    startCaptionDomWatch(doc);

    var fallback = doc.getElementById('__zt-caption-fallback');
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

  function watchCaptionPanel() {
    var doc;
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

    for (var i = renderedLogCount; i < log.length; i++) {
      var e = log[i];
      var item = ui.logEl.ownerDocument.createElement('div');
      item.className = '__zt-log-item';
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

    try {
      markRecordedSubtitles(activeDoc());
    } catch (e) { /* iframe not ready */ }
  }

  function formatOutput() {
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

    var lastSpeaker = null;
    return log.map(function (e) {
      var line = '';
      if (e.name && e.name !== lastSpeaker) {
        line += '\n[' + e.name + ']\n';
        lastSpeaker = e.name;
      }
      line += (e.time || '—') + '  ' + e.msg;
      return line;
    }).join('\n').trim();
  }

  function downloadFilename() {
    var d = new Date();
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    return 'captions-' + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + '-' +
      pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + '.txt';
  }

  function downloadCaptions(options) {
    options = options || {};
    var isAuto = !!options.auto;
    var reason = options.reason || 'manual';

    if (isAuto && Date.now() - lastAutoDownloadAt < 5000) return false;

    var text = formatOutput();
    if (!text) {
      if (!isAuto) alert('No captions captured yet. Try __ztCaption.probe() in console.');
      return false;
    }

    var a = activeDoc().createElement('a');
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
    var endBtn = target.closest('button[aria-label="End"]');
    if (endBtn) return { btn: endBtn, reason: 'end-button' };
    var leaveBtn = target.closest('button[aria-label="Leave"]');
    if (leaveBtn) return { btn: leaveBtn, reason: 'leave-button' };
    var footerBtn = target.closest('button.footer-button__button, button.footer-button-base__button');
    if (footerBtn) {
      var label = ((footerBtn.getAttribute('aria-label') || '') + ' ' + (footerBtn.textContent || '')).trim();
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
      var hit = findMeetingExitButton(e.target);
      if (hit) downloadCaptions({ auto: true, reason: hit.reason });
    };
    doc.addEventListener('click', meetingExitClickHandler, true);

    hostEndedObserver = new MutationObserver(function () {
      var nodes = doc.querySelectorAll(
        '.zm-modal-body-title, .zm-modal-body-content, .confirm-modal-content, [role="dialog"]'
      );
      for (var i = 0; i < nodes.length; i++) {
        var t = nodes[i].textContent || '';
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
    lastCapturedTime = null;
    renderedLogCount = 0;
    speakerColorMap = {};
    speakerColorIdx = 0;
    localStorage.removeItem(storageKey);
    if (ui && ui.logEl) ui.logEl.innerHTML = '';
    updateUI();
  }

  window.__ztCaption = {
    getLog: function () { return log.slice(); },
    probe: function () {
      wcWin = getWebclientWindow();
      var found = findReduxStore(wcWin.document);
      var info = {
        frame: window === wcWin ? 'webclient' : 'parent-shell',
        wcUrl: wcWin.location.href,
        storeFound: !!found,
        storeActive: !!store,
        lineCount: log.length,
        captionBoxFound: !!findCaptionBox(wcWin.document),
        captionPanelAttached: !!(function () {
          var m = wcWin.document.getElementById('__zt-caption-mount');
          return m && m.isConnected;
        })(),
        captionDockVisible: !!(function () {
          var d = wcWin.document.getElementById('__zt-caption-dock');
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
    var boot = document.currentScript;
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

  pollTimer = setInterval(pollStore, POLL_MS);
  panelWatchTimer = setInterval(watchCaptionPanel, 800);
  pollStore();
  watchCaptionPanel();
  try {
    startCaptionsAutoEnable(activeDoc());
  } catch (e) { /* iframe not ready yet */ }
  updateUI();

  console.info('[ZT Captions] Ready. Debug with __ztCaption.probe()');
  return window.__ztCaption;
})();
