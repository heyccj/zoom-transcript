import { app } from './state.js';
import { updateUI } from './controls.js';
export function tryInjectIntoIframe(source) {
  if (app.injectAttempted || !source) return false;
  let iframe = document.getElementById('webclient');
  if (!iframe || !iframe.contentWindow || !iframe.contentDocument) {
    // Iframe not ready yet — keep the source so pollStore can retry.
    app.pendingInjectSource = source;
    return false;
  }

  app.pendingInjectSource = null;
  try {
    if (iframe.contentWindow.__ztCaptionLoaded) return true;
    app.injectAttempted = true;
    let script = iframe.contentDocument.createElement('script');
    script.textContent = source;
    iframe.contentDocument.head.appendChild(script);
    updateUI();
    console.info('[ZT Captions] Injected into #webclient iframe.');
    return true;
  } catch (e) {
    console.warn('[ZT Captions] Could not inject into iframe:', e);
    return false;
  }
}
