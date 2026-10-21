#!/usr/bin/env node
/*
 * ZT Copilot — local companion server for the ZT Captions bookmarklet.
 *
 * Receives the live Zoom transcript (settled entries + in-flight pending
 * captions) from the bookmarklet, shows it on a local page with AI
 * suggestions driven by your pre-meeting brief, and keeps a transcript
 * backup on disk.
 *
 *   npm run copilot            → http://localhost:7399
 *
 * Config: copilot/config.json (see config.example.json). The Anthropic API
 * key can also come from the ANTHROPIC_API_KEY environment variable.
 * Without a key the server still runs — transcript relay, page, and disk
 * backup all work; only AI suggestions are disabled.
 *
 * Zero npm dependencies by design (Node 18+: built-in http + fetch).
 */

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

// ─── Config ──────────────────────────────────────────────────────────────

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const BRIEF_PATH = path.join(ROOT, 'brief.json');
const TRANSCRIPTS_DIR = path.join(ROOT, 'transcripts');
const PUBLIC_DIR = path.join(ROOT, 'public');

const DEFAULTS = {
  model: 'claude-haiku-4-5',
  myName: '',
  suggestIntervalMs: 8000,
  maxTokens: 300,
  port: 7399
};

let config = Object.assign({}, DEFAULTS);
try {
  Object.assign(config, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
} catch (e) {
  console.warn('[copilot] No config.json found (copy config.example.json). Running without it.');
}
config.apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY || '';

const STALE_MS = 30000;
const SSE_PING_MS = 25000;

// ─── State ───────────────────────────────────────────────────────────────

const state = {
  meetingId: null,
  session: null,
  entries: [],            // settled transcript entries {key,time,name,msg,chat,marker}
  entryKeys: new Set(),
  settledText: '',        // append-only text form (stable prefix → prompt caching)
  pending: [],            // current in-flight caption snapshot {time,name,msg}
  suggestions: [],        // {id,urgency,text,at}
  lastPulse: null,        // {text,at}
  brief: '',
  lastSeenAt: 0,          // last contact from the bookmarklet (incl. heartbeats)
  lastEntryAt: 0,         // last actual transcript content
  newContentSinceAi: false,
  transcriptFile: null
};

try {
  state.brief = (JSON.parse(fs.readFileSync(BRIEF_PATH, 'utf8')).text || '');
} catch (e) { /* no saved brief */ }

let aiBusy = false;
let aiCycleId = 0;
let lastAiAt = 0;
let aiErrorStreak = 0;
let lastBroadcastFeed = null;

// ─── SSE ─────────────────────────────────────────────────────────────────

const sseClients = new Set();

function broadcast(obj) {
  const data = 'data: ' + JSON.stringify(obj) + '\n\n';
  for (const res of sseClients) {
    try { res.write(data); } catch (e) { sseClients.delete(res); }
  }
}

function feedStatus() {
  if (!state.lastSeenAt) return 'waiting';
  return (Date.now() - state.lastSeenAt > STALE_MS) ? 'stale' : 'live';
}

function statusPayload() {
  return {
    type: 'status',
    feed: feedStatus(),
    lastSeenAt: state.lastSeenAt || null,
    lastEntryAt: state.lastEntryAt || null,
    aiEnabled: !!config.apiKey,
    aiBusy: aiBusy
  };
}

setInterval(function () {
  const feed = feedStatus();
  if (feed !== lastBroadcastFeed) {
    lastBroadcastFeed = feed;
    broadcast(statusPayload());
  }
}, 5000);

setInterval(function () {
  for (const res of sseClients) {
    try { res.write(': ping\n\n'); } catch (e) { sseClients.delete(res); }
  }
}, SSE_PING_MS);

// ─── Transcript helpers ──────────────────────────────────────────────────

function entryLine(e) {
  const who = e.marker ? '—' : (e.name ? e.name + (e.chat ? ' (chat)' : '') : '(unknown)');
  return '[' + (e.time || '--') + '] ' + who + ': ' + e.msg;
}

function sanitizeId(id) {
  return String(id || 'meeting').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'meeting';
}

function openTranscriptFile() {
  try { fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true }); } catch (e) { /* ignore */ }
  const d = new Date();
  const pad = function (n) { return (n < 10 ? '0' : '') + n; };
  const stamp = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes());
  state.transcriptFile = path.join(TRANSCRIPTS_DIR, stamp + '-' + sanitizeId(state.meetingId) + '.txt');
  console.log('[copilot] Transcript backup: ' + state.transcriptFile);
}

function appendToBackup(entries) {
  if (!state.transcriptFile) return;
  const text = entries.map(entryLine).join('\n') + '\n';
  fs.appendFile(state.transcriptFile, text, function (err) {
    if (err) console.warn('[copilot] Backup write failed: ' + err.message);
  });
}

function resetMeeting(meetingId, session) {
  console.log('[copilot] New meeting detected (' + meetingId + ') — resetting state.');
  state.meetingId = meetingId;
  state.session = session || null;
  state.entries = [];
  state.entryKeys = new Set();
  state.settledText = '';
  state.pending = [];
  state.suggestions = [];
  state.lastPulse = null;
  state.lastEntryAt = 0;
  state.newContentSinceAi = false;
  openTranscriptFile();
  broadcast({ type: 'reset', meetingId: meetingId, session: state.session });
}

// ─── Anthropic ───────────────────────────────────────────────────────────

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

function baseSystemBlocks() {
  const who = config.myName
    ? 'The user you are assisting is "' + config.myName + '". Transcript lines from a speaker matching that name are the user speaking.'
    : 'The user you are assisting is the person running this tool (speaker name unknown).';

  const instructions = [
    'You are a silent AI meeting copilot watching a live meeting transcript in real time. ' + who,
    'Captions are machine-generated and may contain transcription errors. Lines in the IN-PROGRESS section are still being transcribed and may change.',
    '',
    'Each cycle you produce exactly two things:',
    '1. PULSE — one short line (max ~12 words) telling the user how it is going right now: pace, energy, whether to slow down or speed up, e.g. "going great — good pace", "slow down, you are rushing this section", "speed up, energy is dropping".',
    '2. SUGGESTION — ONLY if you have a genuinely useful, timely, concise nudge: a question directed at the user, an unanswered chat message, an objective from the brief not yet covered while time passes, a commitment just made, a factual point the user should raise. Otherwise reply NONE. Never repeat or rephrase a previous suggestion.',
    '',
    'Reply in EXACTLY this format (three lines, nothing else):',
    'URGENCY: none | info | act-now',
    'PULSE: <one short line>',
    'SUGGESTION: NONE or <1-3 short sentences>',
    '',
    'URGENCY is act-now only when the user should do something right now (e.g. a question is waiting on them). Use info for useful-but-not-urgent. Use none when SUGGESTION is NONE.'
  ].join('\n');

  return [
    { type: 'text', text: instructions },
    {
      type: 'text',
      text: 'MEETING BRIEF (the user\'s notes, objectives, desired outcomes):\n' + (state.brief || '(no brief provided)'),
      cache_control: { type: 'ephemeral' }
    }
  ];
}

function transcriptBlocks(tailText) {
  const blocks = [];
  blocks.push({
    type: 'text',
    text: 'TRANSCRIPT (settled so far):\n' + (state.settledText || '(nothing settled yet)'),
    cache_control: { type: 'ephemeral' }
  });
  blocks.push({ type: 'text', text: tailText });
  return blocks;
}

function pendingText() {
  if (!state.pending.length) return '(none)';
  return state.pending.map(function (l) {
    return '[' + (l.time || '--') + '] ' + (l.name || '(unknown)') + ': ' + l.msg;
  }).join('\n');
}

async function anthropicStream(payload, onDelta) {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(Object.assign({ stream: true }, payload))
  });
  if (!res.ok) {
    const errText = await res.text().catch(function () { return ''; });
    throw new Error('Anthropic API ' + res.status + ': ' + errText.slice(0, 300));
  }
  let full = '';
  let buf = '';
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      let ev;
      try { ev = JSON.parse(data); } catch (e) { continue; }
      if (ev.type === 'content_block_delta' && ev.delta && typeof ev.delta.text === 'string') {
        full += ev.delta.text;
        if (onDelta) onDelta(ev.delta.text);
      }
    }
  }
  return full;
}

function parseUrgency(text) {
  const m = text.match(/URGENCY:\s*(act-now|info|none)/i);
  return m ? m[1].toLowerCase() : 'info';
}

// ─── Suggestion loop ─────────────────────────────────────────────────────

async function runSuggestionCycle(reason) {
  if (!config.apiKey || aiBusy) return false;
  if (!state.entries.length && !state.pending.length) return false;

  aiBusy = true;
  state.newContentSinceAi = false;
  const id = ++aiCycleId;
  broadcast({ type: 'ai-thinking', id: id, reason: reason || 'auto' });

  const priorSuggestions = state.suggestions.slice(-8).map(function (s) { return '- ' + s.text; }).join('\n') || '(none yet)';
  const tail = [
    'IN-PROGRESS CAPTIONS (most recent speech, not yet settled):',
    pendingText(),
    '',
    'PREVIOUS SUGGESTIONS YOU ALREADY MADE (do not repeat):',
    priorSuggestions,
    '',
    'Current time: ' + new Date().toLocaleTimeString(),
    'Give your read now, in the exact three-line format.'
  ].join('\n');

  const payload = {
    model: config.model,
    max_tokens: config.maxTokens,
    system: baseSystemBlocks(),
    messages: [{ role: 'user', content: transcriptBlocks(tail) }]
  };

  // Incremental parse so SUGGESTION text streams to the page as it generates.
  let full = '';
  const sug = { started: false, suppressed: false, buf: '', emittedStart: false, sent: 0, urgency: 'info' };

  function maybeEmit(final) {
    if (sug.suppressed || !sug.started) return;
    const text = sug.buf.replace(/^\s+/, '');
    if (!sug.emittedStart) {
      if (text.length < 5 && !final) return; // wait: could still be "NONE"
      if (!text || /^NONE/i.test(text)) { sug.suppressed = true; return; }
      sug.emittedStart = true;
      sug.urgency = parseUrgency(full);
      broadcast({ type: 'suggestion-start', id: id, urgency: sug.urgency });
    }
    if (text.length > sug.sent) {
      broadcast({ type: 'suggestion-delta', id: id, text: text.slice(sug.sent) });
      sug.sent = text.length;
    }
  }

  function onDelta(t) {
    full += t;
    if (!sug.started) {
      const idx = full.indexOf('SUGGESTION:');
      if (idx === -1) return;
      sug.started = true;
      sug.buf = full.slice(idx + 'SUGGESTION:'.length);
    } else {
      sug.buf += t;
    }
    maybeEmit(false);
  }

  try {
    await anthropicStream(payload, onDelta);
    maybeEmit(true);
    aiErrorStreak = 0;

    const pulseMatch = full.match(/PULSE:\s*(.+)/);
    if (pulseMatch) {
      state.lastPulse = { text: pulseMatch[1].trim(), at: Date.now() };
      broadcast({ type: 'pulse', text: state.lastPulse.text, at: state.lastPulse.at });
    }

    if (sug.emittedStart) {
      const text = sug.buf.trim();
      const suggestion = { id: id, urgency: sug.urgency, text: text, at: Date.now() };
      state.suggestions.push(suggestion);
      broadcast({ type: 'suggestion-done', id: id, urgency: sug.urgency, text: text, at: suggestion.at });
    } else {
      broadcast({ type: 'suggestion-none', id: id });
    }
  } catch (err) {
    aiErrorStreak++;
    console.warn('[copilot] AI call failed: ' + err.message);
    broadcast({ type: 'ai-error', message: err.message });
  } finally {
    aiBusy = false;
    // Back off after repeated failures (bad key, rate limit) instead of spamming.
    lastAiAt = Date.now() + Math.min(aiErrorStreak, 5) * config.suggestIntervalMs * 2;
  }
  return true;
}

setInterval(function () {
  if (!config.apiKey || aiBusy || !state.newContentSinceAi) return;
  if (Date.now() - lastAiAt < config.suggestIntervalMs) return;
  runSuggestionCycle('auto');
}, 1000);

// ─── Transcript Q&A ──────────────────────────────────────────────────────

let queryId = 0;

async function runQuery(question) {
  const id = 'q' + (++queryId);
  broadcast({ type: 'answer-start', id: id, question: question, at: Date.now() });

  const tail = [
    'IN-PROGRESS CAPTIONS (most recent speech, not yet settled):',
    pendingText(),
    '',
    'The user asks: ' + question,
    'Answer concisely and directly based on the transcript and brief, in plain text (no markdown formatting). If the transcript does not contain the answer, say so briefly.'
  ].join('\n');

  const payload = {
    model: config.model,
    max_tokens: 500,
    system: baseSystemBlocks(),
    messages: [{ role: 'user', content: transcriptBlocks(tail) }]
  };

  try {
    const full = await anthropicStream(payload, function (t) {
      broadcast({ type: 'answer-delta', id: id, text: t });
    });
    broadcast({ type: 'answer-done', id: id, text: full.trim() });
  } catch (err) {
    console.warn('[copilot] Query failed: ' + err.message);
    broadcast({ type: 'answer-done', id: id, text: '(error: ' + err.message + ')' });
  }
}

// ─── HTTP server ─────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise(function (resolve, reject) {
    let data = '';
    req.on('data', function (c) {
      data += c;
      if (data.length > 5e6) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', function () { resolve(data); });
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(obj));
}

function handleIngest(body) {
  let payload;
  try { payload = JSON.parse(body); } catch (e) { return { ok: false, error: 'bad json' }; }

  const meetingId = payload.meetingId || 'unknown';
  if (state.meetingId === null) {
    resetMeeting(meetingId, payload.session);
  } else if (meetingId !== state.meetingId) {
    resetMeeting(meetingId, payload.session);
  }
  if (payload.session && payload.session !== state.session) {
    state.session = payload.session;
    broadcast({ type: 'session', session: state.session });
  }

  state.lastSeenAt = Date.now();

  const fresh = [];
  (Array.isArray(payload.entries) ? payload.entries : []).forEach(function (e) {
    if (!e || !e.key || !e.msg || state.entryKeys.has(e.key)) return;
    state.entryKeys.add(e.key);
    const entry = {
      key: e.key,
      time: e.time || '',
      name: e.name || null,
      msg: String(e.msg),
      chat: !!e.chat,
      marker: !!e.marker
    };
    state.entries.push(entry);
    state.settledText += (state.settledText ? '\n' : '') + entryLine(entry);
    fresh.push(entry);
  });

  let pendingChanged = false;
  if (Array.isArray(payload.pending)) {
    const next = payload.pending.filter(function (l) { return l && l.msg; }).map(function (l) {
      return { time: l.time || '', name: l.name || null, msg: String(l.msg) };
    });
    if (JSON.stringify(next) !== JSON.stringify(state.pending)) {
      state.pending = next;
      pendingChanged = true;
    }
  }

  if (fresh.length || pendingChanged) {
    state.lastEntryAt = Date.now();
    state.newContentSinceAi = true;
  }
  if (fresh.length) {
    appendToBackup(fresh);
    broadcast({ type: 'entries', entries: fresh });
  }
  if (pendingChanged) {
    broadcast({ type: 'pending', pending: state.pending });
  }
  if (lastBroadcastFeed !== 'live') {
    lastBroadcastFeed = 'live';
    broadcast(statusPayload());
  }

  return { ok: true, have: state.entries.length };
}

const server = http.createServer(function (req, res) {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  if (req.method === 'POST' && url.pathname === '/ingest') {
    return readBody(req).then(function (body) {
      json(res, 200, handleIngest(body));
    }).catch(function (e) {
      json(res, 400, { ok: false, error: e.message });
    });
  }

  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    res.write('data: ' + JSON.stringify({
      type: 'init',
      meetingId: state.meetingId,
      session: state.session,
      brief: state.brief,
      entries: state.entries.slice(-300),
      totalEntries: state.entries.length,
      pending: state.pending,
      suggestions: state.suggestions.slice(-50),
      pulse: state.lastPulse,
      feed: feedStatus(),
      lastEntryAt: state.lastEntryAt || null,
      aiEnabled: !!config.apiKey,
      model: config.model,
      myName: config.myName,
      suggestIntervalMs: config.suggestIntervalMs
    }) + '\n\n');
    sseClients.add(res);
    req.on('close', function () { sseClients.delete(res); });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/brief') {
    return readBody(req).then(function (body) {
      let payload;
      try { payload = JSON.parse(body); } catch (e) { return json(res, 400, { ok: false }); }
      state.brief = String(payload.text || '');
      fs.writeFile(BRIEF_PATH, JSON.stringify({ text: state.brief, updatedAt: new Date().toISOString() }, null, 2), function () {});
      broadcast({ type: 'brief', brief: state.brief });
      json(res, 200, { ok: true });
    });
  }

  if (req.method === 'POST' && url.pathname === '/ask') {
    if (!config.apiKey) return json(res, 200, { ok: false, error: 'no api key configured' });
    if (aiBusy) return json(res, 200, { ok: false, busy: true });
    lastAiAt = 0;
    runSuggestionCycle('ask');
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/query') {
    return readBody(req).then(function (body) {
      let payload;
      try { payload = JSON.parse(body); } catch (e) { return json(res, 400, { ok: false }); }
      const q = String(payload.question || '').trim();
      if (!q) return json(res, 400, { ok: false, error: 'empty question' });
      if (!config.apiKey) return json(res, 200, { ok: false, error: 'no api key configured' });
      runQuery(q);
      json(res, 200, { ok: true });
    });
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), function (err, data) {
      if (err) { res.writeHead(500); return res.end('missing copilot/public/index.html'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  }

  if (url.pathname === '/favicon.ico') {
    res.writeHead(204);
    return res.end();
  }

  res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
  res.end('not found');
});

server.listen(config.port, '127.0.0.1', function () {
  console.log('[copilot] ZT Copilot running at http://localhost:' + config.port);
  console.log('[copilot] AI suggestions: ' + (config.apiKey ? 'enabled (' + config.model + ')' : 'DISABLED — add apiKey to copilot/config.json or set ANTHROPIC_API_KEY'));
  if (!config.myName) console.log('[copilot] Tip: set "myName" in config.json so the AI knows which speaker is you.');
});
