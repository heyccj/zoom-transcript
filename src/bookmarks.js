import { app, keys } from './state.js';
import { SPEAKER_PALETTE_DARK, SPEAKER_PALETTE_LIGHT } from './constants.js';
import { shieldInputEvents, shieldFromCaptionDrag } from './utils.js';

function logBookmark(tag, info) {
  if (!app.debugBookmark) return;
  console.log('[ZT Captions] bookmark ' + tag, info);
}

function warnBookmark(tag, info) {
  console.warn('[ZT Captions] bookmark ' + tag, info);
}

function describeTarget(el) {
  if (!el || !el.tagName) return '(none)';
  let cls = el.className && typeof el.className === 'string' ? el.className : '';
  return el.tagName.toLowerCase() + (cls ? '.' + cls.split(/\s+/).slice(0, 2).join('.') : '');
}

export function getSpeakerColor(name) {
  if (!name) return app.darkMode ? '#9aa3af' : '#6b7280';
  if (app.speakerColorMap[name] == null) {
    app.speakerColorMap[name] = app.speakerColorIdx % SPEAKER_PALETTE_DARK.length;
    app.speakerColorIdx++;
  }
  let palette = app.darkMode ? SPEAKER_PALETTE_DARK : SPEAKER_PALETTE_LIGHT;
  return palette[app.speakerColorMap[name]];
}

export function latestPendingSpeaker() {
  if (!app.pendingLines) return null;
  for (let i = app.pendingLines.length - 1; i >= 0; i--) {
    if (app.pendingLines[i].msg && app.pendingLines[i].name) return app.pendingLines[i].name;
  }
  return null;
}

export function syncSeenFromLog() {
  app.seen = new Set(app.log.map(function (l) { return l.key; }));
  app.pauseSkipped.forEach(function (k) { app.seen.add(k); });
}

export function rebuildSpeakerStats() {
  app.speakerStats = {};
  app.log.forEach(function (e) {
    if (!e.name || e.marker || e.chat) return;
    app.speakerStats[e.name] = (app.speakerStats[e.name] || 0) + 1;
  });
}

export function loadBookmarks() {
  try {
    app.bookmarks = JSON.parse(localStorage.getItem(keys.bookmarksKey) || '[]');
    if (!Array.isArray(app.bookmarks)) app.bookmarks = [];
  } catch (e) {
    app.bookmarks = [];
  }
  rebuildBookmarkByKey();
}

export function persistBookmarks() {
  localStorage.setItem(keys.bookmarksKey, JSON.stringify(app.bookmarks));
}

export function rebuildBookmarkByKey() {
  app.bookmarkByKey = new Map();
  app.bookmarks.forEach(function (b) {
    if (b.entryKey && b.label) app.bookmarkByKey.set(b.entryKey, b.label);
  });
}

export function bookmarkIconHtml(size) {
  size = size || 12;
  return '<svg class="__zt-bookmark-icon" width="' + size + '" height="' + size + '" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<path d="M4 2.5h8v11l-4-3-4 3v-11z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>' +
    '</svg>';
}

export function setBookmarkBtnIcon(btn, size) {
  if (!btn) return;
  btn.innerHTML = bookmarkIconHtml(size || 12);
}

export function findLogEntry(entryKey) {
  for (let i = 0; i < app.log.length; i++) {
    if (app.log[i].key === entryKey) return app.log[i];
  }
  return null;
}

// Log keys change when captions grow (dedupLog recalculates makeKey). Re-attach
// bookmarks to the current entry key so chips can render on the right row.
export function remapBookmarkKeys() {
  let changed = false;
  app.bookmarks.forEach(function (bm) {
    if (!bm.entryKey) return;
    if (findLogEntry(bm.entryKey)) return;
    for (let i = 0; i < app.log.length; i++) {
      let e = app.log[i];
      if (e.marker) continue;
      if (bm.time && e.time && bm.time !== e.time) continue;
      if (bm.speaker && e.name !== bm.speaker) continue;
      if (bm.preview && e.msg && e.msg.indexOf(bm.preview.slice(0, 40)) !== 0 &&
          bm.preview.indexOf(e.msg.slice(0, 40)) !== 0) continue;
      if (!bm.preview && !bm.time) continue;
      bm.entryKey = e.key;
      changed = true;
      return;
    }
  });
  if (changed) {
    rebuildBookmarkByKey();
    persistBookmarks();
    logBookmark('remap keys', { bookmarks: app.bookmarks.map(function (b) { return b.entryKey; }) });
  }
}

export function addBookmark(entryKey, label, entryHint) {
  label = String(label || '').trim();
  if (!label) return false;
  let entry = entryHint || findLogEntry(entryKey);
  if (!entry || entry.marker) return false;

  for (let i = 0; i < app.bookmarks.length; i++) {
    if (app.bookmarks[i].entryKey === entryKey && app.bookmarks[i].label === label) return false;
  }

  app.bookmarks.push({
    id: 'bm-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    label: label,
    entryKey: entryKey,
    time: entry.time || '',
    speaker: entry.name || null,
    preview: entry.msg ? entry.msg.slice(0, 80) : ''
  });
  rebuildBookmarkByKey();
  persistBookmarks();
  remapBookmarkKeys();
  syncBookmarkMarkers();
  logBookmark('added', { entryKey: entryKey, label: label });
  return true;
}

export function renameBookmark(entryKey, label) {
  label = String(label || '').trim();
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

export function removeBookmark(entryKey) {
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

export function setBookmarkMode(on) {
  app.bookmarkMode = !!on;
  if (!app.bookmarkMode) hideBookmarkNameDialog();
  if (!app.ui || !app.ui.mount) return;
  app.ui.mount.classList.toggle('__zt-bookmark-mode', app.bookmarkMode);
  if (app.ui.bookmarkBtn) {
    app.ui.bookmarkBtn.classList.toggle('__zt-btn-icon--active', app.bookmarkMode);
    app.ui.bookmarkBtn.title = app.bookmarkMode
      ? 'Click a name or line to bookmark'
      : 'Add bookmark';
  }
  console.info('[ZT Captions] bookmark mode ' + (app.bookmarkMode ? 'on' : 'off'));
  logBookmark('mode', {
    on: app.bookmarkMode,
    mountClass: app.ui.mount.className,
    dialogOpen: !!(app.ui.bookmarkDialog && app.ui.bookmarkDialog.style.display !== 'none')
  });
}

export function toggleBookmarkMode() {
  setBookmarkMode(!app.bookmarkMode);
}

  app.bookmarkDialogCtx = null;

export function hideBookmarkNameDialog() {
  if (app.ui && app.ui.bookmarkDialog) app.ui.bookmarkDialog.style.display = 'none';
  app.bookmarkDialogCtx = null;
}

export function commitBookmarkNameDialog() {
  if (!app.bookmarkDialogCtx || !app.ui || !app.ui.bookmarkInput) return;
  let label = app.ui.bookmarkInput.value;
  let ctx = app.bookmarkDialogCtx;
  hideBookmarkNameDialog();
  label = String(label || '').trim();
  if (!label) return;
  if (ctx.mode === 'edit') {
    renameBookmark(ctx.entryKey, label);
  } else if (ctx.callback) {
    ctx.callback(label);
  }
}

export function removeBookmarkFromDialog() {
  if (!app.bookmarkDialogCtx || app.bookmarkDialogCtx.mode !== 'edit') return;
  let entryKey = app.bookmarkDialogCtx.entryKey;
  hideBookmarkNameDialog();
  removeBookmark(entryKey);
}

export function openBookmarkDialog(mode, entryKey, entry, defaultLabel, callback) {
  if (!app.ui || !app.ui.mount) {
    if (callback) callback(null);
    return;
  }
  ensureBookmarkDialogChrome(app.ui.mount, app.ui.mount.ownerDocument);
  if (!app.ui.bookmarkDialog || !app.ui.bookmarkInput) {
    let win = app.ui.mount.ownerDocument.defaultView || window;
    let label = win.prompt(
      mode === 'edit' ? 'Rename bookmark:' : 'Name this bookmark:',
      defaultLabel || ''
    );
    if (label === null) return;
    label = String(label).trim();
    if (!label) return;
    if (mode === 'edit') renameBookmark(entryKey, label);
    else if (callback) callback(label);
    return;
  }
  app.bookmarkDialogCtx = {
    mode: mode,
    entryKey: entryKey,
    entry: entry,
    callback: callback
  };
  if (app.ui.bookmarkDialogTitle) {
    app.ui.bookmarkDialogTitle.textContent = mode === 'edit' ? 'Edit bookmark' : 'Name bookmark';
  }
  if (app.ui.bookmarkRemoveBtn) {
    app.ui.bookmarkRemoveBtn.style.display = mode === 'edit' ? '' : 'none';
  }
  app.ui.bookmarkInput.value = defaultLabel || '';
  app.ui.bookmarkDialog.style.display = 'flex';
  app.ui.bookmarkInput.focus();
  app.ui.bookmarkInput.select();
}

export function showBookmarkNameDialog(defaultLabel, entryKey, entry, callback) {
  openBookmarkDialog('add', entryKey, entry, defaultLabel, callback);
}

export function showBookmarkEditDialog(entryKey, entry) {
  openBookmarkDialog('edit', entryKey, entry, app.bookmarkByKey.get(entryKey) || '', null);
}

export function ensureBookmarkDialogChrome(mount, doc) {
  let dialog = mount.querySelector('#__zt-bookmark-dialog');
  if (!dialog) return;
  let title = dialog.querySelector('.__zt-bookmark-dialog-title');
  if (title && !title.id) title.id = '__zt-bookmark-dialog-title';
  let actions = dialog.querySelector('.__zt-bookmark-dialog-actions');
  if (actions && !dialog.querySelector('#__zt-bookmark-remove')) {
    let removeBtn = doc.createElement('button');
    removeBtn.id = '__zt-bookmark-remove';
    removeBtn.type = 'button';
    removeBtn.className = '__zt-btn __zt-btn--stop';
    removeBtn.textContent = 'Remove';
    removeBtn.style.display = 'none';
    let right = doc.createElement('div');
    right.className = '__zt-bookmark-dialog-actions-right';
    while (actions.firstChild) right.appendChild(actions.firstChild);
    actions.appendChild(removeBtn);
    actions.appendChild(right);
    removeBtn.onclick = removeBookmarkFromDialog;
  }
  if (app.ui) {
    app.ui.bookmarkDialogTitle = dialog.querySelector('#__zt-bookmark-dialog-title');
    app.ui.bookmarkRemoveBtn = dialog.querySelector('#__zt-bookmark-remove');
  }
}

export function ensureBookmarkChip(row, key, label, doc) {
  let chip = row.querySelector('.__zt-entry-bookmark');
  if (!chip) {
    chip = doc.createElement('button');
    chip.type = 'button';
    chip.className = '__zt-entry-bookmark';
    chip.title = 'Rename or remove bookmark';
    chip.addEventListener('mousedown', function (ev) { ev.stopPropagation(); });
    chip.addEventListener('pointerdown', function (ev) { ev.stopPropagation(); });
    // Continued rows hide the header — place the chip above the message instead.
    let header = row.querySelector('.__zt-entry-header');
    let msg = row.querySelector('.__zt-entry-msg');
    if (row.classList.contains('__zt-entry--continued') && msg) {
      row.insertBefore(chip, msg);
    } else if (header) {
      header.insertBefore(chip, header.firstChild);
    } else if (msg) {
      row.insertBefore(chip, msg);
    } else {
      row.insertBefore(chip, row.firstChild);
    }
  }
  chip.textContent = '';
  let icon = chip.querySelector('.__zt-entry-bookmark-icon');
  if (!icon) {
    icon = doc.createElement('span');
    icon.className = '__zt-entry-bookmark-icon';
    chip.appendChild(icon);
  }
  icon.innerHTML = bookmarkIconHtml(10);
  let labelEl = chip.querySelector('.__zt-entry-bookmark-label');
  if (!labelEl) {
    labelEl = doc.createElement('span');
    labelEl.className = '__zt-entry-bookmark-label';
    chip.appendChild(labelEl);
  }
  labelEl.textContent = label;
  chip.setAttribute('data-entry-key', key);
}

export function ensureBookmarkWiring(mount, doc) {
  let modeBtn = mount.querySelector('#__zt-mode-btn');
  let bookmarkBtn = mount.querySelector('#__zt-bookmark-btn');
  if (!bookmarkBtn && modeBtn) {
    bookmarkBtn = doc.createElement('button');
    bookmarkBtn.id = '__zt-bookmark-btn';
    bookmarkBtn.className = '__zt-btn-icon';
    bookmarkBtn.type = 'button';
    bookmarkBtn.title = 'Add bookmark';
    setBookmarkBtnIcon(bookmarkBtn, 12);
    modeBtn.parentNode.insertBefore(bookmarkBtn, modeBtn);
  }
  if (bookmarkBtn) {
    bookmarkBtn.onclick = function (ev) {
      logBookmark('btn click', { defaultPrevented: ev.defaultPrevented });
      toggleBookmarkMode();
    };
    shieldFromCaptionDrag(bookmarkBtn);
    if (!bookmarkBtn.dataset.ztBookmarkDebug) {
      bookmarkBtn.dataset.ztBookmarkDebug = '1';
      bookmarkBtn.addEventListener('mousedown', function (ev) {
        logBookmark('btn mousedown', {
          button: ev.button,
          defaultPrevented: ev.defaultPrevented,
          propagationStopped: ev.cancelBubble
        });
      }, false);
    }
    if (!bookmarkBtn.querySelector('.__zt-bookmark-icon')) setBookmarkBtnIcon(bookmarkBtn, 12);
  }

  let dialog = mount.querySelector('#__zt-bookmark-dialog');
  if (!dialog) {
    dialog = doc.createElement('div');
    dialog.id = '__zt-bookmark-dialog';
    dialog.className = '__zt-bookmark-dialog';
    dialog.style.display = 'none';
    dialog.setAttribute('role', 'dialog');
    dialog.innerHTML =
      '<div class="__zt-bookmark-dialog-card">' +
        '<div id="__zt-bookmark-dialog-title" class="__zt-bookmark-dialog-title">Name bookmark</div>' +
        '<input id="__zt-bookmark-input" type="text" spellcheck="false" placeholder="Bookmark label">' +
        '<div class="__zt-bookmark-dialog-actions">' +
          '<button id="__zt-bookmark-remove" type="button" class="__zt-btn __zt-btn--stop" style="display:none">Remove</button>' +
          '<div class="__zt-bookmark-dialog-actions-right">' +
            '<button id="__zt-bookmark-cancel" type="button" class="__zt-btn">Cancel</button>' +
            '<button id="__zt-bookmark-save" type="button" class="__zt-btn __zt-btn--primary">Save</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    mount.appendChild(dialog);
  }
  ensureBookmarkDialogChrome(mount, doc);
  if (dialog && !dialog.dataset.ztDialogBound) {
    dialog.dataset.ztDialogBound = '1';
    let input = dialog.querySelector('#__zt-bookmark-input');
    shieldInputEvents(input);
    dialog.querySelector('#__zt-bookmark-save').onclick = commitBookmarkNameDialog;
    dialog.querySelector('#__zt-bookmark-cancel').onclick = hideBookmarkNameDialog;
    let removeBtn = dialog.querySelector('#__zt-bookmark-remove');
    if (removeBtn) removeBtn.onclick = removeBookmarkFromDialog;
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        commitBookmarkNameDialog();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        hideBookmarkNameDialog();
      }
    });
  }

  let logEntries = mount.querySelector('#__zt-log-entries');
  if (logEntries) {
    if (logEntries.dataset.ztBookmarkBound !== '4') {
      logEntries.dataset.ztBookmarkBound = '4';
      logEntries.addEventListener('click', handleLogBookmarksClick, true);
      logEntries.addEventListener('mousedown', handleLogBookmarksPointer, false);
      logEntries.addEventListener('mouseup', handleLogBookmarksPointerUp, false);
      logEntries.addEventListener('selectstart', handleLogBookmarksSelectStart, false);
    }
  }
}

export function resolveEntryFromRow(row) {
  let entryKey = row.getAttribute('data-key');
  if (!entryKey) return null;
  let idx = parseInt(row.getAttribute('data-log-index'), 10);
  let entry = (!isNaN(idx) && app.log[idx]) ? app.log[idx] : findLogEntry(entryKey);
  if (!entry) {
    let msgEl = row.querySelector('.__zt-entry-msg');
    let timeEl = row.querySelector('.__zt-entry-time');
    entry = {
      key: entryKey,
      time: timeEl ? String(timeEl.textContent).trim() : '',
      name: row.getAttribute('data-name') || null,
      msg: msgEl ? msgEl.textContent : ''
    };
  }
  return { entryKey: entry.key || entryKey, entry: entry };
}

export function handleLogBookmarksClick(e) {
  if (!e.target.closest || !e.target.closest('.__zt-entry-bookmark')) return;
  e.preventDefault();
  e.stopPropagation();
  let chip = e.target.closest('.__zt-entry-bookmark');
  let entryKey = chip.getAttribute('data-entry-key');
  if (!entryKey) return;
  let row = chip.closest('.__zt-entry');
  let resolved = row ? resolveEntryFromRow(row) : { entryKey: entryKey, entry: findLogEntry(entryKey) };
  if (!resolved || !resolved.entry) return;
  showBookmarkEditDialog(resolved.entryKey, resolved.entry);
}

export function handleLogBookmarksPointer(e) {
  if (e.button !== 0 || !app.bookmarkMode) return;
  if (e.target.closest && e.target.closest('.__zt-entry-bookmark')) return;

  let row = e.target.closest && e.target.closest('.__zt-entry');
  let inSettled = !!(row && app.ui && app.ui.settledEl && app.ui.settledEl.contains(row));
  logBookmark('pointer down', {
    target: describeTarget(e.target),
    row: !!row,
    inSettled: inSettled,
    isMarker: !!(row && row.classList.contains('.__zt-entry--marker')),
    isPending: !!(row && app.ui && app.ui.pendingEl && app.ui.pendingEl.contains(row))
  });

  if (!row) {
    if (app.debugBookmark) warnBookmark('ignored', { reason: 'no-entry-row', target: describeTarget(e.target) });
    return;
  }
  if (row.classList.contains('.__zt-entry--marker')) {
    if (app.debugBookmark) warnBookmark('ignored', { reason: 'marker-row', target: describeTarget(e.target) });
    return;
  }
  if (!inSettled) {
    warnBookmark('ignored', { reason: 'not-in-settled-log (pending lines are not bookmarkable)', target: describeTarget(e.target) });
    return;
  }

  handleBookmarkPlacementClick(e);
}

export function handleLogBookmarksPointerUp(e) {
  if (!app.debugBookmark || !app.bookmarkMode || e.button !== 0) return;
  let sel = (e.view || window).getSelection();
  logBookmark('pointer up', {
    target: describeTarget(e.target),
    selectionText: sel ? sel.toString().slice(0, 80) : '',
    selectionCollapsed: sel ? sel.isCollapsed : null
  });
}

export function handleLogBookmarksSelectStart(e) {
  if (!app.debugBookmark || !app.bookmarkMode) return;
  logBookmark('selectstart', { target: describeTarget(e.target) });
}

export function handleBookmarkPlacementClick(e) {
  if (!app.bookmarkMode) return;
  if (e.target.closest && e.target.closest('.__zt-entry-bookmark')) return;
  let row = e.target.closest && e.target.closest('.__zt-entry');
  if (!row || row.classList.contains('.__zt-entry--marker')) return;
  if (!app.ui || !app.ui.settledEl || !app.ui.settledEl.contains(row)) return;

  logBookmark('placement mousedown', {
    target: describeTarget(e.target),
    entryKey: row.getAttribute('data-key'),
    preventDefault: true,
    stopPropagation: true
  });
  warnBookmark('placement — preventDefault blocks text selection on this click', {
    target: describeTarget(e.target),
    entryKey: row.getAttribute('data-key')
  });
  e.preventDefault();
  e.stopPropagation();

  let entryKey = row.getAttribute('data-key');
  if (!entryKey) return;

  let resolved = resolveEntryFromRow(row);
  if (!resolved) return;
  entryKey = resolved.entryKey;
  let entry = resolved.entry;

  if (app.bookmarkByKey.has(entryKey)) {
    showBookmarkEditDialog(entryKey, entry);
    return;
  }

  let defaultLabel = entry.name || (entry.msg ? entry.msg.slice(0, 40) : '');
  showBookmarkNameDialog(defaultLabel, entryKey, entry, function (label) {
    if (label === null) return;
    if (addBookmark(entryKey, label, entry)) setBookmarkMode(false);
  });
}

export function syncBookmarkMarkers() {
  if (!app.ui || !app.ui.settledEl) return;
  remapBookmarkKeys();
  let doc = app.ui.settledEl.ownerDocument;
  let rows = app.ui.settledEl.querySelectorAll('.__zt-entry');
  let matched = new Set();
  for (let i = 0; i < rows.length; i++) {
    let row = rows[i];
    let idx = parseInt(row.getAttribute('data-log-index'), 10);
    let key = row.getAttribute('data-key');
    if (!isNaN(idx) && app.log[idx] && app.log[idx].key) {
      key = app.log[idx].key;
      if (row.getAttribute('data-key') !== key) row.setAttribute('data-key', key);
    }
    let label = key ? app.bookmarkByKey.get(key) : null;
    let bookmarked = !!label;
    if (bookmarked && key) matched.add(key);
    row.classList.toggle('__zt-entry--bookmarked', bookmarked);
    if (bookmarked) {
      ensureBookmarkChip(row, key, label, doc);
    } else {
      let chip = row.querySelector('.__zt-entry-bookmark');
      if (chip) chip.remove();
    }
  }
  app.bookmarkByKey.forEach(function (label, key) {
    if (matched.has(key)) return;
    if (app.debugBookmark) {
      warnBookmark('saved but no log row — key may be stale', { entryKey: key, label: label });
    }
  });
}
