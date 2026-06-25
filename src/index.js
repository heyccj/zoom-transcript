import { POLL_MS } from './constants.js';
import { app, initAppState } from './state.js';
import { getWebclientWindow, isParentShell } from './meeting.js';
import { findReduxStore, probeState } from './redux.js';
import { findCaptionBox } from './caption-panel.js';
import { tryInjectIntoIframe } from './inject.js';
import { pollStore } from './ingest.js';
import { activeDoc, startCaptionsAutoEnable } from './caption-panel.js';
import { updateUI } from './controls.js';
import { loadBookmarks } from './bookmarks.js';

function iframeRecorderRunning() {
  try {
    let iframe = document.getElementById('webclient');
    return !!(iframe && iframe.contentWindow && iframe.contentWindow.__ztCaptionLoaded);
  } catch (e) {
    return false;
  }
}

function boot() {
  if (window.__ztCaptionLoaded) {
    if (!iframeRecorderRunning()) {
      window.__ztCaptionLoaded = false;
      delete window.__ztCaption;
    } else {
      console.warn('[ZT Captions] Already running in this frame.');
      return window.__ztCaption;
    }
  }
  window.__ztCaptionLoaded = true;

  initAppState();
  loadBookmarks();

  window.__ztCaption = {
    getLog: function () { return app.log.slice(); },
    probe: function () {
      app.wcWin = getWebclientWindow();
      let found = findReduxStore(app.wcWin.document);
      let info = {
        frame: window === app.wcWin ? 'webclient' : 'parent-shell',
        wcUrl: app.wcWin.location.href,
        storeFound: !!found,
        storeActive: !!app.store,
        lineCount: app.log.length,
        captionBoxFound: !!findCaptionBox(app.wcWin.document),
        captionPanelAttached: !!(function () {
          let m = app.wcWin.document.getElementById('__zt-caption-mount');
          return m && m.isConnected;
        })(),
        captionDockVisible: !!(function () {
          let d = app.wcWin.document.getElementById('__zt-caption-dock');
          return d && d.style.display !== 'none';
        })()
      };
      if (found) {
        try {
          info.state = probeState(found.getState());
        } catch (e) {
          info.stateError = String(e);
        }
      }
      console.log('[ZT Captions] probe', info);
      return info;
    },
    findStore: function () {
      app.wcWin = getWebclientWindow();
      return findReduxStore(app.wcWin.document);
    },
    debugPending: function (on) {
      app.debugPending = on !== false;
      app._pendingDebugPrev = null;
      console.info('[ZT Captions] pending debug ' + (app.debugPending ? 'on' : 'off'));
      return app.debugPending;
    },
    debugBookmark: function (on) {
      app.debugBookmark = on !== false;
      console.info('[ZT Captions] bookmark debug ' + (app.debugBookmark ? 'on' : 'off'));
      return app.debugBookmark;
    }
  };

  if (isParentShell() && document.currentScript) {
    let bootScript = document.currentScript;
    if (bootScript.src) {
      fetch(bootScript.src).then(function (r) { return r.text(); }).then(function (src) {
        tryInjectIntoIframe(src);
      }).catch(function (e) {
        console.warn('[ZT Captions] Could not fetch script for iframe inject:', e);
      });
    } else if (bootScript.textContent) {
      tryInjectIntoIframe(bootScript.textContent);
    }
  }

  if (isParentShell()) {
    let bootScript = document.currentScript;
    let injectRetry = setInterval(function () {
      let win = getWebclientWindow();
      if (win.__ztCaptionLoaded) {
        clearInterval(injectRetry);
        return;
      }
      if (app.pendingInjectSource) tryInjectIntoIframe(app.pendingInjectSource);
      else if (bootScript && bootScript.textContent) tryInjectIntoIframe(bootScript.textContent);
    }, 500);
    setTimeout(function () { clearInterval(injectRetry); }, 60000);

    window.__ztCaption = {
      getLog: function () {
        let cap = getWebclientWindow().__ztCaption;
        return cap ? cap.getLog() : [];
      },
      probe: function () {
        let cap = getWebclientWindow().__ztCaption;
        return cap ? cap.probe() : { error: 'iframe recorder not loaded yet' };
      },
      findStore: function () {
        return findReduxStore(getWebclientWindow().document);
      },
      debugPending: function (on) {
        let cap = getWebclientWindow().__ztCaption;
        return cap ? cap.debugPending(on) : false;
      },
      debugBookmark: function (on) {
        let cap = getWebclientWindow().__ztCaption;
        return cap ? cap.debugBookmark(on) : false;
      }
    };

    console.info('[ZT Captions] Parent shell bootstrap — recorder runs in #webclient iframe.');
    return window.__ztCaption;
  }

  app.pollTimer = setInterval(pollStore, POLL_MS);
  pollStore();
  try {
    startCaptionsAutoEnable(activeDoc());
  } catch (e) { /* iframe not ready yet */ }
  updateUI();

  console.info('[ZT Captions] Ready. Debug: __ztCaption.probe(), __ztCaption.debugBookmark(true)');
  return window.__ztCaption;
}

boot();
