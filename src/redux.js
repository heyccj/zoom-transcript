import { makeKey, chatFallbackId, isOneShotSystemMessage } from './dedup.js';
export function looksLikeStore(obj) {
  return obj &&
    typeof obj.getState === 'function' &&
    typeof obj.subscribe === 'function' &&
    typeof obj.dispatch === 'function';
}

export function storeFromFiber(fiber, seen) {
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

export function collectFibers(node, out, limit) {
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

export function findReduxStore(doc) {
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

export function attendeeLists(state) {
  let lists = [];
  if (state.attendeesList && state.attendeesList.attendeesList) {
    lists.push(state.attendeesList.attendeesList);
  }
  if (state.attendeesList && Array.isArray(state.attendeesList.list)) {
    lists.push(state.attendeesList.list);
  }
  return lists;
}

export function eachAttendee(state, fn) {
  attendeeLists(state).forEach(function (list) {
    list.forEach(function (a) {
      if (!a) return;
      fn(a, a.userId != null ? a.userId : a.zoomID);
    });
  });
}

export function attendeeNameMap(state) {
  let map = {};
  eachAttendee(state, function (a, id) {
    let name = a.displayName || a.name;
    if (id != null && name) map[id] = name;
  });
  return map;
}

export function activeSharerMap(reduxState) {
  let map = {};
  eachAttendee(reduxState, function (a, id) {
    if (!a.sharerOn || id == null) return;
    map[id] = a.displayName || a.name || 'Someone';
  });
  return map;
}

export function resolveName(msg, names) {
  if (msg.isCaptioner) return '(Captioner)';
  if (msg.user && msg.user.displayName) return msg.user.displayName;
  if (msg.displayName) return msg.displayName;
  if (msg.previousDisplayName) return msg.previousDisplayName;
  if (msg.userId != null && names[msg.userId]) return names[msg.userId];
  return null;
}

export function normalizeText(text) {
  if (!text) return '';
  return String(text).replace(/\uFFFD/g, '').trim();
}

// Format a Unix-ms timestamp as h:mm:ss. Non-numeric values (in case Zoom
// ever supplies a preformatted string) pass through untouched.
export function formatTime(value) {
  let ms = typeof value === 'number' ? value : NaN;
  if (isNaN(ms) && /^\d{10,}$/.test(String(value))) ms = Number(value);
  if (isNaN(ms)) return value == null ? '' : String(value);
  let d = new Date(ms);
  let m = String(d.getMinutes()).padStart(2, '0');
  let s = String(d.getSeconds()).padStart(2, '0');
  return d.getHours() + ':' + m + ':' + s;
}

export function ltBuckets(state) {
  let buckets = [];
  if (state.liveTranscription) buckets.push(state.liveTranscription);
  if (state.newLiveTranscription && state.newLiveTranscription !== state.liveTranscription) {
    buckets.push(state.newLiveTranscription);
  }
  return buckets;
}

export function linesFromAllMessages(state, names) {
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
      if (isOneShotSystemMessage(text)) time = '';
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

export function linesFromNewLTMessage(state, names) {
  let rows = [];

  ltBuckets(state).forEach(function (lt) {
    if (!lt || !lt.newLTMessage) return;
    Object.keys(lt.newLTMessage).forEach(function (id) {
      let msg = lt.newLTMessage[id];
      let text = normalizeText(msg.text || msg.message);
      if (!text) return;
      rows.push({
        time: isOneShotSystemMessage(text) ? '' : (msg.messageTime ? formatTime(msg.messageTime) : ''),
        name: resolveName(msg, names),
        msg: text,
        src: 'newLTMessage',
        finished: msg.isFinished !== false
      });
    });
  });

  return rows;
}

export function linesFromMessageLatest(state) {
  let text = normalizeText(state.meeting && state.meeting.messageLatest);
  if (!text) return [];
  return [{
    time: '',
    name: null,
    msg: text,
    src: 'messageLatest',
    finished: true
  }];
}

export function extractLines(reduxState) {
  let names = attendeeNameMap(reduxState);
  let fromAll = linesFromAllMessages(reduxState, names);
  if (fromAll.length) return fromAll;

  let fromNew = linesFromNewLTMessage(reduxState, names);
  if (fromNew.length) return fromNew;

  return linesFromMessageLatest(reduxState);
}

export function meetingChatThreads(state) {
  let nc = state.newChat;
  if (nc && Array.isArray(nc.meetingChat)) return nc.meetingChat;
  return [];
}

export function chatMessageText(msg, thread) {
  if (!msg) return '';
  let text = normalizeText(msg.text || msg.message);
  if (!text && msg.content) {
    text = normalizeText(typeof msg.content === 'string' ? msg.content : msg.content.text);
  }
  if (!text && thread && !msg.msgId && !msg.id) {
    text = normalizeText(thread.message);
    if (!text && thread.content) {
      text = normalizeText(typeof thread.content === 'string' ? thread.content : thread.content.text);
    }
  }
  if (!text && msg.file) {
    let file = msg.file;
    let label = file.fileName || file.name || (file.file && file.file.name);
    if (label) text = '[file: ' + label + ']';
  }
  return text;
}

export function resolveChatLabel(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    let s = value.trim();
    return s || null;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    return resolveChatLabel(
      value.displayName || value.name || value.userName || value.receiverName ||
      value.label || value.text || value.title
    );
  }
  return null;
}

export function chatSenderName(thread, msg, names) {
  let name = resolveChatLabel(msg.senderName) ||
    resolveChatLabel(thread.senderName) ||
    resolveChatLabel(thread.sender) ||
    resolveChatLabel(thread.chatSender);
  if (name) return name;
  let senderId = msg.senderId != null ? msg.senderId : thread.senderId;
  if (senderId != null && names[senderId]) return names[senderId];
  return null;
}

export function chatAudienceLabel(thread, msg) {
  let ext = msg.meetingChatExt || thread.meetingChatExt;
  if (ext) {
    let receiverName = resolveChatLabel(ext.receiverName);
    if (receiverName) return 'to ' + receiverName;
    if (ext.isPrivately) return 'privately';
  }
  let receiver = resolveChatLabel(thread.chatReceiver) || resolveChatLabel(thread.receiver);
  if (receiver) return 'to ' + receiver;
  return null;
}

export function chatMessageTime(thread, msg) {
  let raw = msg.time || msg.timestamp || msg.timeStamp || msg.ct ||
    thread.time || thread.timeStamp || thread.timestamp;
  return raw ? formatTime(raw) : '';
}

export function chatMessageId(thread, msg, text, time, name) {
  let id = msg.msgId || msg.id || msg.xmppMsgId || thread.msgId || thread.id || thread.xmppMsgId;
  if (id != null && String(id) !== '') return String(id);
  if (isOneShotSystemMessage(text)) return makeKey(null, null, text);
  return chatFallbackId(name, text);
}

export function extractChatLines(reduxState) {
  let names = attendeeNameMap(reduxState);
  let rows = [];
  let seenIds = new Set();

  meetingChatThreads(reduxState).forEach(function (thread) {
    if (!thread) return;
    let msgs = Array.isArray(thread.chatMsgs) && thread.chatMsgs.length
      ? thread.chatMsgs
      : [thread];

    msgs.forEach(function (msg) {
      if (!msg) return;
      let text = chatMessageText(msg, thread);
      if (!text) return;

      let time = chatMessageTime(thread, msg);
      let name = chatSenderName(thread, msg, names);
      let audience = chatAudienceLabel(thread, msg);
      let displayMsg = audience ? text + ' (' + audience + ')' : text;
      let chatId = chatMessageId(thread, msg, text, time, name);
      if (seenIds.has(chatId)) return;
      seenIds.add(chatId);

      rows.push({
        time: time,
        name: name,
        msg: displayMsg,
        src: 'chat',
        chatId: chatId,
        finished: true
      });
    });
  });

  return rows;
}

export function probeState(reduxState) {
  let lt = ltBuckets(reduxState);
  return {
    attendeeCount: Object.keys(attendeeNameMap(reduxState)).length,
    liveTranscriptionKeys: lt.map(function (b) {
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
