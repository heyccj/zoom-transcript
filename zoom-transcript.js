/* Bundled at 2026-06-25T15:17:33Z */
(() => {
  // src/constants.js
  var POLL_MS = 800;
  var SETTLE_MS = 3e3;
  var CAPTION_PANEL_WIDTH = 500;
  var MAX_INJECT_RETRIES = 40;
  var MIN_PANEL_WIDTH = 320;
  var MAX_PANEL_WIDTH = 900;
  var MIN_LOG_HEIGHT = 100;
  var MAX_LOG_HEIGHT = 700;
  var DEFAULT_LOG_HEIGHT = 160;
  var SPEAKER_PALETTE_DARK = ["#7dd3fc", "#f9a8d4", "#fcd34d", "#86efac", "#c4b5fd", "#fb923c", "#67e8f9", "#f87171"];
  var SPEAKER_PALETTE_LIGHT = ["#0284c7", "#be185d", "#b45309", "#15803d", "#7c3aed", "#c2410c", "#0891b2", "#b91c1c"];

  // src/dedup.js
  function makeKey(time, name, msg) {
    return (time || "") + "|" + (name || "") + "|" + msg.slice(0, 40);
  }
  function isProgressiveUpdate(prev, time, name, msg) {
    if (prev.time !== time || prev.name !== name) return false;
    return msg.indexOf(prev.msg) === 0 || prev.msg.indexOf(msg) === 0;
  }
  function dedupLog(entries) {
    let result = [];
    entries.forEach(function(e) {
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
          marker: e.marker,
          chat: e.chat
        });
      }
    });
    result.forEach(function(e) {
      e.key = makeKey(e.time, e.name, e.msg);
    });
    let keySeen = /* @__PURE__ */ new Set();
    return result.filter(function(e) {
      if (keySeen.has(e.key)) return false;
      keySeen.add(e.key);
      return true;
    });
  }

  // src/meeting.js
  function getMeetingId(win) {
    try {
      let path = win.location.pathname;
      let match = path.match(/\/wc\/(\d+)/) || path.match(/\/j\/(\d+)/);
      return match ? match[1] : path + win.location.search;
    } catch (e) {
      return "unknown";
    }
  }
  function isMeetingDoc(doc) {
    return !!(doc.getElementById("full-transcription") || doc.getElementById("live-transcription-subtitle") || doc.getElementById("zmmtg-root") || doc.getElementById("wc-container") || doc.querySelector(".lt-full-transcript__item"));
  }
  function getWebclientWindow() {
    if (isMeetingDoc(document)) return window;
    let iframe = document.getElementById("webclient");
    if (iframe && iframe.contentWindow) {
      try {
        if (iframe.contentDocument && iframe.contentDocument.body) {
          return iframe.contentWindow;
        }
      } catch (e) {
      }
    }
    return window;
  }
  function isParentShell() {
    return !!document.getElementById("webclient") && !isMeetingDoc(document);
  }

  // src/state.js
  var keys = {
    meetingId: "",
    storageKey: "__ztCaptionLog",
    meetingKey: "__ztCaptionMeetingId",
    sessionKey: "__ztCaptionSession",
    autoDownloadKey: "__ztCaptionAutoDownloaded",
    bookmarksKey: "__ztCaptionBookmarks",
    darkKey: "__ztCaptionDark",
    collapsedKey: "__ztCaptionCollapsed",
    widthKey: "__ztCaptionWidth",
    heightKey: "__ztCaptionHeight"
  };
  var app = {
    injectAttempted: false,
    pendingInjectSource: null,
    injectRetries: 0,
    wcWin: null,
    log: [],
    seen: /* @__PURE__ */ new Set(),
    pauseSkipped: /* @__PURE__ */ new Set(),
    store: null,
    pollTimer: null,
    settleTimer: null,
    lastSnapshot: "",
    pollCount: 0,
    pendingLines: null,
    openCaptionAttemptAt: 0,
    captionsEnableTimer: null,
    captionsEnabledOnce: false,
    langModalSaveAt: 0,
    renderedLogCount: 0,
    lastRenderedSpeaker: null,
    ui: null,
    attachBoxLogged: false,
    attachDockLogged: false,
    captionDomObserver: null,
    autoDownloadDoc: null,
    autoDownloadWin: null,
    meetingExitClickHandler: null,
    tabCloseBeforeUnloadHandler: null,
    tabClosePageHideHandler: null,
    hostEndedObserver: null,
    hostEndedTimer: null,
    hostEndedTriggered: false,
    speakerColorMap: {},
    speakerColorIdx: 0,
    sessionName: "",
    paused: false,
    darkMode: false,
    collapsed: false,
    activeTab: "log",
    elapsedStart: null,
    elapsedTimer: null,
    speakerStats: {},
    searchQuery: "",
    bookmarkMode: false,
    bookmarks: [],
    bookmarkByKey: /* @__PURE__ */ new Map(),
    panelWidth: CAPTION_PANEL_WIDTH,
    logHeight: DEFAULT_LOG_HEIGHT,
    bookmarkDialogCtx: null,
    prevSharers: null,
    boxAttachTimer: null,
    lastPanelWatchAt: 0
  };
  function initAppState() {
    app.wcWin = getWebclientWindow();
    keys.meetingId = getMeetingId(app.wcWin);
    if (localStorage.getItem(keys.meetingKey) !== keys.meetingId) {
      localStorage.removeItem(keys.storageKey);
      localStorage.removeItem(keys.sessionKey);
      localStorage.removeItem(keys.autoDownloadKey);
      localStorage.removeItem(keys.bookmarksKey);
    }
    localStorage.setItem(keys.meetingKey, keys.meetingId);
    app.log = dedupLog(JSON.parse(localStorage.getItem(keys.storageKey) || "[]"));
    app.seen = new Set(app.log.map(function(l) {
      return l.key;
    }));
    app.sessionName = localStorage.getItem(keys.sessionKey) || "";
    app.darkMode = localStorage.getItem(keys.darkKey) === "1";
    app.collapsed = localStorage.getItem(keys.collapsedKey) === "1";
    let w = parseInt(localStorage.getItem(keys.widthKey), 10);
    app.panelWidth = isNaN(w) ? CAPTION_PANEL_WIDTH : Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, w));
    let h = parseInt(localStorage.getItem(keys.heightKey), 10);
    app.logHeight = isNaN(h) ? DEFAULT_LOG_HEIGHT : Math.max(MIN_LOG_HEIGHT, Math.min(MAX_LOG_HEIGHT, h));
  }

  // src/redux.js
  function looksLikeStore(obj) {
    return obj && typeof obj.getState === "function" && typeof obj.subscribe === "function" && typeof obj.dispatch === "function";
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
    return storeFromFiber(fiber.child, seen) || storeFromFiber(fiber.sibling, seen);
  }
  function collectFibers(node, out, limit) {
    if (!node || out.length >= limit) return;
    let keys2 = Object.keys(node);
    for (let i = 0; i < keys2.length; i++) {
      let k = keys2[i];
      if (k.indexOf("__reactFiber$") === 0 || k.indexOf("__reactContainer$") === 0) {
        out.push(node[k]);
      }
    }
    for (let c = node.firstChild; c; c = c.nextSibling) {
      collectFibers(c, out, limit);
    }
  }
  function findReduxStore(doc) {
    let roots = [
      doc.getElementById("zmmtg-root"),
      doc.getElementById("root"),
      doc.getElementById("wc-container"),
      doc.body
    ].filter(Boolean);
    let fibers = [];
    roots.forEach(function(root) {
      collectFibers(root, fibers, 40);
    });
    for (let i = 0; i < fibers.length; i++) {
      let store = storeFromFiber(fibers[i], /* @__PURE__ */ new Set());
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
    attendeeLists(state).forEach(function(list) {
      list.forEach(function(a) {
        if (!a) return;
        fn(a, a.userId != null ? a.userId : a.zoomID);
      });
    });
  }
  function attendeeNameMap(state) {
    let map = {};
    eachAttendee(state, function(a, id) {
      let name = a.displayName || a.name;
      if (id != null && name) map[id] = name;
    });
    return map;
  }
  function activeSharerMap(reduxState) {
    let map = {};
    eachAttendee(reduxState, function(a, id) {
      if (!a.sharerOn || id == null) return;
      map[id] = a.displayName || a.name || "Someone";
    });
    return map;
  }
  function resolveName(msg, names) {
    if (msg.isCaptioner) return "(Captioner)";
    if (msg.user && msg.user.displayName) return msg.user.displayName;
    if (msg.displayName) return msg.displayName;
    if (msg.previousDisplayName) return msg.previousDisplayName;
    if (msg.userId != null && names[msg.userId]) return names[msg.userId];
    return null;
  }
  function normalizeText(text) {
    if (!text) return "";
    return String(text).replace(/\uFFFD/g, "").trim();
  }
  function formatTime(value) {
    let ms = typeof value === "number" ? value : NaN;
    if (isNaN(ms) && /^\d{10,}$/.test(String(value))) ms = Number(value);
    if (isNaN(ms)) return value == null ? "" : String(value);
    let d = new Date(ms);
    let m = String(d.getMinutes()).padStart(2, "0");
    let s = String(d.getSeconds()).padStart(2, "0");
    return d.getHours() + ":" + m + ":" + s;
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
    let seenKeys = /* @__PURE__ */ new Set();
    ltBuckets(state).forEach(function(lt) {
      if (!lt || !lt.allMessages) return;
      let order = Array.isArray(lt.messagesOrder) ? lt.messagesOrder.slice() : [];
      let ids = order.length ? order : Object.keys(lt.allMessages);
      ids.forEach(function(id) {
        let msg = lt.allMessages[id];
        if (!msg) return;
        let text = normalizeText(msg.message || msg.decryptedMessage || msg.text);
        if (!text) return;
        let time = msg.messageTime ? formatTime(msg.messageTime) : "";
        let name = resolveName(msg, names);
        let key = makeKey(time, name, text);
        if (seenKeys.has(key)) return;
        seenKeys.add(key);
        rows.push({
          time,
          name,
          msg: text,
          src: "allMessages",
          finished: msg.isFinished !== false
        });
      });
    });
    return rows;
  }
  function linesFromNewLTMessage(state, names) {
    let rows = [];
    ltBuckets(state).forEach(function(lt) {
      if (!lt || !lt.newLTMessage) return;
      Object.keys(lt.newLTMessage).forEach(function(id) {
        let msg = lt.newLTMessage[id];
        let text = normalizeText(msg.text || msg.message);
        if (!text) return;
        rows.push({
          time: msg.messageTime ? formatTime(msg.messageTime) : "",
          name: resolveName(msg, names),
          msg: text,
          src: "newLTMessage",
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
      src: "messageLatest",
      finished: true
    }];
  }
  function extractLines(reduxState) {
    let names = attendeeNameMap(reduxState);
    let fromAll = linesFromAllMessages(reduxState, names);
    if (fromAll.length) return fromAll;
    let fromNew = linesFromNewLTMessage(reduxState, names);
    if (fromNew.length) return fromNew;
    return linesFromMessageLatest(reduxState);
  }
  function meetingChatThreads(state) {
    let nc = state.newChat;
    if (nc && Array.isArray(nc.meetingChat)) return nc.meetingChat;
    return [];
  }
  function chatMessageText(msg, thread) {
    if (!msg) return "";
    let text = normalizeText(msg.text || msg.message);
    if (!text && msg.content) {
      text = normalizeText(typeof msg.content === "string" ? msg.content : msg.content.text);
    }
    if (!text && thread && !msg.msgId && !msg.id) {
      text = normalizeText(thread.message);
      if (!text && thread.content) {
        text = normalizeText(typeof thread.content === "string" ? thread.content : thread.content.text);
      }
    }
    if (!text && msg.file) {
      let file = msg.file;
      let label = file.fileName || file.name || file.file && file.file.name;
      if (label) text = "[file: " + label + "]";
    }
    return text;
  }
  function chatSenderName(thread, msg, names) {
    let name = msg.senderName || thread.senderName || thread.sender || thread.chatSender;
    if (name) return name;
    let senderId = msg.senderId != null ? msg.senderId : thread.senderId;
    if (senderId != null && names[senderId]) return names[senderId];
    return null;
  }
  function chatAudienceLabel(thread, msg) {
    let ext = msg.meetingChatExt || thread.meetingChatExt;
    if (ext && ext.receiverName) return "to " + ext.receiverName;
    if (thread.chatReceiver) return "to " + thread.chatReceiver;
    if (thread.receiver) return "to " + thread.receiver;
    if (ext && ext.isPrivately) return "privately";
    return null;
  }
  function chatMessageTime(thread, msg) {
    let raw = msg.time || msg.timestamp || msg.timeStamp || msg.ct || thread.time || thread.timeStamp || thread.timestamp;
    return raw ? formatTime(raw) : formatTime(Date.now());
  }
  function chatMessageId(thread, msg, text, time, name) {
    return String(
      msg.msgId || msg.id || msg.xmppMsgId || thread.msgId || thread.id || thread.xmppMsgId || makeKey(time, name, text)
    );
  }
  function extractChatLines(reduxState) {
    let names = attendeeNameMap(reduxState);
    let rows = [];
    let seenIds = /* @__PURE__ */ new Set();
    meetingChatThreads(reduxState).forEach(function(thread) {
      if (!thread) return;
      let msgs = Array.isArray(thread.chatMsgs) && thread.chatMsgs.length ? thread.chatMsgs : [thread];
      msgs.forEach(function(msg) {
        if (!msg) return;
        let text = chatMessageText(msg, thread);
        if (!text) return;
        let time = chatMessageTime(thread, msg);
        let name = chatSenderName(thread, msg, names);
        let audience = chatAudienceLabel(thread, msg);
        let displayMsg = audience ? text + " (" + audience + ")" : text;
        let chatId = chatMessageId(thread, msg, text, time, name);
        if (seenIds.has(chatId)) return;
        seenIds.add(chatId);
        rows.push({
          time,
          name,
          msg: displayMsg,
          src: "chat",
          chatId,
          finished: true
        });
      });
    });
    return rows;
  }
  function probeState(reduxState) {
    let lt = ltBuckets(reduxState);
    return {
      attendeeCount: Object.keys(attendeeNameMap(reduxState)).length,
      liveTranscriptionKeys: lt.map(function(b) {
        return {
          allMessages: b.allMessages ? Object.keys(b.allMessages).length : 0,
          messagesOrder: b.messagesOrder ? b.messagesOrder.length : 0,
          newLTMessage: b.newLTMessage ? Object.keys(b.newLTMessage).length : 0,
          hasLTStarted: !!b.hasLTStarted
        };
      }),
      messageLatest: !!(reduxState.meeting && reduxState.meeting.messageLatest),
      chatThreads: meetingChatThreads(reduxState).length,
      chatLines: extractChatLines(reduxState).length,
      lines: extractLines(reduxState).slice(-5)
    };
  }

  // src/caption-panel.js
  function activeDoc() {
    app.wcWin = getWebclientWindow();
    return app.wcWin.document;
  }
  function findCaptionBox(doc) {
    let sub = doc.getElementById("live-transcription-subtitle");
    if (sub && sub.closest) {
      let inBox = sub.closest(".live-transcription-subtitle__box");
      if (inBox) return inBox;
    }
    return doc.querySelector(".live-transcription-subtitle__box");
  }
  function captionsVisible(doc) {
    let sub = doc.getElementById("live-transcription-subtitle");
    if (!sub) return false;
    if (sub.style.display === "none") return false;
    let box = sub.closest(".live-transcription-subtitle__box");
    if (box && box.style.display === "none") return false;
    return true;
  }
  function lockPanelWidth(el) {
    if (!el) return;
    el.style.setProperty("width", app.panelWidth + "px", "important");
    el.style.setProperty("min-width", app.panelWidth + "px", "important");
    el.style.setProperty("max-width", app.panelWidth + "px", "important");
    el.style.setProperty("box-sizing", "border-box", "important");
  }
  function applyPanelWidth(doc) {
    doc.documentElement.style.setProperty("--zt-panel-width", app.panelWidth + "px");
    let box = findCaptionBox(doc);
    if (box) {
      lockPanelWidth(box);
      let wrap = box.closest(".lt-subtitle-wrap");
      if (wrap) lockPanelWidth(wrap);
    }
    let dock = doc.getElementById("__zt-caption-dock");
    if (dock) lockPanelWidth(dock);
  }
  function applyLogHeight(doc) {
    doc.documentElement.style.setProperty("--zt-log-height", app.logHeight + "px");
  }
  function findShowCaptionsButton(doc) {
    let candidates = doc.querySelectorAll("button[title], button[aria-label]");
    let i;
    for (i = 0; i < candidates.length; i++) {
      let label = ((candidates[i].getAttribute("title") || "") + " " + (candidates[i].getAttribute("aria-label") || "")).trim();
      if (/^show captions$/i.test(label)) return candidates[i];
    }
    for (i = 0; i < candidates.length; i++) {
      let req = ((candidates[i].getAttribute("title") || "") + " " + (candidates[i].getAttribute("aria-label") || "")).trim();
      if (/^request caption/i.test(req)) return candidates[i];
    }
    return null;
  }
  function findCaptionLanguageModal(doc) {
    let dialog = doc.querySelector(".new-LT__selector-language-dialog");
    if (dialog) return dialog.closest(".zm-modal") || dialog;
    let modals = doc.querySelectorAll(".lt-select-language");
    for (let i = 0; i < modals.length; i++) {
      if (modals[i].textContent.indexOf("Set the caption language") >= 0) {
        return modals[i];
      }
    }
    return null;
  }
  function selectEnglishInLanguageModal(doc, modal) {
    let valueEl = modal.querySelector(".transcription-language__single-value");
    let current = valueEl ? valueEl.textContent.trim() : "";
    if (/^english$/i.test(current)) return true;
    let control = modal.querySelector(".transcription-language__control");
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
    if (Date.now() - app.langModalSaveAt < 1500) return true;
    selectEnglishInLanguageModal(doc, modal);
    let valueEl = modal.querySelector(".transcription-language__single-value");
    let current = valueEl ? valueEl.textContent.trim() : "";
    if (!/^english$/i.test(current)) return false;
    let saveBtn = modal.querySelector(".zm-modal-footer .zm-btn--primary");
    if (!saveBtn) {
      let buttons = modal.querySelectorAll(".zm-modal-footer button, button.zm-btn--primary");
      for (let i = 0; i < buttons.length; i++) {
        if (/^save$/i.test(buttons[i].textContent.trim())) {
          saveBtn = buttons[i];
          break;
        }
      }
    }
    if (!saveBtn) return false;
    app.langModalSaveAt = Date.now();
    saveBtn.click();
    console.info("[ZT Captions] Caption language modal \u2014 English + Save.");
    return true;
  }
  function tryShowCaptions(doc, force) {
    if (captionsVisible(doc)) {
      app.captionsEnabledOnce = true;
      return true;
    }
    if (!force && Date.now() - app.openCaptionAttemptAt < 3e3) return false;
    let btn = findShowCaptionsButton(doc);
    if (!btn) return false;
    app.openCaptionAttemptAt = Date.now();
    btn.click();
    console.info("[ZT Captions] Clicked Show Captions.");
    setTimeout(function() {
      try {
        tryDismissCaptionLanguageModal(activeDoc());
      } catch (e) {
      }
    }, 400);
    return true;
  }
  function startCaptionsAutoEnable(doc) {
    if (app.captionsEnableTimer || app.captionsEnabledOnce) return;
    let attempts = 0;
    let maxAttempts = 40;
    function tick() {
      if (captionsVisible(doc)) {
        app.captionsEnabledOnce = true;
        if (app.captionsEnableTimer) clearInterval(app.captionsEnableTimer);
        app.captionsEnableTimer = null;
        return;
      }
      attempts++;
      tryShowCaptions(doc, attempts <= 8);
      if (attempts >= maxAttempts && app.captionsEnableTimer) {
        clearInterval(app.captionsEnableTimer);
        app.captionsEnableTimer = null;
        console.warn("[ZT Captions] Could not auto-enable captions \u2014 click Show Captions manually.");
      }
    }
    tryShowCaptions(doc, true);
    tick();
    app.captionsEnableTimer = setInterval(tick, 3e3);
  }

  // src/utils.js
  function escapeHtml(text) {
    return String(text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function shieldInputEvents(el) {
    if (!el) return;
    [
      "mousedown",
      "mouseup",
      "click",
      "dblclick",
      "pointerdown",
      "pointerup",
      "touchstart",
      "keydown",
      "keypress",
      "keyup"
    ].forEach(function(type) {
      el.addEventListener(type, function(e) {
        e.stopPropagation();
      });
    });
  }
  function shieldFromCaptionDrag(el) {
    if (!el || el.dataset.ztDragShield) return;
    el.dataset.ztDragShield = "1";
    ["mousedown", "pointerdown"].forEach(function(type) {
      el.addEventListener(type, function(e) {
        e.stopPropagation();
      });
    });
  }

  // src/bookmarks.js
  function getSpeakerColor(name) {
    if (!name) return app.darkMode ? "#9aa3af" : "#6b7280";
    if (app.speakerColorMap[name] == null) {
      app.speakerColorMap[name] = app.speakerColorIdx % SPEAKER_PALETTE_DARK.length;
      app.speakerColorIdx++;
    }
    let palette = app.darkMode ? SPEAKER_PALETTE_DARK : SPEAKER_PALETTE_LIGHT;
    return palette[app.speakerColorMap[name]];
  }
  function latestPendingSpeaker() {
    if (!app.pendingLines) return null;
    for (let i = app.pendingLines.length - 1; i >= 0; i--) {
      if (app.pendingLines[i].msg && app.pendingLines[i].name) return app.pendingLines[i].name;
    }
    return null;
  }
  function syncSeenFromLog() {
    app.seen = new Set(app.log.map(function(l) {
      return l.key;
    }));
    app.pauseSkipped.forEach(function(k) {
      app.seen.add(k);
    });
  }
  function rebuildSpeakerStats() {
    app.speakerStats = {};
    app.log.forEach(function(e) {
      if (!e.name || e.marker || e.chat) return;
      app.speakerStats[e.name] = (app.speakerStats[e.name] || 0) + 1;
    });
  }
  function loadBookmarks() {
    try {
      app.bookmarks = JSON.parse(localStorage.getItem(keys.bookmarksKey) || "[]");
      if (!Array.isArray(app.bookmarks)) app.bookmarks = [];
    } catch (e) {
      app.bookmarks = [];
    }
    rebuildBookmarkByKey();
  }
  function persistBookmarks() {
    localStorage.setItem(keys.bookmarksKey, JSON.stringify(app.bookmarks));
  }
  function rebuildBookmarkByKey() {
    app.bookmarkByKey = /* @__PURE__ */ new Map();
    app.bookmarks.forEach(function(b) {
      if (b.entryKey && b.label) app.bookmarkByKey.set(b.entryKey, b.label);
    });
  }
  function bookmarkIconHtml(size) {
    size = size || 12;
    return '<svg class="__zt-bookmark-icon" width="' + size + '" height="' + size + '" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 2.5h8v11l-4-3-4 3v-11z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  }
  function setBookmarkBtnIcon(btn, size) {
    if (!btn) return;
    btn.innerHTML = bookmarkIconHtml(size || 12);
  }
  function findLogEntry(entryKey) {
    for (let i = 0; i < app.log.length; i++) {
      if (app.log[i].key === entryKey) return app.log[i];
    }
    return null;
  }
  function addBookmark(entryKey, label, entryHint) {
    label = String(label || "").trim();
    if (!label) return false;
    let entry = entryHint || findLogEntry(entryKey);
    if (!entry || entry.marker) return false;
    for (let i = 0; i < app.bookmarks.length; i++) {
      if (app.bookmarks[i].entryKey === entryKey && app.bookmarks[i].label === label) return false;
    }
    app.bookmarks.push({
      id: "bm-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7),
      label,
      entryKey,
      time: entry.time || "",
      speaker: entry.name || null,
      preview: entry.msg ? entry.msg.slice(0, 80) : ""
    });
    rebuildBookmarkByKey();
    persistBookmarks();
    syncBookmarkMarkers();
    return true;
  }
  function renameBookmark(entryKey, label) {
    label = String(label || "").trim();
    if (!label) return false;
    let bm = null;
    for (let i = 0; i < app.bookmarks.length; i++) {
      if (app.bookmarks[i].entryKey === entryKey) {
        bm = app.bookmarks[i];
        break;
      }
    }
    if (!bm) return false;
    bm.label = label;
    rebuildBookmarkByKey();
    persistBookmarks();
    syncBookmarkMarkers();
    return true;
  }
  function removeBookmark(entryKey) {
    let idx = -1;
    for (let i = 0; i < app.bookmarks.length; i++) {
      if (app.bookmarks[i].entryKey === entryKey) {
        idx = i;
        break;
      }
    }
    if (idx < 0) return false;
    app.bookmarks.splice(idx, 1);
    rebuildBookmarkByKey();
    persistBookmarks();
    syncBookmarkMarkers();
    return true;
  }
  function setBookmarkMode(on) {
    app.bookmarkMode = !!on;
    if (!app.bookmarkMode) hideBookmarkNameDialog();
    if (!app.ui || !app.ui.mount) return;
    app.ui.mount.classList.toggle("__zt-bookmark-mode", app.bookmarkMode);
    if (app.ui.bookmarkBtn) {
      app.ui.bookmarkBtn.classList.toggle("__zt-btn-icon--active", app.bookmarkMode);
      app.ui.bookmarkBtn.title = app.bookmarkMode ? "Click a name or line to bookmark" : "Add bookmark";
    }
  }
  function toggleBookmarkMode() {
    setBookmarkMode(!app.bookmarkMode);
  }
  app.bookmarkDialogCtx = null;
  function hideBookmarkNameDialog() {
    if (app.ui && app.ui.bookmarkDialog) app.ui.bookmarkDialog.style.display = "none";
    app.bookmarkDialogCtx = null;
  }
  function commitBookmarkNameDialog() {
    if (!app.bookmarkDialogCtx || !app.ui || !app.ui.bookmarkInput) return;
    let label = app.ui.bookmarkInput.value;
    let ctx = app.bookmarkDialogCtx;
    hideBookmarkNameDialog();
    label = String(label || "").trim();
    if (!label) return;
    if (ctx.mode === "edit") {
      renameBookmark(ctx.entryKey, label);
    } else if (ctx.callback) {
      ctx.callback(label);
    }
  }
  function removeBookmarkFromDialog() {
    if (!app.bookmarkDialogCtx || app.bookmarkDialogCtx.mode !== "edit") return;
    let entryKey = app.bookmarkDialogCtx.entryKey;
    hideBookmarkNameDialog();
    removeBookmark(entryKey);
  }
  function openBookmarkDialog(mode, entryKey, entry, defaultLabel, callback) {
    if (!app.ui || !app.ui.mount) {
      if (callback) callback(null);
      return;
    }
    ensureBookmarkDialogChrome(app.ui.mount, app.ui.mount.ownerDocument);
    if (!app.ui.bookmarkDialog || !app.ui.bookmarkInput) {
      let win = app.ui.mount.ownerDocument.defaultView || window;
      let label = win.prompt(
        mode === "edit" ? "Rename bookmark:" : "Name this bookmark:",
        defaultLabel || ""
      );
      if (label === null) return;
      label = String(label).trim();
      if (!label) return;
      if (mode === "edit") renameBookmark(entryKey, label);
      else if (callback) callback(label);
      return;
    }
    app.bookmarkDialogCtx = {
      mode,
      entryKey,
      entry,
      callback
    };
    if (app.ui.bookmarkDialogTitle) {
      app.ui.bookmarkDialogTitle.textContent = mode === "edit" ? "Edit bookmark" : "Name bookmark";
    }
    if (app.ui.bookmarkRemoveBtn) {
      app.ui.bookmarkRemoveBtn.style.display = mode === "edit" ? "" : "none";
    }
    app.ui.bookmarkInput.value = defaultLabel || "";
    app.ui.bookmarkDialog.style.display = "flex";
    app.ui.bookmarkInput.focus();
    app.ui.bookmarkInput.select();
  }
  function showBookmarkNameDialog(defaultLabel, entryKey, entry, callback) {
    openBookmarkDialog("add", entryKey, entry, defaultLabel, callback);
  }
  function showBookmarkEditDialog(entryKey, entry) {
    openBookmarkDialog("edit", entryKey, entry, app.bookmarkByKey.get(entryKey) || "", null);
  }
  function ensureBookmarkDialogChrome(mount, doc) {
    let dialog = mount.querySelector("#__zt-bookmark-dialog");
    if (!dialog) return;
    let title = dialog.querySelector(".__zt-bookmark-dialog-title");
    if (title && !title.id) title.id = "__zt-bookmark-dialog-title";
    let actions = dialog.querySelector(".__zt-bookmark-dialog-actions");
    if (actions && !dialog.querySelector("#__zt-bookmark-remove")) {
      let removeBtn = doc.createElement("button");
      removeBtn.id = "__zt-bookmark-remove";
      removeBtn.type = "button";
      removeBtn.className = "__zt-btn __zt-btn--stop";
      removeBtn.textContent = "Remove";
      removeBtn.style.display = "none";
      let right = doc.createElement("div");
      right.className = "__zt-bookmark-dialog-actions-right";
      while (actions.firstChild) right.appendChild(actions.firstChild);
      actions.appendChild(removeBtn);
      actions.appendChild(right);
      removeBtn.onclick = removeBookmarkFromDialog;
    }
    if (app.ui) {
      app.ui.bookmarkDialogTitle = dialog.querySelector("#__zt-bookmark-dialog-title");
      app.ui.bookmarkRemoveBtn = dialog.querySelector("#__zt-bookmark-remove");
    }
  }
  function ensureBookmarkChip(row, key, label, doc) {
    let chip = row.querySelector(".__zt-entry-bookmark");
    if (!chip) {
      chip = doc.createElement("button");
      chip.type = "button";
      chip.className = "__zt-entry-bookmark";
      chip.title = "Rename or remove bookmark";
      chip.addEventListener("mousedown", function(ev) {
        ev.stopPropagation();
      });
      chip.addEventListener("pointerdown", function(ev) {
        ev.stopPropagation();
      });
      let header = row.querySelector(".__zt-entry-header");
      if (header) header.insertBefore(chip, header.firstChild);
      else {
        let msg = row.querySelector(".__zt-entry-msg");
        if (msg) row.insertBefore(chip, msg);
        else row.insertBefore(chip, row.firstChild);
      }
    }
    chip.textContent = "";
    let icon = chip.querySelector(".__zt-entry-bookmark-icon");
    if (!icon) {
      icon = doc.createElement("span");
      icon.className = "__zt-entry-bookmark-icon";
      chip.appendChild(icon);
    }
    icon.innerHTML = bookmarkIconHtml(10);
    let labelEl = chip.querySelector(".__zt-entry-bookmark-label");
    if (!labelEl) {
      labelEl = doc.createElement("span");
      labelEl.className = "__zt-entry-bookmark-label";
      chip.appendChild(labelEl);
    }
    labelEl.textContent = label;
    chip.setAttribute("data-entry-key", key);
  }
  function ensureBookmarkWiring(mount, doc) {
    let modeBtn = mount.querySelector("#__zt-mode-btn");
    let bookmarkBtn = mount.querySelector("#__zt-bookmark-btn");
    if (!bookmarkBtn && modeBtn) {
      bookmarkBtn = doc.createElement("button");
      bookmarkBtn.id = "__zt-bookmark-btn";
      bookmarkBtn.className = "__zt-btn-icon";
      bookmarkBtn.type = "button";
      bookmarkBtn.title = "Add bookmark";
      setBookmarkBtnIcon(bookmarkBtn, 12);
      modeBtn.parentNode.insertBefore(bookmarkBtn, modeBtn);
    }
    if (bookmarkBtn) {
      bookmarkBtn.onclick = toggleBookmarkMode;
      shieldFromCaptionDrag(bookmarkBtn);
      if (!bookmarkBtn.querySelector(".__zt-bookmark-icon")) setBookmarkBtnIcon(bookmarkBtn, 12);
    }
    let dialog = mount.querySelector("#__zt-bookmark-dialog");
    if (!dialog) {
      dialog = doc.createElement("div");
      dialog.id = "__zt-bookmark-dialog";
      dialog.className = "__zt-bookmark-dialog";
      dialog.style.display = "none";
      dialog.setAttribute("role", "dialog");
      dialog.innerHTML = '<div class="__zt-bookmark-dialog-card"><div id="__zt-bookmark-dialog-title" class="__zt-bookmark-dialog-title">Name bookmark</div><input id="__zt-bookmark-input" type="text" spellcheck="false" placeholder="Bookmark label"><div class="__zt-bookmark-dialog-actions"><button id="__zt-bookmark-remove" type="button" class="__zt-btn __zt-btn--stop" style="display:none">Remove</button><div class="__zt-bookmark-dialog-actions-right"><button id="__zt-bookmark-cancel" type="button" class="__zt-btn">Cancel</button><button id="__zt-bookmark-save" type="button" class="__zt-btn __zt-btn--primary">Save</button></div></div></div>';
      mount.appendChild(dialog);
    }
    ensureBookmarkDialogChrome(mount, doc);
    if (dialog && !dialog.dataset.ztDialogBound) {
      dialog.dataset.ztDialogBound = "1";
      let input = dialog.querySelector("#__zt-bookmark-input");
      shieldInputEvents(input);
      dialog.querySelector("#__zt-bookmark-save").onclick = commitBookmarkNameDialog;
      dialog.querySelector("#__zt-bookmark-cancel").onclick = hideBookmarkNameDialog;
      let removeBtn = dialog.querySelector("#__zt-bookmark-remove");
      if (removeBtn) removeBtn.onclick = removeBookmarkFromDialog;
      input.addEventListener("keydown", function(ev) {
        if (ev.key === "Enter") {
          ev.preventDefault();
          commitBookmarkNameDialog();
        } else if (ev.key === "Escape") {
          ev.preventDefault();
          hideBookmarkNameDialog();
        }
      });
    }
    let logEntries = mount.querySelector("#__zt-log-entries");
    if (logEntries) {
      if (logEntries.dataset.ztBookmarkBound !== "3") {
        logEntries.dataset.ztBookmarkBound = "3";
        logEntries.addEventListener("click", handleLogBookmarksClick, true);
        logEntries.addEventListener("mousedown", handleLogBookmarksPointer, false);
      }
    }
  }
  function resolveEntryFromRow(row) {
    let entryKey = row.getAttribute("data-key");
    if (!entryKey) return null;
    let idx = parseInt(row.getAttribute("data-log-index"), 10);
    let entry = !isNaN(idx) && app.log[idx] ? app.log[idx] : findLogEntry(entryKey);
    if (!entry) {
      let msgEl = row.querySelector(".__zt-entry-msg");
      let timeEl = row.querySelector(".__zt-entry-time");
      entry = {
        key: entryKey,
        time: timeEl ? String(timeEl.textContent).trim() : "",
        name: row.getAttribute("data-name") || null,
        msg: msgEl ? msgEl.textContent : ""
      };
    }
    return { entryKey, entry };
  }
  function handleLogBookmarksClick(e) {
    if (!e.target.closest || !e.target.closest(".__zt-entry-bookmark")) return;
    e.preventDefault();
    e.stopPropagation();
    let chip = e.target.closest(".__zt-entry-bookmark");
    let entryKey = chip.getAttribute("data-entry-key");
    if (!entryKey) return;
    let row = chip.closest(".__zt-entry");
    let resolved = row ? resolveEntryFromRow(row) : { entryKey, entry: findLogEntry(entryKey) };
    if (!resolved || !resolved.entry) return;
    showBookmarkEditDialog(resolved.entryKey, resolved.entry);
  }
  function handleLogBookmarksPointer(e) {
    if (e.button !== 0 || !app.bookmarkMode) return;
    if (e.target.closest && e.target.closest(".__zt-entry-bookmark")) return;
    handleBookmarkPlacementClick(e);
  }
  function handleBookmarkPlacementClick(e) {
    if (!app.bookmarkMode) return;
    if (e.target.closest && e.target.closest(".__zt-entry-bookmark")) return;
    let row = e.target.closest && e.target.closest(".__zt-entry");
    if (!row || row.classList.contains(".__zt-entry--marker")) return;
    if (!app.ui || !app.ui.settledEl || !app.ui.settledEl.contains(row)) return;
    e.preventDefault();
    e.stopPropagation();
    let entryKey = row.getAttribute("data-key");
    if (!entryKey) return;
    let resolved = resolveEntryFromRow(row);
    if (!resolved) return;
    entryKey = resolved.entryKey;
    let entry = resolved.entry;
    if (app.bookmarkByKey.has(entryKey)) {
      showBookmarkEditDialog(entryKey, entry);
      return;
    }
    let defaultLabel = entry.name || (entry.msg ? entry.msg.slice(0, 40) : "");
    showBookmarkNameDialog(defaultLabel, entryKey, entry, function(label) {
      if (label === null) return;
      if (addBookmark(entryKey, label, entry)) setBookmarkMode(false);
    });
  }
  function syncBookmarkMarkers() {
    if (!app.ui || !app.ui.settledEl) return;
    let doc = app.ui.settledEl.ownerDocument;
    let rows = app.ui.settledEl.querySelectorAll(".__zt-entry");
    for (let i = 0; i < rows.length; i++) {
      let row = rows[i];
      let key = row.getAttribute("data-key");
      let label = key ? app.bookmarkByKey.get(key) : null;
      let bookmarked = !!label;
      row.classList.toggle("__zt-entry--bookmarked", bookmarked);
      if (bookmarked) {
        ensureBookmarkChip(row, key, label, doc);
      } else {
        let chip = row.querySelector(".__zt-entry-bookmark");
        if (chip) chip.remove();
      }
    }
  }

  // src/render.js
  function buildEntryNode(doc, e, continued, pending) {
    let item = doc.createElement("div");
    let cls = "__zt-entry";
    if (e.marker) cls += " __zt-entry--marker";
    if (e.chat) cls += " __zt-entry--chat";
    if (pending) cls += " __zt-entry--pending";
    if (continued) cls += " __zt-entry--continued";
    else if (!e.marker) cls += " __zt-entry--run-head";
    item.className = cls;
    item.setAttribute("data-key", e.key || "");
    if (e.name) item.setAttribute("data-name", e.name);
    let timeHtml = '<span class="__zt-entry-time">' + escapeHtml(e.time || "\u2014") + "</span>";
    let msgHtml = '<span class="__zt-entry-msg">' + escapeHtml(e.msg) + "</span>";
    if (e.marker) {
      item.innerHTML = timeHtml + msgHtml;
    } else {
      item.innerHTML = '<div class="__zt-entry-header">' + timeHtml + (e.name ? '<span class="__zt-entry-name" style="color:' + getSpeakerColor(e.name) + '">' + escapeHtml(e.name) + "</span>" : "") + "</div>" + msgHtml;
    }
    return item;
  }
  function logNearBottom() {
    if (!app.ui || !app.ui.logEntriesEl) return true;
    let el = app.ui.logEntriesEl;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  }
  function scrollLogToBottom() {
    if (app.ui && app.ui.logEntriesEl) app.ui.logEntriesEl.scrollTop = app.ui.logEntriesEl.scrollHeight;
  }
  function renderLogItems() {
    if (!app.ui || !app.ui.settledEl) return;
    if (app.renderedLogCount === app.log.length) return;
    let doc = app.ui.settledEl.ownerDocument;
    let nearBottom = logNearBottom();
    if (app.log.length < app.renderedLogCount) {
      app.ui.settledEl.innerHTML = "";
      app.renderedLogCount = 0;
      app.lastRenderedSpeaker = null;
      nearBottom = true;
    }
    let animateNew = app.renderedLogCount > 0;
    for (let i = app.renderedLogCount; i < app.log.length; i++) {
      let e = app.log[i];
      let existing = null;
      let settledRows = app.ui.settledEl.querySelectorAll(".__zt-entry[data-key]");
      for (let r = 0; r < settledRows.length; r++) {
        if (settledRows[r].getAttribute("data-key") === e.key) {
          existing = settledRows[r];
          break;
        }
      }
      if (existing) continue;
      let continued = !e.marker && !e.chat && !!e.name && e.name === app.lastRenderedSpeaker;
      let node = buildEntryNode(doc, e, continued, false);
      node.setAttribute("data-log-index", String(i));
      if (animateNew && !e.marker) {
        node.classList.add("__zt-entry--just-logged");
        node.addEventListener("animationend", function() {
          node.classList.remove("__zt-entry--just-logged");
        }, { once: true });
      }
      app.ui.settledEl.appendChild(node);
      app.lastRenderedSpeaker = e.marker || e.chat ? null : e.name || null;
    }
    app.renderedLogCount = app.log.length;
    syncBookmarkMarkers();
    if (app.searchQuery.trim()) applyLogFilter();
    if (nearBottom) scrollLogToBottom();
  }
  function renderPendingItems() {
    if (!app.ui || !app.ui.pendingEl) return;
    let doc = app.ui.pendingEl.ownerDocument;
    let nearBottom = logNearBottom();
    app.ui.pendingEl.innerHTML = "";
    if (app.paused || !app.settleTimer || !app.pendingLines || !app.pendingLines.length) return;
    let prevName = app.lastRenderedSpeaker;
    let appended = 0;
    app.pendingLines.forEach(function(line) {
      if (!line.msg) return;
      let key = makeKey(line.time, line.name, line.msg);
      if (app.seen.has(key)) return;
      let continued = !!line.name && line.name === prevName;
      app.ui.pendingEl.appendChild(buildEntryNode(doc, {
        key,
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
    if (!app.ui || !app.ui.idleEl) return;
    let empty = !app.log.length && !app.ui.pendingEl.childElementCount;
    app.ui.idleEl.style.display = empty ? "flex" : "none";
    if (!empty) return;
    let text = app.store ? "Waiting for captions \u2014 click <strong>Show Captions</strong> in Zoom if needed" : "Connecting to Zoom\u2026";
    let html = '<div class="__zt-dot __zt-dot--waiting"></div>' + text;
    if (app.ui.idleEl.innerHTML !== html) app.ui.idleEl.innerHTML = html;
  }
  function applyLogFilter() {
    if (!app.ui || !app.ui.settledEl) return;
    let q = app.searchQuery.toLowerCase().trim();
    let rows = app.ui.settledEl.querySelectorAll(".__zt-entry");
    let lastVisibleName = null;
    for (let i = 0; i < rows.length; i++) {
      let row = rows[i];
      let msgEl = row.querySelector(".__zt-entry-msg");
      let show = !q || row.textContent.toLowerCase().indexOf(q) >= 0;
      row.style.display = show ? "" : "none";
      row.classList.remove("__zt-entry--show-name");
      if (msgEl) {
        let orig = msgEl.textContent;
        let idx = show && q ? orig.toLowerCase().indexOf(q) : -1;
        if (idx >= 0) {
          msgEl.innerHTML = escapeHtml(orig.slice(0, idx)) + "<mark>" + escapeHtml(orig.slice(idx, idx + q.length)) + "</mark>" + escapeHtml(orig.slice(idx + q.length));
        } else {
          msgEl.innerHTML = escapeHtml(orig);
        }
      }
      if (!show) continue;
      let name = row.getAttribute("data-name") || null;
      if (q && name && row.classList.contains("__zt-entry--continued") && name !== lastVisibleName) {
        row.classList.add("__zt-entry--show-name");
      }
      lastVisibleName = row.classList.contains("__zt-entry--marker") ? null : name;
    }
  }
  function renderStats() {
    if (!app.ui || !app.ui.statsRowsEl) return;
    let doc = app.ui.statsRowsEl.ownerDocument;
    let names = Object.keys(app.speakerStats);
    let total = 0;
    let max = 0;
    names.forEach(function(n) {
      total += app.speakerStats[n];
      if (app.speakerStats[n] > max) max = app.speakerStats[n];
    });
    names.sort(function(a, b) {
      return app.speakerStats[b] - app.speakerStats[a];
    });
    app.ui.statsMetaEl.textContent = app.log.length + (app.log.length === 1 ? " line" : " lines") + " \xB7 " + elapsedText();
    app.ui.statsRowsEl.innerHTML = "";
    if (!names.length) {
      app.ui.statsRowsEl.innerHTML = '<div class="__zt-idle">No speakers yet</div>';
      return;
    }
    names.forEach(function(n) {
      let count = app.speakerStats[n];
      let color = getSpeakerColor(n);
      let row = doc.createElement("div");
      row.className = "__zt-stat-row";
      row.innerHTML = '<div class="__zt-stat-swatch" style="background:' + color + '"></div><div class="__zt-stat-name">' + escapeHtml(n) + '</div><div class="__zt-stat-bar-wrap"><div class="__zt-stat-bar" style="width:' + Math.round(count / max * 100) + "%;background:" + color + '"></div></div><div class="__zt-stat-pct">' + Math.round(count / total * 100) + '%</div><div class="__zt-stat-lines">' + count + (count === 1 ? " line" : " lines") + "</div>";
      app.ui.statsRowsEl.appendChild(row);
    });
  }
  function startElapsed() {
    if (app.elapsedStart == null) app.elapsedStart = Date.now();
    if (!app.elapsedTimer) app.elapsedTimer = setInterval(updateTimerDisplay, 1e3);
  }
  function elapsedText() {
    if (app.elapsedStart == null) return "0:00";
    let total = Math.max(0, Math.floor((Date.now() - app.elapsedStart) / 1e3));
    return Math.floor(total / 60) + ":" + String(total % 60).padStart(2, "0");
  }
  function updateTimerDisplay() {
    if (!app.ui) return;
    if (!app.paused && app.ui.timerEl) app.ui.timerEl.textContent = elapsedText();
    if (app.collapsed) updatePill();
  }

  // src/ingest.js
  function persistLog() {
    app.log = dedupLog(app.log);
    syncSeenFromLog();
    rebuildSpeakerStats();
    if (app.log.length) {
      localStorage.setItem(keys.storageKey, JSON.stringify(app.log));
    }
    updateUI();
  }
  function ingestLines(lines) {
    if (app.paused) return 0;
    let added = 0;
    lines.forEach(function(line) {
      let key = makeKey(line.time, line.name, line.msg);
      if (app.seen.has(key)) return;
      app.seen.add(key);
      added++;
      app.log.push({
        key,
        time: line.time,
        name: line.name,
        msg: line.msg,
        src: line.src
      });
    });
    if (added) startElapsed();
    return added;
  }
  function ingestChatLines(lines) {
    if (app.paused) return 0;
    let added = 0;
    lines.forEach(function(line) {
      let key = "chat|" + line.chatId;
      if (app.seen.has(key)) return;
      app.seen.add(key);
      added++;
      app.log.push({
        key,
        time: line.time,
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
  function trackChatMessages(reduxState) {
    ingestChatLines(extractChatLines(reduxState));
  }
  app.prevSharers = null;
  function addMarker(text, src) {
    let time = formatTime(Date.now());
    let msg = "\u2014 " + text + " \u2014";
    let key = makeKey(time, null, msg);
    if (app.seen.has(key)) return;
    app.seen.add(key);
    app.log.push({
      key,
      time,
      name: null,
      msg,
      src,
      marker: true
    });
    persistLog();
  }
  function addShareMarker(text) {
    if (app.paused) return;
    addMarker(text, "share-event");
  }
  function trackShareEvents(reduxState) {
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
    Object.keys(cur).forEach(function(id) {
      if (!(id in app.prevSharers)) {
        addShareMarker(cur[id] + " started sharing their screen");
      }
    });
    Object.keys(app.prevSharers).forEach(function(id) {
      if (!(id in cur)) {
        addShareMarker((app.prevSharers[id] || "Someone") + " stopped sharing");
      }
    });
    app.prevSharers = cur;
  }
  function pollStore() {
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
      console.info("[ZT Captions] Redux store found.");
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
      let snapshot = JSON.stringify(lines.map(function(l) {
        return [l.time, l.name, l.msg, l.finished];
      }));
      if (snapshot !== app.lastSnapshot) {
        app.lastSnapshot = snapshot;
        app.pendingLines = lines;
        if (app.settleTimer) clearTimeout(app.settleTimer);
        updateUI();
        app.settleTimer = setTimeout(function() {
          app.settleTimer = null;
          ingestLines(lines);
          app.pendingLines = null;
          persistLog();
        }, SETTLE_MS);
      }
    }
    if (app.store) updateUI();
  }

  // src/styles.js
  function ensureStyles(doc) {
    if (doc.getElementById("__zt-caption-styles")) return;
    let style = doc.createElement("style");
    style.id = "__zt-caption-styles";
    style.textContent = `
    :root {
      --zt-panel-width: ${app.panelWidth}px;
      --zt-log-height: ${app.logHeight}px;

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

    /* \u2500\u2500 Mount + structural \u2500\u2500 */
    .__zt-caption-mount {
      position: relative;
      display: block;
      width: 100%;
      flex: 0 0 auto;
      align-self: stretch;
      margin-top: 6px;
      pointer-events: auto;
      font-family: system-app.ui, -apple-system, sans-serif;
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

    /* \u2500\u2500 Header \u2500\u2500 */
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
    .__zt-btn-icon--active {
      background: var(--zt-icon-btn-active-bg);
      border-color: var(--zt-icon-btn-active-border);
      color: var(--zt-icon-btn-active-text);
    }
    .__zt-btn-icon .__zt-bookmark-icon {
      display: block;
    }
    .__zt-bookmark-mode .__zt-caption-mount,
    .__zt-bookmark-mode .__zt-log-entries {
      cursor: default;
    }
    .__zt-bookmark-mode #__zt-settled .__zt-entry:not(.__zt-entry--marker) {
      cursor: pointer;
    }
    .__zt-bookmark-mode #__zt-settled .__zt-entry:not(.__zt-entry--marker):hover {
      background: var(--zt-btn-hover-bg);
      border-radius: 4px;
    }
    .__zt-entry--bookmarked .__zt-entry-header {
      border-left: 2px solid #f59e0b;
      padding-left: 4px;
      margin-left: -6px;
    }
    .__zt-entry-bookmark {
      border: none;
      background: rgba(245, 158, 11, 0.15);
      color: #f59e0b;
      font-size: 10px;
      font-weight: 600;
      padding: 1px 5px;
      border-radius: 4px;
      cursor: pointer;
      margin-right: 4px;
      flex-shrink: 0;
      font-family: inherit;
      max-width: 140px;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      line-height: 1.3;
    }
    .__zt-entry-bookmark-icon {
      display: inline-flex;
      flex-shrink: 0;
      line-height: 0;
    }
    .__zt-entry-bookmark-label {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
    }
    .__zt-entry-bookmark:hover {
      background: rgba(245, 158, 11, 0.28);
    }
    .__zt-entry--continued .__zt-entry-bookmark {
      display: block;
      margin-bottom: 2px;
      margin-left: 56px;
    }
    .__zt-bookmark-dialog {
      position: absolute;
      inset: 0;
      z-index: 20;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.35);
      border-radius: 8px;
      padding: 12px;
      box-sizing: border-box;
    }
    .__zt-bookmark-dialog-card {
      width: 100%;
      max-width: 280px;
      background: var(--zt-widget-bg);
      border: 1px solid var(--zt-widget-border);
      border-radius: 8px;
      padding: 10px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
    }
    .__zt-bookmark-dialog-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--zt-text-primary);
      margin-bottom: 8px;
    }
    .__zt-bookmark-dialog-card input {
      width: 100%;
      box-sizing: border-box;
      background: var(--zt-search-bg);
      border: 1px solid var(--zt-search-border);
      border-radius: 6px;
      color: var(--zt-search-text);
      font-size: 12px;
      padding: 6px 8px;
      margin-bottom: 8px;
      font-family: inherit;
    }
    .__zt-bookmark-dialog-actions {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 6px;
    }
    .__zt-bookmark-dialog-actions-right {
      display: flex;
      gap: 6px;
      margin-left: auto;
    }

    /* \u2500\u2500 Paused banner \u2500\u2500 */
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

    /* \u2500\u2500 Tabs \u2500\u2500 */
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

    /* \u2500\u2500 Search \u2500\u2500 */
    .__zt-search {
      display: none; /* temporarily hidden \u2014 restore to flex to bring back search */
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

    /* \u2500\u2500 Log entries \u2500\u2500 */
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
    .__zt-entry--chat .__zt-entry-name::after {
      content: ' \xB7 chat';
      font-weight: 500;
      color: var(--zt-text-dim);
    }
    .__zt-entry--chat .__zt-entry-msg {
      font-style: italic;
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

    /* \u2500\u2500 Stats \u2500\u2500 */
    /* Match the app.log panel's user-set height so switching tabs doesn't
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

    /* \u2500\u2500 Footer \u2500\u2500 */
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

    /* \u2500\u2500 Download dropdown \u2500\u2500 */
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

    /* \u2500\u2500 Collapsed pill \u2500\u2500 */
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
      font-family: system-app.ui, -apple-system, sans-serif;
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

  // src/export.js
  function flushPending() {
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
      } catch (e) {
      }
    }
    persistLog();
  }
  function talkTimeSummary() {
    let names = Object.keys(app.speakerStats);
    if (!names.length) return [];
    let total = 0;
    names.forEach(function(n) {
      total += app.speakerStats[n];
    });
    names.sort(function(a, b) {
      return app.speakerStats[b] - app.speakerStats[a];
    });
    return names.map(function(n) {
      let count = app.speakerStats[n];
      return {
        speaker: n,
        lines: count,
        pct: Math.round(count / total * 100)
      };
    });
  }
  function formatOutput() {
    let lastSpeaker = null;
    let body = app.log.map(function(e) {
      let bookmarkLabel = app.bookmarkByKey.get(e.key);
      let parts = [];
      if (bookmarkLabel) parts.push("", "\u2605 BOOKMARK: " + bookmarkLabel);
      if (e.marker) {
        lastSpeaker = null;
        parts.push((e.time || "\u2014") + "  " + e.msg);
        return parts.join("\n");
      }
      let line = "";
      let label = e.name ? e.chat ? e.name + " \xB7 chat" : e.name : null;
      if (label && label !== lastSpeaker) {
        line += "\n[" + label + "]\n";
        lastSpeaker = label;
      }
      line += (e.time || "\u2014") + "  " + (e.chat ? "[chat] " : "") + e.msg;
      parts.push(line);
      return parts.join("\n");
    }).join("\n").trim();
    if (app.bookmarks.length) {
      body += "\n\n\u2014 Bookmarks \u2014\n" + app.bookmarks.map(function(b) {
        return "\u2605 " + b.label + " \u2014 " + (b.time || "\u2014") + " \xB7 " + (b.speaker || "\u2014") + " \xB7 " + (b.preview || "");
      }).join("\n");
    }
    let stats = talkTimeSummary();
    if (stats.length) {
      body += "\n\n\u2014 Talk time \u2014\n" + stats.map(function(s) {
        return s.speaker + ": " + s.pct + "% (" + s.lines + (s.lines === 1 ? " line" : " lines") + ")";
      }).join("\n");
    }
    return body;
  }
  function currentSessionName() {
    return app.sessionName || localStorage.getItem(keys.sessionKey) || "";
  }
  function autoDownloadAlreadyHandled() {
    return localStorage.getItem(keys.autoDownloadKey) === keys.meetingId;
  }
  function claimAutoDownload() {
    if (autoDownloadAlreadyHandled()) return false;
    localStorage.setItem(keys.autoDownloadKey, keys.meetingId);
    return true;
  }
  function releaseAutoDownloadClaim() {
    if (localStorage.getItem(keys.autoDownloadKey) === keys.meetingId) {
      localStorage.removeItem(keys.autoDownloadKey);
    }
  }
  function slugify(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }
  function downloadFilename(ext) {
    let d = /* @__PURE__ */ new Date();
    function pad(n) {
      return (n < 10 ? "0" : "") + n;
    }
    let prefix = slugify(currentSessionName()) || "captions";
    return prefix + "-" + d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "-" + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + "." + (ext || "txt");
  }
  function downloadJson() {
    flushPending();
    if (!app.log.length) {
      alert("No captions captured yet. Try __ztCaption.probe() in console.");
      return;
    }
    let payload = {
      session: currentSessionName() || null,
      exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
      talkTime: talkTimeSummary(),
      bookmarks: app.bookmarks.map(function(b) {
        return {
          id: b.id,
          label: b.label,
          entryKey: b.entryKey,
          time: b.time || null,
          speaker: b.speaker || null,
          preview: b.preview || null
        };
      }),
      entries: app.log.map(function(e) {
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
    let a = activeDoc().createElement("a");
    a.href = "data:application/json;charset=utf-8," + encodeURIComponent(JSON.stringify(payload, null, 2));
    a.download = downloadFilename("json");
    a.click();
    console.info("[ZT Captions] Downloaded JSON export.");
  }
  function downloadCaptions(options) {
    options = options || {};
    let isAuto = !!options.auto;
    let reason = options.reason || "manual";
    if (isAuto) {
      if (!claimAutoDownload()) {
        console.info("[ZT Captions] Auto-download already handled for this meeting.");
        return false;
      }
    }
    flushPending();
    let text = formatOutput();
    if (!text) {
      if (isAuto) releaseAutoDownloadClaim();
      if (!isAuto) alert("No captions captured yet. Try __ztCaption.probe() in console.");
      return false;
    }
    let a = activeDoc().createElement("a");
    a.href = "data:text/plain;charset=utf-8," + encodeURIComponent(text);
    a.download = downloadFilename();
    a.click();
    if (isAuto) {
      resetLog();
      localStorage.removeItem(keys.meetingKey);
      console.info("[ZT Captions] Downloaded captions (" + reason + ") \u2014 app.log cleared for next meeting.");
    } else {
      console.info("[ZT Captions] Downloaded captions (" + reason + ").");
    }
    return true;
  }
  function findMeetingExitButton(target) {
    if (!target || !target.closest) return null;
    let endBtn = target.closest('button[aria-label="End"]');
    if (endBtn) return { btn: endBtn, reason: "end-button" };
    let leaveBtn = target.closest('button[aria-label="Leave"]');
    if (leaveBtn) return { btn: leaveBtn, reason: "leave-button" };
    let footerBtn = target.closest("button.footer-button__button, button.footer-button-base__button");
    if (footerBtn) {
      let label = ((footerBtn.getAttribute("aria-label") || "") + " " + (footerBtn.textContent || "")).trim();
      if (/^end$/i.test(label)) return { btn: footerBtn, reason: "end-button" };
      if (/^leave$/i.test(label)) return { btn: footerBtn, reason: "leave-button" };
    }
    return null;
  }
  function hasTranscriptToSave() {
    if (app.log.length) return true;
    return !!(app.pendingLines && app.pendingLines.length);
  }
  function teardownAutoDownloadHooks() {
    if (app.autoDownloadDoc && app.meetingExitClickHandler) {
      app.autoDownloadDoc.removeEventListener("click", app.meetingExitClickHandler, true);
    }
    if (app.hostEndedObserver) app.hostEndedObserver.disconnect();
    if (app.hostEndedTimer) clearTimeout(app.hostEndedTimer);
    if (app.autoDownloadWin) {
      if (app.tabCloseBeforeUnloadHandler) {
        app.autoDownloadWin.removeEventListener("beforeunload", app.tabCloseBeforeUnloadHandler);
      }
      if (app.tabClosePageHideHandler) {
        app.autoDownloadWin.removeEventListener("pagehide", app.tabClosePageHideHandler);
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
  function setupAutoDownloadHooks(doc) {
    if (!doc || !doc.body || app.autoDownloadDoc === doc) return;
    teardownAutoDownloadHooks();
    app.meetingExitClickHandler = function(e) {
      let hit = findMeetingExitButton(e.target);
      if (hit) downloadCaptions({ auto: true, reason: hit.reason });
    };
    doc.addEventListener("click", app.meetingExitClickHandler, true);
    app.hostEndedObserver = new MutationObserver(function() {
      if (app.hostEndedTriggered || autoDownloadAlreadyHandled()) return;
      let nodes = doc.querySelectorAll(
        '.zm-modal-body-title, .zm-modal-body-content, .confirm-modal-content, [role="dialog"]'
      );
      for (let i = 0; i < nodes.length; i++) {
        let t = nodes[i].textContent || "";
        if (/meeting has been ended by the host/i.test(t) || /ended by host/i.test(t)) {
          if (app.hostEndedTimer) clearTimeout(app.hostEndedTimer);
          app.hostEndedTimer = setTimeout(function() {
            app.hostEndedTimer = null;
            if (app.hostEndedTriggered || autoDownloadAlreadyHandled()) return;
            app.hostEndedTriggered = true;
            downloadCaptions({ auto: true, reason: "host-ended" });
          }, 400);
          return;
        }
      }
    });
    app.hostEndedObserver.observe(doc.body, { childList: true, subtree: true });
    let win = doc.defaultView;
    if (win) {
      app.tabCloseBeforeUnloadHandler = function(e) {
        if (autoDownloadAlreadyHandled() || !hasTranscriptToSave()) return;
        e.preventDefault();
        e.returnValue = "";
      };
      app.tabClosePageHideHandler = function(e) {
        if (e.persisted || autoDownloadAlreadyHandled()) return;
        flushPending();
        if (!hasTranscriptToSave()) return;
        downloadCaptions({ auto: true, reason: "tab-close" });
      };
      win.addEventListener("beforeunload", app.tabCloseBeforeUnloadHandler);
      win.addEventListener("pagehide", app.tabClosePageHideHandler);
      app.autoDownloadWin = win;
    }
    app.autoDownloadDoc = doc;
  }
  function resetLog() {
    if (app.settleTimer) {
      clearTimeout(app.settleTimer);
      app.settleTimer = null;
    }
    app.pendingLines = null;
    app.log = [];
    app.seen = /* @__PURE__ */ new Set();
    app.pauseSkipped = /* @__PURE__ */ new Set();
    app.lastSnapshot = "";
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
    app.bookmarkByKey = /* @__PURE__ */ new Map();
    app.bookmarkMode = false;
    if (app.ui && app.ui.settledEl) app.ui.settledEl.innerHTML = "";
    if (app.ui && app.ui.pendingEl) app.ui.pendingEl.innerHTML = "";
    updateUI();
  }

  // src/ui-core.js
  function onCopyClick() {
    flushPending();
    let text = formatOutput();
    if (!text) {
      alert("No captions captured yet. Try __ztCaption.probe() in console.");
      return;
    }
    navigator.clipboard.writeText(text).then(function() {
      let btn = app.ui && app.ui.copyBtn;
      if (!btn) return;
      btn.textContent = "\u2713 Copied";
      setTimeout(function() {
        btn.textContent = "\u2398 Copy";
      }, 2e3);
    }).catch(function() {
      console.log(text);
      alert("Clipboard blocked \u2014 output logged to console.");
    });
  }
  function shutdown() {
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
    ["__zt-caption-mount", "__zt-pill", "__zt-caption-dock", "__zt-caption-styles"].forEach(function(id) {
      let el = doc.getElementById(id);
      if (el) el.remove();
    });
    doc.documentElement.style.removeProperty("--zt-panel-width");
    doc.documentElement.style.removeProperty("--zt-log-height");
    app.ui = null;
    app.log = [];
    app.seen = /* @__PURE__ */ new Set();
    app.pauseSkipped = /* @__PURE__ */ new Set();
    app.lastSnapshot = "";
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
    app.bookmarkByKey = /* @__PURE__ */ new Map();
    app.bookmarkMode = false;
    window.__ztCaptionLoaded = false;
    delete window.__ztCaption;
    try {
      if (window.parent && window.parent !== window) {
        window.parent.__ztCaptionLoaded = false;
        delete window.parent.__ztCaption;
      }
    } catch (e) {
    }
    console.info("[ZT Captions] Stopped \u2014 click your bookmark to start a fresh transcript.");
  }
  function syncPrefsFromStorage() {
    app.darkMode = localStorage.getItem(keys.darkKey) === "1";
    app.collapsed = localStorage.getItem(keys.collapsedKey) === "1";
  }
  function mountIsHealthy(doc) {
    let mount = doc.getElementById("__zt-caption-mount");
    let pill = doc.getElementById("__zt-pill");
    if (!mount || !pill || !mount.isConnected || !pill.isConnected) return false;
    let box = findCaptionBox(doc);
    if (box) return mount.parentElement === box && pill.parentElement === box;
    let dock = doc.getElementById("__zt-caption-dock");
    return !!(dock && mount.parentElement === dock && pill.parentElement === dock);
  }
  function ensureUiRefs(doc) {
    let mount = doc.getElementById("__zt-caption-mount");
    let pill = doc.getElementById("__zt-pill");
    if (!mount || !pill) return false;
    let box = findCaptionBox(doc);
    let dock = doc.getElementById("__zt-caption-dock");
    app.ui = app.ui || {};
    app.ui.mount = mount;
    app.ui.pill = pill;
    app.ui.dock = dock;
    app.ui.dot = mount.querySelector("#__zt-dot");
    app.ui.timerEl = mount.querySelector("#__zt-timer");
    app.ui.modeBtn = mount.querySelector("#__zt-mode-btn");
    app.ui.bookmarkBtn = mount.querySelector("#__zt-bookmark-btn");
    app.ui.bookmarkDialog = mount.querySelector("#__zt-bookmark-dialog");
    app.ui.bookmarkInput = mount.querySelector("#__zt-bookmark-input");
    app.ui.bookmarkDialogTitle = mount.querySelector("#__zt-bookmark-dialog-title");
    app.ui.bookmarkRemoveBtn = mount.querySelector("#__zt-bookmark-remove");
    app.ui.pausedBanner = mount.querySelector("#__zt-paused-banner");
    app.ui.logEntriesEl = mount.querySelector("#__zt-log-entries");
    app.ui.settledEl = mount.querySelector("#__zt-settled");
    app.ui.pendingEl = mount.querySelector("#__zt-pending");
    app.ui.idleEl = mount.querySelector("#__zt-idle");
    app.ui.statsRowsEl = mount.querySelector("#__zt-stats-rows");
    app.ui.statsMetaEl = mount.querySelector("#__zt-stats-meta");
    app.ui.pauseBtn = mount.querySelector("#__zt-pause-btn");
    app.ui.copyBtn = mount.querySelector("#__zt-copy-btn");
    app.ui.searchInput = mount.querySelector("#__zt-search-input");
    app.ui.pillDot = pill.querySelector("#__zt-pill-dot");
    app.ui.pillChip = pill.querySelector("#__zt-pill-chip");
    app.ui.pillChipDot = pill.querySelector("#__zt-pill-chip-dot");
    app.ui.pillChipName = pill.querySelector("#__zt-pill-chip-name");
    app.ui.pillSpeaking = pill.querySelector("#__zt-pill-speaking");
    app.ui.pillMeta = pill.querySelector("#__zt-pill-meta");
    app.ui.usingBox = !!box;
    ensureBookmarkWiring(mount, doc);
    return true;
  }
  function wireMountEvents(mount, doc) {
    mount.querySelectorAll(".__zt-tab").forEach(function(t) {
      t.classList.toggle("active", t.getAttribute("data-tab") === app.activeTab);
      t.onclick = function() {
        switchTab(t.getAttribute("data-tab"));
      };
    });
    mount.querySelectorAll(".__zt-tab-panel").forEach(function(p) {
      p.style.display = p.getAttribute("data-panel") === app.activeTab ? "" : "none";
    });
    let nameEl = mount.querySelector("#__zt-session-name");
    function syncNameDisplay() {
      nameEl.textContent = app.sessionName || "Name this meeting\u2026";
      nameEl.classList.toggle("__zt-session-name--empty", !app.sessionName);
    }
    syncNameDisplay();
    nameEl.onclick = function() {
      let win = doc.defaultView || window;
      let v = win.prompt("Name this meeting:", app.sessionName);
      if (v === null) return;
      app.sessionName = v.trim();
      localStorage.setItem(keys.sessionKey, app.sessionName);
      syncNameDisplay();
    };
    let searchInput = mount.querySelector("#__zt-search-input");
    searchInput.value = app.searchQuery;
    searchInput.addEventListener("input", function() {
      app.searchQuery = searchInput.value;
      applyLogFilter();
    });
    mount.querySelector("#__zt-mode-btn").textContent = app.darkMode ? "\u{1F319}" : "\u2600\uFE0E";
    mount.querySelector("#__zt-mode-btn").onclick = toggleMode;
    mount.querySelector("#__zt-collapse-btn").onclick = function() {
      setCollapsed(true);
    };
    mount.querySelector("#__zt-pause-btn").onclick = togglePause;
    mount.querySelector("#__zt-banner-resume").onclick = function() {
      setPaused(false);
    };
    mount.querySelector("#__zt-copy-btn").onclick = onCopyClick;
    mount.querySelector("#__zt-stop-btn").onclick = function() {
      let win = doc.defaultView || window;
      if (!win.confirm("Stop recording and remove the caption widget? Your transcript will be cleared.")) return;
      shutdown();
    };
    let dropdown = mount.querySelector("#__zt-dropdown");
    mount.querySelector("#__zt-download-btn").onclick = function(ev) {
      ev.stopPropagation();
      let open = dropdown.classList.toggle("open");
      if (open) {
        let close = function(e2) {
          if (!dropdown.contains(e2.target)) {
            dropdown.classList.remove("open");
            doc.removeEventListener("click", close, true);
          }
        };
        doc.addEventListener("click", close, true);
      }
    };
    dropdown.querySelector('[data-format="txt"]').onclick = function() {
      dropdown.classList.remove("open");
      downloadCaptions({ auto: false, reason: "manual" });
    };
    dropdown.querySelector('[data-format="json"]').onclick = function() {
      dropdown.classList.remove("open");
      downloadJson();
    };
    ["left", "right", "top", "bottom"].forEach(function(side) {
      let horiz = side === "left" || side === "right";
      let sign = side === "left" || side === "top" ? -1 : 1;
      let handle = doc.createElement("div");
      handle.className = "__zt-resize-handle __zt-resize-handle--" + side;
      handle.title = "Drag to resize";
      mount.appendChild(handle);
      handle.addEventListener("mousedown", function(e) {
        e.preventDefault();
        e.stopPropagation();
        let start = horiz ? e.clientX : e.clientY;
        let startVal = horiz ? app.panelWidth : app.logHeight;
        handle.classList.add("active");
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
          doc.removeEventListener("mousemove", onMove, true);
          doc.removeEventListener("mouseup", onUp, true);
          handle.classList.remove("active");
          if (horiz) localStorage.setItem(keys.widthKey, String(app.panelWidth));
          else localStorage.setItem(keys.heightKey, String(app.logHeight));
        }
        doc.addEventListener("mousemove", onMove, true);
        doc.addEventListener("mouseup", onUp, true);
      });
    });
    shieldInputEvents(mount.querySelector("#__zt-search-input"));
    ensureBookmarkWiring(mount, doc);
  }

  // src/ui-mount.js
  function createMount(doc) {
    ensureStyles(doc);
    let mount = doc.getElementById("__zt-caption-mount");
    if (mount) {
      ensureBookmarkWiring(mount, doc);
      if (!mount.dataset.ztBound) {
        mount.dataset.ztBound = "1";
        wireMountEvents(mount, doc);
      }
      return mount;
    }
    mount = doc.createElement("div");
    mount.id = "__zt-caption-mount";
    mount.className = "__zt-caption-mount" + (app.darkMode ? " __zt-dark" : "");
    if (app.collapsed) mount.style.display = "none";
    mount.innerHTML = [
      '<div class="__zt-header">',
      '<div id="__zt-dot" class="__zt-dot __zt-dot--waiting"></div>',
      '<div id="__zt-session-name" class="__zt-session-name" title="Click to name this meeting"></div>',
      '<div class="__zt-meta">',
      '<span id="__zt-timer" class="__zt-timer">0:00</span>',
      "</div>",
      '<button id="__zt-bookmark-btn" class="__zt-btn-icon" type="button" title="Add bookmark">' + bookmarkIconHtml(12) + "</button>",
      '<button id="__zt-mode-btn" class="__zt-btn-icon" type="button" title="Toggle light/dark">\u2600\uFE0E</button>',
      '<button id="__zt-collapse-btn" class="__zt-btn-icon" type="button" title="Collapse">\u2013</button>',
      "</div>",
      '<div id="__zt-paused-banner" class="__zt-paused-banner" style="display:none">',
      "\u23F8 Recording paused \u2014 captions are not being saved",
      '<button id="__zt-banner-resume" class="__zt-btn" type="button">Resume</button>',
      "</div>",
      '<div class="__zt-tabs">',
      '<div class="__zt-tab" data-tab="log">Log</div>',
      '<div class="__zt-tab" data-tab="stats">Stats</div>',
      "</div>",
      '<div class="__zt-tab-panel" data-panel="log">',
      '<div class="__zt-search">',
      '<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><circle cx="6.5" cy="6.5" r="5" stroke="currentColor" stroke-width="1.5"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
      '<input id="__zt-search-input" placeholder="Search transcript\u2026" spellcheck="false">',
      "</div>",
      '<div id="__zt-log-entries" class="__zt-log-entries">',
      '<div id="__zt-idle" class="__zt-idle" style="display:none"></div>',
      '<div id="__zt-settled"></div>',
      '<div id="__zt-pending"></div>',
      "</div>",
      "</div>",
      '<div class="__zt-tab-panel" data-panel="stats">',
      '<div class="__zt-stats-header">',
      '<span class="__zt-stats-label">Talk time</span>',
      '<span id="__zt-stats-meta" class="__zt-stats-label" style="opacity:0.6"></span>',
      "</div>",
      '<div id="__zt-stats-rows"></div>',
      "</div>",
      '<div class="__zt-footer">',
      '<button id="__zt-pause-btn" class="__zt-btn __zt-btn--pause" type="button">\u23F8 Pause</button>',
      '<button id="__zt-copy-btn" class="__zt-btn __zt-btn--primary" type="button">\u2398 Copy</button>',
      '<div class="__zt-spacer"></div>',
      '<div class="__zt-download-wrap">',
      '<button id="__zt-download-btn" class="__zt-btn" type="button">\u2193 Download \u25BE</button>',
      '<div id="__zt-dropdown" class="__zt-dropdown">',
      '<div class="__zt-dropdown-label">Export as</div>',
      '<div class="__zt-dropdown-item" data-format="txt">\u{1F4C4} Plain text <span>.txt</span></div>',
      '<div class="__zt-dropdown-item" data-format="json">\u{1F4CA} Structured <span>.json</span></div>',
      "</div>",
      "</div>",
      '<button id="__zt-stop-btn" class="__zt-btn __zt-btn--stop" type="button">\u25A0 Stop</button>',
      "</div>",
      '<div id="__zt-bookmark-dialog" class="__zt-bookmark-dialog" style="display:none" role="dialog">',
      '<div class="__zt-bookmark-dialog-card">',
      '<div id="__zt-bookmark-dialog-title" class="__zt-bookmark-dialog-title">Name bookmark</div>',
      '<input id="__zt-bookmark-input" type="text" spellcheck="false" placeholder="Bookmark label">',
      '<div class="__zt-bookmark-dialog-actions">',
      '<button id="__zt-bookmark-remove" type="button" class="__zt-btn __zt-btn--stop" style="display:none">Remove</button>',
      '<div class="__zt-bookmark-dialog-actions-right">',
      '<button id="__zt-bookmark-cancel" type="button" class="__zt-btn">Cancel</button>',
      '<button id="__zt-bookmark-save" type="button" class="__zt-btn __zt-btn--primary">Save</button>',
      "</div>",
      "</div>",
      "</div>",
      "</div>"
    ].join("");
    mount.dataset.ztBound = "1";
    wireMountEvents(mount, doc);
    return mount;
  }
  function createPill(doc) {
    ensureStyles(doc);
    let pill = doc.getElementById("__zt-pill");
    if (pill) {
      if (!pill.dataset.ztBound) {
        pill.dataset.ztBound = "1";
        pill.onclick = function() {
          setCollapsed(false);
        };
      }
      return pill;
    }
    pill = doc.createElement("div");
    pill.id = "__zt-pill";
    pill.className = "__zt-pill" + (app.darkMode ? " __zt-dark" : "");
    pill.style.display = app.collapsed ? "flex" : "none";
    pill.innerHTML = [
      '<div id="__zt-pill-dot" class="__zt-dot __zt-pill-dot __zt-dot--waiting"></div>',
      '<div class="__zt-pill-speakers">',
      '<div id="__zt-pill-chip" class="__zt-speaker-chip" style="display:none">',
      '<div id="__zt-pill-chip-dot" class="__zt-chip-dot"></div>',
      '<span id="__zt-pill-chip-name"></span>',
      "</div>",
      '<span id="__zt-pill-speaking" class="__zt-pill-speaking" style="display:none">speaking</span>',
      "</div>",
      '<span id="__zt-pill-meta" class="__zt-pill-meta">0:00</span>',
      '<button id="__zt-expand-btn" class="__zt-btn-icon" type="button" title="Expand">+</button>'
    ].join("");
    pill.onclick = function() {
      setCollapsed(false);
    };
    pill.dataset.ztBound = "1";
    return pill;
  }
  function keepCaptionBoxVisible(doc, box) {
    if (!box) return;
    lockPanelWidth(box);
    box.style.setProperty("display", "flex", "important");
    box.style.setProperty("visibility", "visible", "important");
    box.style.setProperty("opacity", "1", "important");
    let wrap = box.closest(".lt-subtitle-wrap");
    if (wrap) {
      lockPanelWidth(wrap);
      wrap.style.setProperty("display", "block", "important");
      wrap.style.setProperty("visibility", "visible", "important");
    }
  }
  function ensurePinDock(doc) {
    ensureStyles(doc);
    let dock = doc.getElementById("__zt-caption-dock");
    if (!dock) {
      dock = doc.createElement("div");
      dock.id = "__zt-caption-dock";
      dock.className = "__zt-caption-dock";
      doc.body.appendChild(dock);
    }
    lockPanelWidth(dock);
    return dock;
  }
  app.boxAttachTimer = null;
  function scheduleAttachIfNeeded(doc, box) {
    if (app.boxAttachTimer) clearTimeout(app.boxAttachTimer);
    app.boxAttachTimer = setTimeout(function() {
      app.boxAttachTimer = null;
      let mount = doc.getElementById("__zt-caption-mount");
      if (!mount || !mount.isConnected || mount.parentElement !== box) {
        attachMount(doc);
      }
    }, 50);
  }
  function observeCaptionBox(doc, box) {
    if (app.ui && app.ui.boxObserver && app.ui.observedBox === box) return;
    if (app.ui && app.ui.boxObserver) app.ui.boxObserver.disconnect();
    let obs = new MutationObserver(function() {
      scheduleAttachIfNeeded(doc, box);
    });
    obs.observe(box, { childList: true });
    if (!app.ui) app.ui = {};
    app.ui.boxObserver = obs;
    app.ui.observedBox = box;
  }
  function startCaptionDomWatch(doc) {
    if (app.captionDomObserver) return;
    app.captionDomObserver = new MutationObserver(function() {
      let mount = doc.getElementById("__zt-caption-mount");
      if (!mount || !mount.isConnected) {
        watchCaptionPanel();
      }
    });
    app.captionDomObserver.observe(doc.body, { childList: true, subtree: true });
  }
  function attachMount(doc) {
    let mount = doc.getElementById("__zt-caption-mount");
    if (!mount) mount = createMount(doc);
    let pill = doc.getElementById("__zt-pill");
    if (!pill) pill = createPill(doc);
    let box = findCaptionBox(doc);
    let dock = ensurePinDock(doc);
    let usingBox = false;
    if (box) {
      keepCaptionBoxVisible(doc, box);
      observeCaptionBox(doc, box);
      if (mount.parentElement !== box) box.appendChild(mount);
      if (pill.parentElement !== box) box.appendChild(pill);
      dock.style.display = "none";
      usingBox = true;
      if (box.style.bottom) dock.style.bottom = box.style.bottom;
      if (!app.attachBoxLogged) {
        app.attachBoxLogged = true;
        console.info("[ZT Captions] Attached inside caption box.");
      }
    } else {
      if (mount.parentElement !== dock) dock.appendChild(mount);
      if (pill.parentElement !== dock) dock.appendChild(pill);
      dock.style.display = "block";
      if (!app.attachDockLogged) {
        app.attachDockLogged = true;
        console.info("[ZT Captions] Caption box hidden \u2014 keeping pinned recorder visible.");
      }
    }
    startCaptionDomWatch(doc);
    ensureUiRefs(doc);
    applyMode();
    applyCollapsed();
    return true;
  }
  app.lastPanelWatchAt = 0;
  function watchCaptionPanel() {
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

  // src/controls.js
  function setPaused(p) {
    if (app.paused === p) return;
    app.paused = p;
    addMarker(p ? "Recording paused" : "Recording resumed", "pause-event");
    if (app.settleTimer) {
      clearTimeout(app.settleTimer);
      app.settleTimer = null;
    }
    app.pendingLines = null;
    if (!p) {
      app.lastSnapshot = "";
      if (app.store) {
        try {
          let pauseState = app.store.getState();
          extractLines(pauseState).forEach(function(line) {
            let key = makeKey(line.time, line.name, line.msg);
            app.pauseSkipped.add(key);
            app.seen.add(key);
          });
          extractChatLines(pauseState).forEach(function(line) {
            let key = "chat|" + line.chatId;
            app.pauseSkipped.add(key);
            app.seen.add(key);
          });
        } catch (e) {
        }
      }
    }
    updateUI();
  }
  function togglePause() {
    setPaused(!app.paused);
  }
  function applyMode() {
    syncPrefsFromStorage();
    if (!app.ui) return;
    [app.ui.mount, app.ui.pill, app.ui.dock].forEach(function(el) {
      if (el) el.classList.toggle("__zt-dark", app.darkMode);
    });
    if (app.ui.modeBtn) app.ui.modeBtn.textContent = app.darkMode ? "\u{1F319}" : "\u2600\uFE0E";
  }
  function toggleMode() {
    app.darkMode = !app.darkMode;
    localStorage.setItem(keys.darkKey, app.darkMode ? "1" : "");
    if (app.ui && app.ui.settledEl) {
      app.ui.settledEl.innerHTML = "";
      app.renderedLogCount = 0;
      app.lastRenderedSpeaker = null;
    }
    applyMode();
    renderLogItems();
    renderPendingItems();
    updatePill();
  }
  function applyCollapsed() {
    syncPrefsFromStorage();
    if (!app.ui) return;
    if (app.ui.mount) app.ui.mount.style.display = app.collapsed ? "none" : "";
    if (app.ui.pill) app.ui.pill.style.display = app.collapsed ? "flex" : "none";
  }
  function setCollapsed(c) {
    app.collapsed = c;
    localStorage.setItem(keys.collapsedKey, c ? "1" : "");
    applyCollapsed();
    if (!c) scrollLogToBottom();
    updatePill();
  }
  function switchTab(name) {
    app.activeTab = name;
    if (!app.ui || !app.ui.mount) return;
    app.ui.mount.querySelectorAll(".__zt-tab").forEach(function(t) {
      t.classList.toggle("active", t.getAttribute("data-tab") === name);
    });
    app.ui.mount.querySelectorAll(".__zt-tab-panel").forEach(function(p) {
      p.style.display = p.getAttribute("data-panel") === name ? "" : "none";
    });
    if (name === "stats") renderStats();
    else scrollLogToBottom();
  }
  function dotStateClass() {
    if (app.paused) return "__zt-dot--idle";
    if (app.settleTimer && app.pendingLines && app.pendingLines.length) return "__zt-dot--rec";
    if (app.store) return "__zt-dot--idle";
    return "__zt-dot--waiting";
  }
  function updatePill() {
    if (!app.ui || !app.ui.pill) return;
    app.ui.pillDot.className = "__zt-dot __zt-pill-dot " + dotStateClass();
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
      app.ui.pillChip.style.display = "flex";
      app.ui.pillChipDot.style.background = getSpeakerColor(speaker);
      app.ui.pillChipName.textContent = speaker;
      app.ui.pillSpeaking.style.display = speaking ? "" : "none";
    } else {
      app.ui.pillChip.style.display = "none";
      app.ui.pillSpeaking.style.display = "none";
    }
    app.ui.pillMeta.textContent = elapsedText();
  }
  function updateUI() {
    watchCaptionPanel();
    if (!app.ui || !app.ui.mount || !app.ui.dot) return;
    app.ui.dot.className = "__zt-dot " + dotStateClass();
    app.ui.pausedBanner.style.display = app.paused ? "flex" : "none";
    app.ui.logEntriesEl.classList.toggle("__zt-log--paused", app.paused);
    if (app.paused) {
      app.ui.pauseBtn.className = "__zt-btn __zt-btn--resume";
      app.ui.pauseBtn.textContent = "\u25B6 Resume";
    } else {
      app.ui.pauseBtn.className = "__zt-btn __zt-btn--pause";
      app.ui.pauseBtn.textContent = "\u23F8 Pause";
    }
    renderLogItems();
    renderPendingItems();
    syncIdle();
    if (app.activeTab === "stats") renderStats();
    if (!app.paused) app.ui.timerEl.textContent = elapsedText();
    updatePill();
  }

  // src/inject.js
  function tryInjectIntoIframe(source) {
    if (app.injectAttempted || !source) return false;
    let iframe = document.getElementById("webclient");
    if (!iframe || !iframe.contentWindow || !iframe.contentDocument) {
      app.pendingInjectSource = source;
      return false;
    }
    app.pendingInjectSource = null;
    try {
      if (iframe.contentWindow.__ztCaptionLoaded) return true;
      app.injectAttempted = true;
      let script = iframe.contentDocument.createElement("script");
      script.textContent = source;
      iframe.contentDocument.head.appendChild(script);
      updateUI();
      console.info("[ZT Captions] Injected into #webclient iframe.");
      return true;
    } catch (e) {
      console.warn("[ZT Captions] Could not inject into iframe:", e);
      return false;
    }
  }

  // src/index.js
  function iframeRecorderRunning() {
    try {
      let iframe = document.getElementById("webclient");
      return !!(iframe && iframe.contentWindow && iframe.contentWindow.__ztCaptionLoaded);
    } catch (e) {
      return false;
    }
  }
  function boot() {
    if (window.__ztCaptionLoaded) {
      if (!iframeRecorderRunning()) {
        window.__ztCaptionLoaded = false;
        delete window.__ztCaption;
      } else {
        console.warn("[ZT Captions] Already running in this frame.");
        return window.__ztCaption;
      }
    }
    window.__ztCaptionLoaded = true;
    initAppState();
    loadBookmarks();
    window.__ztCaption = {
      getLog: function() {
        return app.log.slice();
      },
      probe: function() {
        app.wcWin = getWebclientWindow();
        let found = findReduxStore(app.wcWin.document);
        let info = {
          frame: window === app.wcWin ? "webclient" : "parent-shell",
          wcUrl: app.wcWin.location.href,
          storeFound: !!found,
          storeActive: !!app.store,
          lineCount: app.log.length,
          captionBoxFound: !!findCaptionBox(app.wcWin.document),
          captionPanelAttached: !!(function() {
            let m = app.wcWin.document.getElementById("__zt-caption-mount");
            return m && m.isConnected;
          })(),
          captionDockVisible: !!(function() {
            let d = app.wcWin.document.getElementById("__zt-caption-dock");
            return d && d.style.display !== "none";
          })()
        };
        if (found) {
          try {
            info.state = probeState(found.getState());
          } catch (e) {
            info.stateError = String(e);
          }
        }
        console.log("[ZT Captions] probe", info);
        return info;
      },
      findStore: function() {
        app.wcWin = getWebclientWindow();
        return findReduxStore(app.wcWin.document);
      }
    };
    if (isParentShell() && document.currentScript) {
      let bootScript = document.currentScript;
      if (bootScript.src) {
        fetch(bootScript.src).then(function(r) {
          return r.text();
        }).then(function(src) {
          tryInjectIntoIframe(src);
        }).catch(function(e) {
          console.warn("[ZT Captions] Could not fetch script for iframe inject:", e);
        });
      } else if (bootScript.textContent) {
        tryInjectIntoIframe(bootScript.textContent);
      }
    }
    if (isParentShell()) {
      let bootScript = document.currentScript;
      let injectRetry = setInterval(function() {
        let win = getWebclientWindow();
        if (win.__ztCaptionLoaded) {
          clearInterval(injectRetry);
          return;
        }
        if (app.pendingInjectSource) tryInjectIntoIframe(app.pendingInjectSource);
        else if (bootScript && bootScript.textContent) tryInjectIntoIframe(bootScript.textContent);
      }, 500);
      setTimeout(function() {
        clearInterval(injectRetry);
      }, 6e4);
      window.__ztCaption = {
        getLog: function() {
          let cap = getWebclientWindow().__ztCaption;
          return cap ? cap.getLog() : [];
        },
        probe: function() {
          let cap = getWebclientWindow().__ztCaption;
          return cap ? cap.probe() : { error: "iframe recorder not loaded yet" };
        },
        findStore: function() {
          return findReduxStore(getWebclientWindow().document);
        }
      };
      console.info("[ZT Captions] Parent shell bootstrap \u2014 recorder runs in #webclient iframe.");
      return window.__ztCaption;
    }
    app.pollTimer = setInterval(pollStore, POLL_MS);
    pollStore();
    try {
      startCaptionsAutoEnable(activeDoc());
    } catch (e) {
    }
    updateUI();
    console.info("[ZT Captions] Ready. Debug with __ztCaption.probe()");
    return window.__ztCaption;
  }
  boot();
})();
