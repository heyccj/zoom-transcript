import { app } from './state.js';
import { MIN_PANEL_WIDTH, MAX_PANEL_WIDTH, MIN_LOG_HEIGHT, MAX_LOG_HEIGHT } from './constants.js';
import { getWebclientWindow } from './meeting.js';
export function activeDoc() {
  app.wcWin = getWebclientWindow();
  return app.wcWin.document;
}

export function findCaptionBox(doc) {
  let sub = doc.getElementById('live-transcription-subtitle');
  if (sub && sub.closest) {
    let inBox = sub.closest('.live-transcription-subtitle__box');
    if (inBox) return inBox;
  }
  return doc.querySelector('.live-transcription-subtitle__box');
}

export function findCaptionHost(doc) {
  return findCaptionBox(doc) ||
    doc.querySelector('.live-transcription-subtitle__overlay-container') ||
    doc.querySelector('.lt-subtitle-wrap');
}

export function captionsVisible(doc) {
  let sub = doc.getElementById('live-transcription-subtitle');
  if (!sub) return false;
  // New overlay layout (2026): the subtitle node only exists while captions
  // are enabled, but Zoom idle-hides it (display:none on the subtitle plus a
  // --hidden modifier on the overlay container). Presence inside the overlay
  // container means captions are on — don't keep clicking Show Captions.
  if (sub.closest('.live-transcription-subtitle__overlay-container')) return true;
  if (sub.style.display === 'none') return false;
  let box = sub.closest('.live-transcription-subtitle__box');
  if (box && box.style.display === 'none') return false;
  return true;
}

export function lockPanelWidth(el) {
  if (!el) return;
  el.style.setProperty('width', app.panelWidth + 'px', 'important');
  el.style.setProperty('min-width', app.panelWidth + 'px', 'important');
  el.style.setProperty('max-width', app.panelWidth + 'px', 'important');
  el.style.setProperty('box-sizing', 'border-box', 'important');
}

export function applyPanelWidth(doc) {
  doc.documentElement.style.setProperty('--zt-panel-width', app.panelWidth + 'px');
  let box = findCaptionBox(doc);
  if (box) {
    lockPanelWidth(box);
    let wrap = box.closest('.lt-subtitle-wrap');
    if (wrap) lockPanelWidth(wrap);
  }
  let dock = doc.getElementById('__zt-caption-dock');
  if (dock) lockPanelWidth(dock);
}

export function applyLogHeight(doc) {
  doc.documentElement.style.setProperty('--zt-log-height', app.logHeight + 'px');
}

export function findShowCaptionsButton(doc) {
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

export function findCaptionLanguageModal(doc) {
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

export function selectEnglishInLanguageModal(doc, modal) {
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

export function tryDismissCaptionLanguageModal(doc) {
  let modal = findCaptionLanguageModal(doc);
  if (!modal) return false;
  if (Date.now() - app.langModalSaveAt < 1500) return true;

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

  app.langModalSaveAt = Date.now();
  saveBtn.click();
  console.info('[ZT Captions] Caption language modal — English + Save.');
  return true;
}

export function tryShowCaptions(doc, force) {
  if (captionsVisible(doc)) {
    app.captionsEnabledOnce = true;
    return true;
  }
  if (!force && Date.now() - app.openCaptionAttemptAt < 3000) return false;

  let btn = findShowCaptionsButton(doc);
  if (!btn) return false;

  app.openCaptionAttemptAt = Date.now();
  btn.click();
  console.info('[ZT Captions] Clicked Show Captions.');
  setTimeout(function () {
    try {
      tryDismissCaptionLanguageModal(activeDoc());
    } catch (e) { /* ignore */ }
  }, 400);
  return true;
}

export function startCaptionsAutoEnable(doc) {
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
      console.warn('[ZT Captions] Could not auto-enable captions — click Show Captions manually.');
    }
  }

  tryShowCaptions(doc, true);
  tick();
  app.captionsEnableTimer = setInterval(tick, 3000);
}
