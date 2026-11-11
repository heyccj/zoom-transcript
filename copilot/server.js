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
const PROFILE_PATH = path.join(ROOT, 'profile.md');
const TRANSCRIPTS_DIR = path.join(ROOT, 'transcripts');
const PUBLIC_DIR = path.join(ROOT, 'public');

const DEFAULTS = {
  model: 'claude-haiku-4-5',
  myName: '',
  suggestIntervalMs: 20000,   // min gap between routine AI cycles
  minNewWords: 30,            // routine cycles also wait for this much new speech
  suggestCooldownMs: 45000,   // after a card is shown, hold back info cards this long
  repeatWindowMs: 600000,     // a topic (or near-identical text) can't come back within this window
  maxTokens: 300,
  mode: 'meeting',            // 'meeting' (silent coach) or 'present' (proactive presentation assistant)
  port: 7399
};

let config = Object.assign({}, DEFAULTS);
try {
  Object.assign(config, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
} catch (e) {
  console.warn('[copilot] No config.json found (copy config.example.json). Running without it.');
}
config.apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY || '';
if (process.env.PORT) config.port = Number(process.env.PORT);
if (process.env.MODEL) config.model = process.env.MODEL;
if (process.env.EFFORT) config.effort = process.env.EFFORT;
if (process.env.MODE) config.mode = process.env.MODE;

// Optional personal context (role, team, what's worth a nudge). Gitignored.
let profile = '';
try { profile = fs.readFileSync(PROFILE_PATH, 'utf8').trim(); } catch (e) { /* no profile */ }

const firstName = (config.myName || '').split(/\s+/)[0] || '';

const STALE_MS = 30000;
const SSE_PING_MS = 25000;
const FAST_TRIGGER_MIN_MS = 5000; // chat or the user's name → allowed this soon after the last cycle
const ACT_NOW_GAP_MS = 90000;

// Present mode: the user holds the floor and wants to be kept on track, so cycle
// more often and hold cards back for less time than in a normal meeting.
const PRESENT_INTERVAL_MS = 12000;
const PRESENT_MIN_WORDS = 20;
const PRESENT_COOLDOWN_MS = 18000;

// ─── State ───────────────────────────────────────────────────────────────

const state = {
  meetingId: null,
  session: null,
  entries: [],            // settled transcript entries {key,time,name,msg,chat,marker}
  entryKeys: new Set(),
  settledText: '',        // append-only text form (stable prefix → prompt caching)
  pending: [],            // current in-flight caption snapshot {time,name,msg}
  suggestions: [],        // shown cards {id,urgency,topic,tip,say,text,at,feedback}
  directives: [],         // standing instructions typed by the user {id,text,phrase,at}
  mutedTopics: [],        // topic slugs muted from a card
  onYou: [],             // {id,kind: asked|proposed|committed,text,who,open,at}
  vault: {},             // slug → {slug,name,why,status: loaded|dismissed,at}
  brief: '',
  mode: 'meeting',        // 'meeting' (silent coach) or 'present' (proactive presentation assistant)
  lastSeenAt: 0,          // last contact from the bookmarklet (incl. heartbeats)
  lastEntryAt: 0,         // last actual transcript content
  settledWords: 0,
  wordsAtLastAi: 0,
  fastTrigger: false,     // chat message or the user's name just arrived
  lastShownAt: 0,
  lastActNowAt: 0,
  lastAddressedAt: 0,     // last settled line from someone else that said the user's name or asked a question
  heldBack: 0,            // cards the server suppressed as repeats / cooldown
  transcriptFile: null
};

try {
  state.brief = (JSON.parse(fs.readFileSync(BRIEF_PATH, 'utf8')).text || '');
} catch (e) { /* no saved brief */ }

state.mode = config.mode === 'present' ? 'present' : 'meeting';

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
  state.directives = [];
  state.mutedTopics = [];
  state.onYou = [];
  state.lastEntryAt = 0;
  state.settledWords = 0;
  state.wordsAtLastAi = 0;
  state.fastTrigger = false;
  state.lastShownAt = 0;
  state.lastActNowAt = 0;
  state.lastAddressedAt = 0;
  state.heldBack = 0;
  state.vault = {};
  peopleSeen.clear();
  openTranscriptFile();
  broadcast({ type: 'reset', meetingId: meetingId, session: state.session });
  // Notes the brief pointed at before the meeting started come back for the new meeting.
  scanForProjects(state.brief, 'brief');
}

// ─── Vault context ───────────────────────────────────────────────────────
// Optional: a notes folder laid out as <vaultPath>/projects/<slug>/_PROJECT.md.
// When a project is named in the brief or a settled line, an excerpt of its
// note is appended to settledText (append-only, so prompt caching holds).
// Only projects/*/_PROJECT.md is ever read; vaultExclude drops slugs.

const VAULT_MAX_NOTES = 15;
const VAULT_EXCERPT_CHARS = 5000;
let vaultProjects = []; // {slug, name, file, aliases: [{text, exact}]}

function aliasEntry(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  // Short acronyms (LIM, COD, AIC) must match in capitals; everything else is normalized.
  if (t.replace(/[^a-z0-9]/gi, '').length <= 3) return { text: t.toUpperCase(), exact: true };
  const n = normalizeName(t);
  return n.length >= 4 ? { text: n, exact: false } : null;
}

// "William & Mary" and "William and Mary" both become "william mary".
function normalizeName(s) {
  return ' ' + String(s).toLowerCase().replace(/&/g, ' ').replace(/[^a-z0-9]+/g, ' ').replace(/ and /g, ' ').trim() + ' ';
}

function loadVaultIndex() {
  vaultProjects = [];
  if (!config.vaultPath) return;
  const dir = path.join(config.vaultPath, 'projects');
  let slugs = [];
  try { slugs = fs.readdirSync(dir); } catch (e) { console.warn('[copilot] vaultPath has no projects/ folder: ' + dir); return; }
  const exclude = new Set(config.vaultExclude || []);
  slugs.forEach(function (slug) {
    const file = path.join(dir, slug, '_PROJECT.md');
    if (exclude.has(slug) || !fs.existsSync(file)) return;
    let head = '';
    try { head = fs.readFileSync(file, 'utf8').slice(0, 2000); } catch (e) { return; }
    const h1 = (head.match(/^# (.+)$/m) || [])[1] || slug;
    // "Whitworth — Master Memory" → "Whitworth"; "University of Houston — Clear Lake (UHCL)" stays whole.
    let name = h1.replace(/^Project:\s*/i, '').replace(/\s+[—-]\s+(Master Memory|Project Overview)\s*$/i, '').trim();
    if (name === name.toLowerCase()) name = name.replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); });
    const plain = name.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
    const raw = [slug.replace(/-/g, ' '), plain, plain.split(/\s+[—-]\s+/)[0]];
    (h1.match(/\(([A-Z][A-Za-z&]{1,6})\)/g) || []).forEach(function (a) { raw.push(a.slice(1, -1)); });
    const fm = head.match(/^aliases:\s*\[?([^\]\n]+)\]?$/m);
    if (fm) fm[1].split(',').forEach(function (a) { raw.push(a.replace(/["']/g, '')); });
    vaultProjects.push({ slug: slug, name: name, file: file, aliases: raw.map(aliasEntry).filter(Boolean) });
  });
  // Config aliases: {"warrington": "ufl-warrington"}
  Object.keys(config.vaultAliases || {}).forEach(function (alias) {
    const p = vaultProjects.find(function (x) { return x.slug === config.vaultAliases[alias]; });
    const a = aliasEntry(alias);
    if (p && a) p.aliases.push(a);
  });
  // Glossary rows like "| Roan, growing | **Rowan** |" add caption mishearings.
  try {
    fs.readFileSync(path.join(config.vaultPath, '_GLOSSARY.md'), 'utf8').split('\n').forEach(function (line) {
      const m = line.match(/^\|\s*([^|]+?)\s*\|\s*\*\*([^*]+)\*\*/);
      if (!m) return;
      const actual = aliasEntry(m[2]);
      const p = actual && vaultProjects.find(function (x) {
        return x.aliases.some(function (a) { return a.exact === actual.exact && a.text === actual.text; });
      });
      // Capitalized entries only: "Roan" is a mishearing of Rowan, "growing" is just a word.
      if (p) m[1].split(',').forEach(function (h) { const a = /^\s*[A-Z]/.test(h) && aliasEntry(h); if (a) p.aliases.push(a); });
    });
  } catch (e) { /* no glossary */ }
  console.log('[copilot] Vault: ' + vaultProjects.length + ' project notes indexed from ' + dir);
}

function findProjects(text) {
  if (!text || !vaultProjects.length) return [];
  const norm = normalizeName(text);
  return vaultProjects.filter(function (p) {
    return p.aliases.some(function (a) {
      return a.exact ? new RegExp('\\b' + a.text + '\\b').test(text) : norm.indexOf(a.text) !== -1;
    });
  });
}

// Frontmatter + Overview + newest "Current Status" + Risks + Open Items, capped.
function vaultExcerpt(file) {
  const md = fs.readFileSync(file, 'utf8');
  if (md.length <= VAULT_EXCERPT_CHARS) return md;
  const parts = md.split(/^(?=## )/m);
  const pick = [parts[0].slice(0, 800)];
  const want = [/^## Overview/i, /^## (Current|Prior) Status/i, /^## Risks/i, /^## Open Items/i, /^## Key Context/i];
  want.forEach(function (re) {
    const sec = parts.find(function (p) { return re.test(p); });
    if (sec) pick.push(sec.slice(0, 1500));
  });
  return pick.join('\n').slice(0, VAULT_EXCERPT_CHARS);
}

function vaultList() {
  return Object.keys(state.vault).map(function (key) { return state.vault[key]; });
}

// Never send credentials to the model or put them on screen.
const VAULT_DENY_NAME = /(^|[_\-.])(keys?|secrets?|credentials?|passwords?|tokens?)([_\-.]|$)/i;
const VAULT_SECRET_RE = /sk-ant-[\w-]{10,}|sk-[A-Za-z0-9]{32,}|ghp_[A-Za-z0-9]{20,}|xox[abp]-[\w-]{10,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY/;
const VAULT_FILE_CHARS = 12000;  // explicitly requested notes and people notes
const VAULT_MAX_REQUESTED = 6;
const VAULT_MAX_PER_PERSON = 3;

// Read a note under vaultPath, or null if it is outside the vault, not markdown, or holds secrets.
function readVaultFile(rel) {
  if (!config.vaultPath) return null;
  const root = path.resolve(config.vaultPath);
  const file = path.resolve(root, String(rel || '').trim());
  if (file.indexOf(root + path.sep) !== 0 || !/\.md$/i.test(file)) {
    console.warn('[copilot] Vault: refused ' + rel + ' (outside the vault or not a .md file)');
    return null;
  }
  if (VAULT_DENY_NAME.test(path.basename(file, '.md'))) {
    console.warn('[copilot] Vault: refused ' + rel + ' (looks like a credentials file)');
    return null;
  }
  let md;
  try { md = fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
  if (VAULT_SECRET_RE.test(md)) {
    console.warn('[copilot] Vault: refused ' + rel + ' (contains something that looks like a key)');
    return null;
  }
  return { file: file, rel: path.relative(root, file), md: md };
}

function noteTitle(md, fallback) {
  const h1 = (md.match(/^# (.+)$/m) || [])[1];
  return (h1 || fallback).replace(/\s+[—-]\s+(Master Memory|Project Overview)\s*$/i, '').trim();
}

function appendVaultBlock(key, entry, text) {
  state.settledText += (state.settledText ? '\n' : '') +
    '[vault] The user\'s own notes: ' + entry.name + ' (note: ' + key + '; loaded because of the ' + entry.why + '; may be out of date):\n' +
    text.trim() + '\n[/vault]';
  state.vault[key] = entry;
  console.log('[copilot] Vault note loaded: ' + key + ' (' + entry.why + ')');
  broadcast({ type: 'vault', notes: vaultList() });
}

function countLoaded(kind) {
  return vaultList().filter(function (v) { return v.status === 'loaded' && v.kind === kind; }).length;
}

function loadVaultNote(p, why) {
  if (state.vault[p.slug]) return; // loaded or dismissed this meeting
  if (countLoaded('project') >= VAULT_MAX_NOTES) return;
  const f = readVaultFile(path.relative(config.vaultPath, p.file));
  if (!f) return;
  appendVaultBlock(p.slug, { key: p.slug, name: p.name, why: why, kind: 'project', status: 'loaded', at: Date.now() }, vaultExcerpt(p.file));
}

// A full note named by path (the brief's NOTES: line, or a people note).
function loadVaultFile(rel, why, kind) {
  const f = readVaultFile(rel);
  if (!f || state.vault[f.rel]) return false;
  if (kind === 'requested' && countLoaded('requested') >= VAULT_MAX_REQUESTED) return false;
  const name = noteTitle(f.md, path.basename(f.rel, '.md'));
  appendVaultBlock(f.rel, { key: f.rel, name: name, why: why, kind: kind, status: 'loaded', at: Date.now() }, f.md.slice(0, VAULT_FILE_CHARS));
  return true;
}

// "NOTES: projects/management/2026-10-08_volt-1-1-prep.md, _NORTH_STAR.md"
function loadBriefNotes(brief) {
  const m = String(brief || '').match(/^NOTES:\s*(.+)$/mi);
  if (!m) return;
  m[1].split(',').forEach(function (rel) { loadVaultFile(rel.replace(/[`"']/g, ''), 'brief', 'requested'); });
}

function scanForProjects(text, why) {
  findProjects(text).forEach(function (p) { loadVaultNote(p, why); });
  if (why === 'brief') loadBriefNotes(text);
}

// People notes: projects/management/1-1_<person>.md, 1-1-practice_<person>.md,
// <date>_<person>-1-1-prep.md. Loaded when that person speaks.
let vaultPeople = []; // {person, rel, rank}

function loadPeopleIndex() {
  vaultPeople = [];
  if (!config.vaultPath) return;
  let files = [];
  try { files = fs.readdirSync(path.join(config.vaultPath, 'projects', 'management')); } catch (e) { return; }
  files.forEach(function (f) {
    let m;
    if ((m = f.match(/^1-1_(.+)\.md$/))) vaultPeople.push({ person: m[1], rel: 'projects/management/' + f, rank: '0' });
    else if ((m = f.match(/^1-1-practice_(.+)\.md$/))) vaultPeople.push({ person: m[1], rel: 'projects/management/' + f, rank: '1' });
    else if ((m = f.match(/^(\d{4}-\d\d-\d\d)_(.+?)-1-1-prep\.md$/))) vaultPeople.push({ person: m[2], rel: 'projects/management/' + f, rank: '2' + (9e8 - Date.parse(m[1]) / 1e4) });
  });
  vaultPeople.sort(function (a, b) { return a.rank < b.rank ? -1 : 1; });
}

// "Chris Norman" matches chris-norman; a one-word note name matches as a prefix
// of the first name ("volt" → "Voltaire").
function personMatches(person, speaker) {
  const words = person.toLowerCase().split('-');
  const sp = normalizeName(speaker).trim().split(' ');
  if (words.length > 1) return normalizeName(speaker).indexOf(' ' + words.join(' ') + ' ') !== -1;
  return words[0].length >= 4 && sp[0].indexOf(words[0]) === 0;
}

const peopleSeen = new Set();

function loadPeopleNotes(speaker) {
  if (!speaker || speaker === config.myName || peopleSeen.has(speaker)) return;
  peopleSeen.add(speaker);
  const alias = (config.vaultPeople || {})[speaker];
  let n = 0;
  vaultPeople.forEach(function (p) {
    if (n >= VAULT_MAX_PER_PERSON) return;
    if (personMatches(p.person, speaker) || (alias && p.person === alias)) {
      if (loadVaultFile(p.rel, 'speaker ' + speaker, 'person')) n++;
    }
  });
}

// Dismissing can't remove text from the cached prefix, so it appends a retraction.
function dismissVaultNote(key) {
  const v = state.vault[key];
  if (!v || v.status !== 'loaded') return;
  v.status = 'dismissed';
  state.settledText += '\n[vault] Disregard the notes "' + v.name + '" (note: ' + key + ') loaded above; the user removed them.';
  broadcast({ type: 'vault', notes: vaultList() });
}

loadPeopleIndex();
loadVaultIndex();

// ─── Anthropic ───────────────────────────────────────────────────────────

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

function baseSystemBlocks() {
  const who = config.myName
    ? 'The user you are assisting is "' + config.myName + '". Transcript lines from a speaker matching that name are the user speaking.' +
      (firstName ? ' Other people may share the first name "' + firstName + '". A third-person mention ("get ' + firstName + ' to sign off") is about someone else unless the context clearly means the user.' : '')
    : 'The user you are assisting is the person running this tool (speaker name unknown).';

  const captionsLine = 'Captions are machine-generated and may contain transcription errors, especially names. Lines in the IN-PROGRESS section are still being transcribed and may change.';
  const vaultLine = 'Blocks marked [vault] in the transcript are the user\'s own notes (projects, people, their role and career), loaded because they came up. Use them for facts, history, open items, decisions, and what the user is trying to achieve with these people. Never recap or read them back; the user wrote them. They may be out of date, so prefer what is said in the meeting when the two conflict.';
  const directiveLine = 'When the user gives you a standing directive (listed under USER DIRECTIVES), it overrides everything else for the rest of the meeting.';

  const role = state.mode === 'present'
    ? [
        'You are a live presentation assistant. The user you are assisting is LEADING a training or presentation right now. ' + who,
        captionsLine,
        '',
        'The user is doing most of the talking, on purpose. Your job is to keep them on track and make the session land. The MEETING BRIEF is their agenda or script: track where they are in it. Speak up to move them to the next point once they finish one, to flag an agenda item or key detail they seem to have skipped, to feed a fact from their notes they could add, to catch pacing problems (racing ahead, one section running long, a long stretch with no pause for questions), and to surface a question an attendee asked that the user has not answered yet.',
        'Speak more readily than in a normal meeting, but one nudge at a time, and stay silent while the user is mid-point and on track. NEVER tell the user to talk less, that they have been quiet, or to speak up; they are supposed to hold the floor. Use SPEAKING STATS only for pacing (how long the user has held the floor without a pause), never to suggest talking less.',
        'Never read the user\'s own content back to them or narrate what was just said; they heard it. A card is forward-looking: what to do or say NEXT.',
        '',
        'Style: never address the user by name and never use a salutation. Be terse. A DO is a short instruction that starts with a verb (e.g. "Move to the deployment section." "Pause and ask if there are questions." "Slow down, you skipped the asset-location step."). A SAY is the exact words the user could say out loud to do it.'
      ]
    : [
        'You are a silent AI meeting copilot watching a live meeting transcript in real time. ' + who,
        captionsLine,
        '',
        'You are a coach, not a note-taker. The user is in the meeting and heard everything; never tell them what someone said, asked, or wants. Your only output is guidance: what to say or ask next, and how to handle the moment (when to pause, push back, pin something down, let someone finish, slow down, hand the floor back).',
        'Stay quiet unless that guidance would change what the user does in the next minute or two. Silence is the default and the expected outcome on most cycles. Good moments, all rare: a question or proposal is waiting on the user (coach how to answer it, or what to ask first); something about the user\'s work, role, scope, or career is being decided without a number, date, or scope; a fact the user could add; a sharper question would get the user a better outcome; a speaking habit worth correcting, backed by SPEAKING STATS or the transcript. This is the whole list of when to speak; the per-cycle rules below do not add to it.',
        'Not worth it: anything that restates the meeting, open threads nobody needs resolved right now, small talk, anything already raised, generic nudges like "you have been quiet" or "speak up".',
        'Never pressure the user to commit, agree, or sign off. If the user is already answering or handling it, stay quiet.',
        '',
        'Style: never address the user by name and never use a salutation. Be terse. A DO is a short instruction that starts with a verb (e.g. "Pin down hours before you agree." "Let him finish the ask, then answer."). A SAY is the exact words the user could say out loud (e.g. "Before I take that on, roughly how many hours a month is it?"). Never describe what anyone else said or wants.'
      ];

  const instructions = role.concat(['', vaultLine, '', directiveLine]).join('\n');

  const blocks = [{ type: 'text', text: instructions }];
  if (profile) blocks.push({ type: 'text', text: 'ABOUT THE USER (standing context):\n' + profile });
  blocks.push({
    type: 'text',
    text: 'MEETING BRIEF (the user\'s notes, objectives, desired outcomes):\n' + (state.brief || '(no brief provided)'),
    cache_control: { type: 'ephemeral' }
  });
  return blocks;
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

function wordCount(s) {
  return (String(s).match(/\S+/g) || []).length;
}

function totalWords() {
  return state.settledWords + state.pending.reduce(function (n, l) { return n + wordCount(l.msg); }, 0);
}

// ─── Repeat detection ────────────────────────────────────────────────────
// The model rephrases instead of repeating, so "do not repeat" in the prompt
// is not enough. These checks run on the finished reply before it is shown.

const STOPWORDS = new Set(('the and are you your for with that this does did what who how when before after just now from ' +
  'about there their they them have has had will would could should can not into than then was were been being its ' +
  'still also any all our out get got some more want wants need needs make sure lets let going').split(' '));

function contentWords(s) {
  const words = String(s).toLowerCase().replace(/&/g, ' and ').match(/[a-z0-9']+/g) || [];
  return new Set(words.filter(function (w) { return w.length > 2 && !STOPWORDS.has(w); }));
}

// Overlap coefficient: share of the smaller set found in the larger one.
function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  a.forEach(function (w) { if (b.has(w)) n++; });
  return n / Math.min(a.size, b.size);
}

function slugWords(slug) {
  return new Set(String(slug || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}

function sameTopic(a, b) {
  return overlap(slugWords(a), slugWords(b)) > 0.5;
}

function normalizePhrase(s) {
  return String(s).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}

// Why a finished suggestion should be held back, or null to show it.
// Nudge now (ignoreCooldown) still respects directives, mutes, and repeats.
function holdBackReason(s, ignoreCooldown) {
  const now = Date.now();
  const words = contentWords(s.text);
  const flat = ' ' + normalizePhrase(s.text) + ' ';
  for (const d of state.directives) {
    if (d.phrase && flat.indexOf(' ' + d.phrase + ' ') !== -1) return 'directive: ' + d.text;
  }
  if (s.topic && state.mutedTopics.some(function (t) { return sameTopic(t, s.topic); })) return 'muted topic';
  for (const prev of state.suggestions) {
    if (now - prev.at > config.repeatWindowMs) continue;
    if (s.topic && prev.topic && sameTopic(prev.topic, s.topic)) return 'repeat topic (' + prev.topic + ')';
    if (overlap(words, contentWords(prev.text)) >= 0.5) return 'repeat text';
  }
  const cooldownMs = state.mode === 'present' ? PRESENT_COOLDOWN_MS : config.suggestCooldownMs;
  if (!ignoreCooldown && s.urgency !== 'act-now' && s.urgency !== 'answer' && now - state.lastShownAt < cooldownMs) return 'cooldown';
  return null;
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
  const m = text.match(/URGENCY:\s*(act-now|answer|info|none)/i);
  return m ? m[1].toLowerCase() : 'info';
}

// ─── "On you" list ───────────────────────────────────────────────────────
// Running list of what is directly on the user: questions/requests aimed at
// them, things proposed to them, and things they committed to. Replaces the
// old meeting pulse; doubles as the action-item recap.

const ON_YOU_KINDS = ['asked', 'proposed', 'committed'];
let onYouId = 0;

function onYouText() {
  if (!state.onYou.length) return '(empty)';
  return state.onYou.map(function (y) {
    return '- [' + y.id + '] ' + y.kind + (y.kind !== 'committed' ? (y.open ? ', open' : ', answered') : '') + ': ' + y.text + (y.who ? ' (' + y.who + ')' : '');
  }).join('\n');
}

// Returns true if the list changed.
function applyOnYou(full) {
  let changed = false;
  (full.match(/^\s*ADD:\s*(.*)$/gmi) || []).slice(0, 2).forEach(function (line) {
    const parts = line.replace(/^\s*ADD:\s*/i, '').split('|').map(function (p) { return p.trim(); });
    const kind = (parts[0] || '').toLowerCase();
    if (ON_YOU_KINDS.indexOf(kind) === -1 || !parts[1]) return;
    const words = contentWords(parts[1]);
    // Same item reworded? A proposal becoming a commitment is a new item.
    const dupe = state.onYou.some(function (y) { return y.kind === kind && overlap(words, contentWords(y.text)) >= 0.5; });
    if (dupe) return;
    const item = { id: 'Y' + (++onYouId), kind: kind, text: parts[1], who: parts[2] || '', open: kind !== 'committed', at: Date.now() };
    state.onYou.push(item);
    changed = true;
    if (kind === 'asked') broadcast({ type: 'onyou-asked', text: item.text });
  });
  const close = field(full, 'CLOSE').match(/Y\d+/gi) || [];
  close.forEach(function (cid) {
    const y = state.onYou.find(function (x) { return x.id.toLowerCase() === cid.toLowerCase(); });
    if (y && y.open) { y.open = false; changed = true; }
  });
  return changed;
}

// A DO should be an instruction. "Greg is asking whether..." / "Steve's raising..."
// is a recap of what the user just heard, which is useless.
const RECAP_RE = /^(?:(?:[A-Z][\w'\u2019-]+)(?:\s+[A-Z][\w'\u2019-]+)?|They|He|She|Everyone|The (?:team|client|group|room))(?:['\u2019]s\s+\w+ing\b|\s+(?:is|are|was|were|just|wants|asked|asks|needs|has|have|had|said|says|mentioned|offered|proposed|suggested|flagged|thinks|seems|confirmed|raised|described)\b)/;

function isRecap(text) {
  return RECAP_RE.test(text);
}

// The user voicing uncertainty about a fact ("I don't know...", "could be
// wrong", "need to figure out the details") is exactly when a loaded note can
// help, so it earns a fast cycle instead of waiting out the routine interval.
const UNCERTAINTY_RE = /\b(i (?:don'?t|do not) know|not (?:sure|certain)|no idea|can'?t remember|don'?t remember|i forget|could be wrong|might be wrong|don'?t think it'?s|need to (?:figure|confirm|check|find out)|(?:figure|figured|sort|sorted)\b[^.?!]{0,30}\b(?:out|details)\b|\bdetails\b[^.?!]{0,15}\b(?:figured|sorted|confirmed|nailed down)\b)/i;

function clockSec(t) {
  const m = /^(\d\d):(\d\d):(\d\d)$/.exec(t || '');
  return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : null;
}

// Talk share and recency, so behavior tips rest on numbers, not guesses.
function speakingStats() {
  if (!config.myName) return '(user name unknown)';
  const timed = state.entries.filter(function (e) { return !e.marker && !e.chat && clockSec(e.time) !== null; });
  if (!timed.length) return '(not enough speech yet)';
  const now = clockSec(timed[timed.length - 1].time);
  let mine = 0, all = 0, lastMine = null;
  timed.forEach(function (e) {
    const t = clockSec(e.time);
    if (e.name === config.myName) lastMine = e.time;
    if (now - t > 180) return;
    const w = wordCount(e.msg);
    all += w;
    if (e.name === config.myName) mine += w;
  });
  const share = all ? Math.round(mine / all * 100) : 0;
  return 'last 3 min, user spoke ' + share + '% of ' + all + ' words; user last spoke at ' + (lastMine || 'never') + '; latest line at ' + timed[timed.length - 1].time + '.';
}

// Only credit a vault note that is actually loaded.
function vaultSource(v) {
  const want = String(v || '').trim().toLowerCase();
  const hit = vaultList().find(function (n) { return n.status === 'loaded' && n.key.toLowerCase() === want; });
  return hit ? hit.key : '';
}

// act-now is only believable right after someone addressed the user.
function addressedRecently() {
  if (Date.now() - state.lastAddressedAt < 60000) return true;
  const nameRe = firstName ? new RegExp('\\b' + firstName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i') : null;
  return state.pending.some(function (l) {
    return l.name !== config.myName && ((nameRe && nameRe.test(l.msg)) || /\?\s*$/.test(l.msg));
  });
}

// ─── Suggestion loop ─────────────────────────────────────────────────────

function field(full, name) {
  const m = full.match(new RegExp('^\\s*' + name + ':\\s*(.*)$', 'mi'));
  const v = m ? m[1].trim() : '';
  return /^NONE\b/i.test(v) ? '' : v;
}

// Belt and braces for "never address the user by name".
function stripSalutation(text) {
  if (!firstName || !text) return text;
  const name = config.myName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const first = firstName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const out = text.replace(new RegExp('^(' + name + '|' + first + ')\\s*[,:—-]\\s*', 'i'), '');
  return out.charAt(0).toUpperCase() + out.slice(1);
}

function suggestionFeedbackText() {
  const lines = [];
  const up = state.suggestions.filter(function (s) { return s.feedback === 'up'; }).slice(-5);
  const down = state.suggestions.filter(function (s) { return s.feedback === 'down'; }).slice(-5);
  if (up.length) lines.push('The user marked these USEFUL (more like this):', up.map(function (s) { return '- ' + s.text; }).join('\n'));
  if (down.length) lines.push('The user marked these NOT USEFUL (avoid this kind of nudge):', down.map(function (s) { return '- ' + s.text; }).join('\n'));
  return lines.join('\n');
}

// One cycle = one model call, then a fixed pipeline over its reply before
// anything reaches the page. The prompt alone cannot be trusted to self-filter
// (the model rephrases around "do not repeat"), so each stage is enforced here:
//
//   parse fields (field/parseUrgency)
//     → LEDGER: applyOnYou()            update the ON YOU list (independent of the card)
//     → resolve URGENCY                 act-now needs addressedRecently() + ACT_NOW_GAP_MS;
//                                        answer needs a loaded-note SOURCE, else both fall to info
//     → drop recap DO (isRecap)         skipped for answer cards, which are meant to state a fact
//     → NONE if no DO and no SAY
//     → holdBackReason()                directive phrase / muted topic / repeat topic or text /
//                                        cooldown (act-now and answer skip cooldown)
//     → show (broadcast) + record lastShownAt / lastActNowAt
//
// Triggering lives in the setInterval below: routine (interval + minNewWords)
// or a fast lane (chat, the user's name, or the user voicing uncertainty).
async function runSuggestionCycle(reason) {
  if (!config.apiKey || aiBusy) return false;
  if (!state.entries.length && !state.pending.length) return false;

  aiBusy = true;
  state.wordsAtLastAi = totalWords();
  state.fastTrigger = false;
  const id = ++aiCycleId;
  broadcast({ type: 'ai-thinking', id: id, reason: reason || 'auto' });

  const raised = state.suggestions.slice(-20).map(function (s) {
    return '- [' + (s.topic || 'no-topic') + '] ' + s.text;
  }).join('\n') || '(none yet)';
  const directives = state.directives.map(function (d) { return '- ' + d.text; }).join('\n') || '(none)';
  const muted = state.mutedTopics.join(', ') || '(none)';
  const feedback = suggestionFeedbackText();

  const cardRules = state.mode === 'present'
    ? 'CARD rules: give one forward-looking nudge whenever the presentation guidance in the system prompt applies; otherwise NONE, and NONE while the user is mid-point and on track. A SAY is the words the user could say out loud to do the DO (move on, pause for questions, add a fact). Never restate or narrate what was just said: a card that only tells the user something they just heard is NONE (answer, below, is the one exception). If the user\'s latest lines (settled or IN-PROGRESS) already handle it, stay quiet. When DO and SAY are both NONE, URGENCY is none and TOPIC is NONE.'
    : 'CARD rules: NONE for DO and SAY is the default and the expected outcome on most cycles; speak only at the moments the system prompt lists, nowhere else. A SAY is a clarifying question, a fact, or a boundary; it never accepts, agrees to, or commits the user to anything. Never restate the meeting: a card that would only tell the user something they just heard is NONE (answer, below, is the one exception). If the user\'s latest lines (settled or IN-PROGRESS) already respond, stay quiet. When DO and SAY are both NONE, URGENCY is none and TOPIC is NONE.';

  const tail = [
    'IN-PROGRESS CAPTIONS (most recent speech, not yet settled):',
    pendingText(),
    '',
    'USER DIRECTIVES (standing instructions for this meeting, always follow):',
    directives,
    '',
    'MUTED TOPICS (never raise): ' + muted,
    '',
    'ALREADY RAISED (the user has seen these cards; do not raise the same topic again in any wording):',
    raised,
    feedback ? '\n' + feedback : '',
    '',
    'ON YOU (running list the user can see; ids in brackets):',
    onYouText(),
    '',
    'SPEAKING STATS (computed from caption timestamps): ' + speakingStats(),
    '',
    'Current time: ' + new Date().toLocaleTimeString(),
    '',
    'Reply in EXACTLY this format, nothing else. It carries two independent jobs: the CARD (whether to coach the user right now) and the LEDGER (keeping the ON YOU list current). Judge them separately; either may be NONE while the other is not.',
    '',
    '== CARD ==',
    'URGENCY: none | info | act-now | answer',
    'TOPIC: NONE or <2-4 word kebab-case slug naming the subject, e.g. vendor-handoff-ownership>',
    'DO: NONE or <short instruction starting with a verb: how to handle this moment>',
    'SAY: NONE or <exact words the user could say out loud, one or two sentences>',
    'SOURCE: NONE or <the [vault] note id the card relies on>',
    '',
    '== LEDGER ==',
    'ADD: NONE or <asked | proposed | committed> | <what, max ~12 words> | <who>',
    'CLOSE: NONE or <ids of open asked/proposed items the user has now answered, comma-separated>',
    '',
    cardRules,
    '  - act-now: someone is waiting on the user right now (a direct question to them they have not answered yet). Expect zero to three in a whole meeting. info: useful but not urgent.',
    '  - answer: the user just said they are unsure of a fact, are missing a number/name/date, or asked an open factual question ("I don\'t know what the CMS is", "I think it\'s X but could be wrong", "we need to figure out the details"), AND a loaded [vault] note settles it. Put the fact in SAY phrased as the user could say it out loud, keep DO to a short lead-in (e.g. "Pull this from your notes:"), and set SOURCE to the note id. This is the one case where stating a fact the user did not just hear is wanted. Never invent a fact: if no loaded [vault] note contains it, do not use answer. Still obey ALREADY RAISED and MUTED TOPICS; answer the same gap only once.',
    'LEDGER rules: only things directly on the user, and direction matters. asked = SOMEONE ELSE asked the user a question or made a request of the user, and the user has not answered yet. Questions the user asks other people never go on the list. proposed = someone else wants the user to take something on and the user has not agreed or declined. committed = the user agreed to or said they will do something, including following up with someone ("I\'ll ask Pia", "I can follow up with him"). CLOSE an asked or proposed item as soon as the user\'s reply addresses it, even briefly; a question back is not an answer. ADD at most one item per cycle (two ADD lines only if two separate things just happened), and never one already on the list in any wording. Other people\'s tasks, general open threads, and small talk never go on the list.'
  ].join('\n');

  const payload = {
    model: config.model,
    // Newer models think by default and thinking counts toward max_tokens.
    max_tokens: config.effort ? Math.max(config.maxTokens, 1500) : config.maxTokens,
    system: baseSystemBlocks(),
    messages: [{ role: 'user', content: transcriptBlocks(tail) }]
  };
  if (config.effort) payload.output_config = { effort: config.effort };

  try {
    // Not streamed to the page: the repeat checks need the whole reply first.
    const full = await anthropicStream(payload, null);
    aiErrorStreak = 0;

    if (applyOnYou(full)) broadcast({ type: 'onyou', items: state.onYou });

    let tip = stripSalutation(field(full, 'DO'));
    const say = field(full, 'SAY').replace(/^["“]|["”]$/g, '');
    const source = vaultSource(field(full, 'SOURCE'));

    // act-now needs someone to have just addressed the user, and at most one per
    // ACT_NOW_GAP_MS. answer states a fact the user is unsure of, and must rest
    // on a loaded note; without one it is just info.
    let urgency = parseUrgency(full);
    if (urgency === 'answer') {
      if (!source) urgency = 'info';
    } else if (urgency === 'act-now') {
      if (!addressedRecently() || Date.now() - state.lastActNowAt < ACT_NOW_GAP_MS) urgency = 'info';
    } else {
      urgency = 'info';
    }

    // A recap DO is useless coaching, but an answer card is meant to state a fact.
    if (tip && urgency !== 'answer' && isRecap(tip)) {
      console.log('[copilot] Dropped recap DO: ' + tip);
      tip = '';
    }
    if (!tip && !say) {
      broadcast({ type: 'suggestion-none', id: id });
      return true;
    }

    const suggestion = {
      id: id,
      urgency: urgency,
      topic: field(full, 'TOPIC').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
      tip: tip,
      say: say,
      source: source,
      text: [tip, say ? 'Say: "' + say + '"' : ''].filter(Boolean).join(' '),
      at: Date.now(),
      feedback: null
    };

    const why = holdBackReason(suggestion, reason === 'ask');
    if (why) {
      state.heldBack++;
      console.log('[copilot] Held back (' + why + '): ' + suggestion.text);
      broadcast({ type: 'suggestion-held', id: id, heldBack: state.heldBack });
      return true;
    }

    state.suggestions.push(suggestion);
    state.lastShownAt = suggestion.at;
    if (urgency === 'act-now') state.lastActNowAt = suggestion.at;
    broadcast(Object.assign({ type: 'suggestion' }, suggestion));
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

// Pending captions change on nearly every poll, so "anything changed" is not
// a useful trigger. Routine cycles wait for the interval AND enough new speech;
// a chat message or the user's name being said gets a fast lane.
setInterval(function () {
  if (!config.apiKey || aiBusy) return;
  const since = Date.now() - lastAiAt;
  if (state.fastTrigger && since >= FAST_TRIGGER_MIN_MS) {
    runSuggestionCycle('trigger');
    return;
  }
  const intervalMs = state.mode === 'present' ? PRESENT_INTERVAL_MS : config.suggestIntervalMs;
  const minWords = state.mode === 'present' ? PRESENT_MIN_WORDS : config.minNewWords;
  if (since < intervalMs) return;
  if (totalWords() - state.wordsAtLastAi < minWords) return;
  runSuggestionCycle('auto');
}, 1000);

// ─── Transcript Q&A ──────────────────────────────────────────────────────

let queryId = 0;
let directiveId = 0;

// "stop referencing william & mary", "don't address me by name", "focus on budget"
const DIRECTIVE_RE = /^(stop|don'?t|do not|no more|quit|ignore|mute|never|only|focus|less|more|be (more|less))\b/i;
const DIRECTIVE_LEAD_RE = /^(stop (referencing|mentioning|bringing up|talking about|suggesting|flagging)|don'?t (mention|reference|bring up|flag|suggest)|do not (mention|reference|bring up|flag|suggest)|no more|mute|ignore|quit (mentioning|referencing))\s+/i;

function isDirective(text) {
  return DIRECTIVE_RE.test(text) && !/\?\s*$/.test(text);
}

function addDirective(text) {
  const lead = text.match(DIRECTIVE_LEAD_RE);
  // For "stop mentioning X" style directives, X is also filtered server-side.
  const phrase = lead ? normalizePhrase(text.slice(lead[0].length)) : '';
  const d = { id: 'd' + (++directiveId), text: text, phrase: phrase.length >= 3 ? phrase : '', at: Date.now() };
  state.directives.push(d);
  broadcast(Object.assign({ type: 'directive' }, d));
}

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
    max_tokens: config.effort ? 2000 : 500,
    system: baseSystemBlocks(),
    messages: [{ role: 'user', content: transcriptBlocks(tail) }]
  };
  if (config.effort) payload.output_config = { effort: config.effort };

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
  const nameRe = firstName ? new RegExp('\\b' + firstName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i') : null;
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
    state.settledWords += wordCount(entry.msg);
    const fromUser = config.myName && entry.name === config.myName;
    const addressed = !entry.marker && !fromUser && nameRe && (nameRe.test(entry.msg) || /\?\s*$/.test(entry.msg));
    if (addressed) state.lastAddressedAt = Date.now();
    if (!entry.marker && !fromUser && (entry.chat || (nameRe && nameRe.test(entry.msg)))) state.fastTrigger = true;
    // The user voicing uncertainty earns a fast cycle, but only when a note is
    // loaded that could actually answer it.
    if (!entry.marker && fromUser && UNCERTAINTY_RE.test(entry.msg) &&
        vaultList().some(function (v) { return v.status === 'loaded'; })) state.fastTrigger = true;
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
  }
  if (fresh.length) {
    scanForProjects(fresh.filter(function (e) { return !e.marker; }).map(function (e) { return e.msg; }).join('\n'), 'conversation');
    fresh.forEach(function (e) { if (!e.marker && !e.chat) loadPeopleNotes(e.name); });
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
      directives: state.directives,
      mutedTopics: state.mutedTopics,
      heldBack: state.heldBack,
      onYou: state.onYou,
      vault: vaultList(),
      vaultEnabled: vaultProjects.length > 0,
      vaultRoot: config.vaultPath || '',
      feed: feedStatus(),
      lastEntryAt: state.lastEntryAt || null,
      aiEnabled: !!config.apiKey,
      model: config.model,
      myName: config.myName,
      mode: state.mode,
      suggestIntervalMs: config.suggestIntervalMs
    }) + '\n\n');
    sseClients.add(res);
    req.on('close', function () { sseClients.delete(res); });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/brief') {
    return readBody(req).then(function (body) {
      // JSON {text} from the page, or a raw text body (curl --data-binary @brief.md).
      let text;
      try { text = JSON.parse(body).text; } catch (e) { text = body; }
      state.brief = String(text || '').trim();
      scanForProjects(state.brief, 'brief');
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
      if (isDirective(q)) {
        addDirective(q);
        return json(res, 200, { ok: true, directive: true });
      }
      if (!config.apiKey) return json(res, 200, { ok: false, error: 'no api key configured' });
      runQuery(q);
      json(res, 200, { ok: true });
    });
  }

  if (req.method === 'POST' && url.pathname === '/feedback') {
    return readBody(req).then(function (body) {
      let payload;
      try { payload = JSON.parse(body); } catch (e) { return json(res, 400, { ok: false }); }
      const s = state.suggestions.find(function (x) { return x.id === payload.id; });
      if (!s || ['up', 'down', 'mute'].indexOf(payload.verdict) === -1) return json(res, 400, { ok: false });
      if (payload.verdict === 'mute') {
        if (s.topic && state.mutedTopics.indexOf(s.topic) === -1) state.mutedTopics.push(s.topic);
      } else {
        s.feedback = s.feedback === payload.verdict ? null : payload.verdict;
      }
      broadcast({ type: 'feedback', id: s.id, feedback: s.feedback, mutedTopics: state.mutedTopics });
      json(res, 200, { ok: true });
    });
  }

  if (req.method === 'POST' && url.pathname === '/vault') {
    return readBody(req).then(function (body) {
      let payload;
      try { payload = JSON.parse(body); } catch (e) { return json(res, 400, { ok: false }); }
      dismissVaultNote(payload.dismiss);
      json(res, 200, { ok: true });
    });
  }

  if (req.method === 'POST' && url.pathname === '/directive') {
    return readBody(req).then(function (body) {
      let payload;
      try { payload = JSON.parse(body); } catch (e) { return json(res, 400, { ok: false }); }
      state.directives = state.directives.filter(function (d) { return d.id !== payload.remove; });
      broadcast({ type: 'directive-removed', id: payload.remove });
      json(res, 200, { ok: true });
    });
  }

  // Switch between the silent meeting coach and the proactive presentation assistant.
  if (req.method === 'POST' && url.pathname === '/mode') {
    return readBody(req).then(function (body) {
      let payload;
      try { payload = JSON.parse(body); } catch (e) { return json(res, 400, { ok: false }); }
      state.mode = payload.mode === 'present' ? 'present' : 'meeting';
      console.log('[copilot] Mode: ' + state.mode);
      broadcast({ type: 'mode', mode: state.mode });
      json(res, 200, { ok: true, mode: state.mode });
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
  console.log('[copilot] Profile: ' + (profile ? 'loaded from copilot/profile.md' : 'none (optional, see profile.example.md)'));
});
