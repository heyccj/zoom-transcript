import { app, keys } from './state.js';
import { SPEAKER_PALETTE_DARK, SPEAKER_PALETTE_LIGHT } from './constants.js';
import { shieldInputEvents, shieldFromCaptionDrag } from './utils.js';
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
  syncBookmarkMarkers();
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
    let header = row.querySelector('.__zt-entry-header');
    if (header) header.insertBefore(chip, header.firstChild);
    else {
      let msg = row.querySelector('.__zt-entry-msg');
      if (msg) row.insertBefore(chip, msg);
      else row.insertBefore(chip, row.firstChild);
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
    bookmarkBtn.onclick = toggleBookmarkMode;
    shieldFromCaptionDrag(bookmarkBtn);
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
    if (logEntries.dataset.ztBookmarkBound !== '3') {
      logEntries.dataset.ztBookmarkBound = '3';
      logEntries.addEventListener('click', handleLogBookmarksClick, true);
      logEntries.addEventListener('mousedown', handleLogBookmarksPointer, false);
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
  return { entryKey: entryKey, entry: entry };
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
  handleBookmarkPlacementClick(e);
}

export function handleBookmarkPlacementClick(e) {
  if (!app.bookmarkMode) return;
  if (e.target.closest && e.target.closest('.__zt-entry-bookmark')) return;
  let row = e.target.closest && e.target.closest('.__zt-entry');
  if (!row || row.classList.contains('.__zt-entry--marker')) return;
  if (!app.ui || !app.ui.settledEl || !app.ui.settledEl.contains(row)) return;

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
  let doc = app.ui.settledEl.ownerDocument;
  let rows = app.ui.settledEl.querySelectorAll('.__zt-entry');
  for (let i = 0; i < rows.length; i++) {
    let row = rows[i];
    let key = row.getAttribute('data-key');
    let label = key ? app.bookmarkByKey.get(key) : null;
    let bookmarked = !!label;
    row.classList.toggle('__zt-entry--bookmarked', bookmarked);
    if (bookmarked) {
      ensureBookmarkChip(row, key, label, doc);
    } else {
      let chip = row.querySelector('.__zt-entry-bookmark');
      if (chip) chip.remove();
    }
  }
}
