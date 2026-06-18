export function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Zoom's caption box is a react-draggable with global hotkeys on the
// document: without this, mousedown on the search input starts a box drag
// instead of focusing, and keystrokes trigger Zoom shortcuts. Shield ONLY
// the input — shielding the whole widget breaks dragging the box entirely.
export function shieldInputEvents(el) {
  if (!el) return;
  ['mousedown', 'mouseup', 'click', 'dblclick', 'pointerdown', 'pointerup',
    'touchstart', 'keydown', 'keypress', 'keyup'].forEach(function (type) {
    el.addEventListener(type, function (e) { e.stopPropagation(); });
  });
}
