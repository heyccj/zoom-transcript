export function getMeetingId(win) {
  try {
    let path = win.location.pathname;
    let match = path.match(/\/wc\/(\d+)/) || path.match(/\/j\/(\d+)/);
    return match ? match[1] : path + win.location.search;
  } catch (e) {
    return 'unknown';
  }
}

export function isMeetingDoc(doc) {
  return !!(
    doc.getElementById('full-transcription') ||
    doc.getElementById('live-transcription-subtitle') ||
    doc.getElementById('zmmtg-root') ||
    doc.getElementById('wc-container') ||
    doc.querySelector('.lt-full-transcript__item')
  );
}

// ─── Webclient / Redux access ───────────────────────────────────────────
export function getWebclientWindow() {
  if (isMeetingDoc(document)) return window;

  let iframe = document.getElementById('webclient');
  if (iframe && iframe.contentWindow) {
    try {
      if (iframe.contentDocument && iframe.contentDocument.body) {
        return iframe.contentWindow;
      }
    } catch (e) { /* cross-origin */ }
  }
  return window;
}

export function isParentShell() {
  return !!document.getElementById('webclient') && !isMeetingDoc(document);
}
