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

function controlLabel(el) {
  if (!el) return '';
  let parts = [
    el.getAttribute('title') || '',
    el.getAttribute('aria-label') || '',
    el.textContent || ''
  ];
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function isHideCaptionsLabel(label) {
  return /hide captions/i.test(label);
}

function isShowCaptionsLabel(label) {
  if (!label || isHideCaptionsLabel(label)) return false;
  if (/more options for captions/i.test(label)) return false;
  if (/caption settings/i.test(label)) return false;
  if (/view full transcript/i.test(label)) return false;
  if (/^show captions$/i.test(label)) return true;
  if (/\bshow captions\b/i.test(label)) return true;
  if (/^request caption/i.test(label)) return true;
  if (/\benable (closed )?captions?\b/i.test(label)) return true;
  if (/\bclosed captions?\b/i.test(label) && !/\bsettings\b/i.test(label)) return true;
  return false;
}

function clickControl(el) {
  if (!el) return false;
  try {
    el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, view: el.ownerDocument.defaultView }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: el.ownerDocument.defaultView }));
    el.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, cancelable: true, view: el.ownerDocument.defaultView }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: el.ownerDocument.defaultView }));
  } catch (e) { /* ignore */ }
  el.click();
  return true;
}

function revealMeetingFooter(doc) {
  let footer = doc.getElementById('wc-footer') || doc.querySelector('.footer.main-footer, footer.footer');
  if (!footer) return;
  footer.classList.remove('footer__hidden');
  try {
    footer.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, view: doc.defaultView }));
  } catch (e) { /* ignore */ }
}

function captionsFooterWrap(doc) {
  return doc.getElementById('captions') ||
    doc.querySelector('[data-feature-type="captions"]');
}

export function findShowCaptionsButton(doc) {
  let wrap = captionsFooterWrap(doc);
  if (wrap) {
    let buttons = wrap.querySelectorAll('button');
    for (let i = 0; i < buttons.length; i++) {
      let label = controlLabel(buttons[i]);
      if (isShowCaptionsLabel(label)) return buttons[i];
    }
    // New Zoom footer: main control may just say "Captions" while off.
    for (let j = 0; j < buttons.length; j++) {
      let label = controlLabel(buttons[j]);
      if (/more options for captions/i.test(label)) continue;
      if (isHideCaptionsLabel(label)) continue;
      if (/\bcaptions\b/i.test(label) || /\blive transcript\b/i.test(label)) {
        return buttons[j];
      }
    }
  }

  let candidates = doc.querySelectorAll(
    'button[title], button[aria-label], a[role="button"], [role="menuitem"], .dropdown-item'
  );
  let i;
  for (i = 0; i < candidates.length; i++) {
    if (isShowCaptionsLabel(controlLabel(candidates[i]))) return candidates[i];
  }
  return null;
}

export function findCaptionsOptionsButton(doc) {
  let wrap = captionsFooterWrap(doc);
  let scope = wrap || doc;
  let candidates = scope.querySelectorAll('button[aria-label], button[title]');
  for (let i = 0; i < candidates.length; i++) {
    let label = controlLabel(candidates[i]);
    if (/more options for captions/i.test(label)) return candidates[i];
  }
  if (wrap) {
    let tip = wrap.querySelector('.new-LT__sub-tip-button button, .footer-sub-toggle-base');
    if (tip) return tip;
  }
  return null;
}

export function findMoreMeetingButton(doc) {
  let candidates = doc.querySelectorAll(
    'button.more-button__dropdown-toggle, button[aria-label], .more-button button'
  );
  for (let i = 0; i < candidates.length; i++) {
    let label = controlLabel(candidates[i]);
    if (/more meeting control/i.test(label)) return candidates[i];
    if (/^more$/i.test((candidates[i].textContent || '').replace(/\s+/g, ' ').trim()) &&
        candidates[i].closest('.more-button')) {
      return candidates[i];
    }
  }
  return null;
}

export function findEnableCaptionsMenuItem(doc) {
  let items = doc.querySelectorAll(
    '.dropdown-menu a, .dropdown-menu button, .dropdown-menu [role="button"], ' +
    '[role="menuitem"], .dropdown-item, a[role="button"]'
  );
  let fallback = null;
  for (let i = 0; i < items.length; i++) {
    let label = controlLabel(items[i]);
    let text = (items[i].textContent || '').replace(/\s+/g, ' ').trim();
    if (isHideCaptionsLabel(label) || isHideCaptionsLabel(text)) continue;
    if (isShowCaptionsLabel(label) || isShowCaptionsLabel(text)) return items[i];
    // More-menu entry that opens the captions control.
    if (/^captions$/i.test(text) || /^live transcript$/i.test(text)) {
      fallback = fallback || items[i];
    }
  }
  return fallback;
}

export function findCaptionLanguageModal(doc) {
  let dialog = doc.querySelector('.new-LT__selector-language-dialog');
  if (dialog) return dialog.closest('.zm-modal') || dialog;
  let modals = doc.querySelectorAll('.lt-select-language, .zm-modal');
  for (let i = 0; i < modals.length; i++) {
    let text = modals[i].textContent || '';
    if (text.indexOf('Set the caption language') >= 0) return modals[i];
    if (/caption language/i.test(text) && /save/i.test(text)) return modals[i];
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

function afterCaptionEnableClick() {
  setTimeout(function () {
    try {
      let d = activeDoc();
      // Menu may open after the first click — pick Show/Enable Captions there.
      let item = findEnableCaptionsMenuItem(d);
      if (item && !captionsVisible(d)) {
        clickControl(item);
        console.info('[ZT Captions] Clicked captions menu item:', controlLabel(item));
      }
      tryDismissCaptionLanguageModal(activeDoc());
    } catch (e) { /* ignore */ }
  }, 400);
}

export function tryShowCaptions(doc, force) {
  if (captionsVisible(doc)) {
    app.captionsEnabledOnce = true;
    return true;
  }
  if (!force && Date.now() - app.openCaptionAttemptAt < 3000) return false;

  revealMeetingFooter(doc);

  // 1. Menu already open (More ⋯ or captions chevron) — click the enable item.
  let menuItem = findEnableCaptionsMenuItem(doc);
  if (menuItem && isShowCaptionsLabel(controlLabel(menuItem))) {
    app.openCaptionAttemptAt = Date.now();
    clickControl(menuItem);
    console.info('[ZT Captions] Clicked captions menu item:', controlLabel(menuItem));
    afterCaptionEnableClick();
    return true;
  }

  // 2. Direct Show Captions / Captions footer toggle.
  let btn = findShowCaptionsButton(doc);
  if (btn) {
    app.openCaptionAttemptAt = Date.now();
    clickControl(btn);
    console.info('[ZT Captions] Clicked Show Captions control:', controlLabel(btn));
    afterCaptionEnableClick();
    return true;
  }

  // 3. Open the captions ▴ submenu, then choose Show/Enable on the next tick.
  let optionsBtn = findCaptionsOptionsButton(doc);
  if (optionsBtn) {
    app.openCaptionAttemptAt = Date.now();
    clickControl(optionsBtn);
    console.info('[ZT Captions] Opened captions options menu.');
    afterCaptionEnableClick();
    return true;
  }

  // 4. Captions buried under the footer More (⋯) control.
  let moreBtn = findMoreMeetingButton(doc);
  if (moreBtn) {
    app.openCaptionAttemptAt = Date.now();
    clickControl(moreBtn);
    console.info('[ZT Captions] Opened More meeting controls for captions.');
    afterCaptionEnableClick();
    return true;
  }

  return false;
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
