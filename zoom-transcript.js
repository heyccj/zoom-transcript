(function () {
  if (window.__ztLoaded) {
    alert('Zoom Transcript Recorder is already running.');
    return;
  }
  window.__ztLoaded = true;

  // ─── Dedup helpers ───────────────────────────────────────────────────────
  function makeKey(time, msg) {
    return time + '|' + msg.slice(0, 40);
  }

  // Zoom emits progressive updates (partial line → full line) at the same timestamp.
  function isProgressiveUpdate(prev, time, name, msg) {
    if (prev.time !== time || prev.name !== name) return false;
    return msg.indexOf(prev.msg) === 0 || prev.msg.indexOf(msg) === 0;
  }

  function dedupLog(entries) {
    var result = [];
    entries.forEach(function (e) {
      var matchIdx = -1;
      for (var j = result.length - 1; j >= 0; j--) {
        var prev = result[j];
        if (prev.time !== e.time || prev.name !== e.name) continue;
        if (isProgressiveUpdate(prev, e.time, e.name, e.msg)) {
          matchIdx = j;
          break;
        }
      }
      if (matchIdx >= 0) {
        if (e.msg.length >= result[matchIdx].msg.length) {
          result[matchIdx].msg = e.msg;
        }
      } else {
        result.push({ key: e.key, time: e.time, name: e.name, msg: e.msg });
      }
    });
    result.forEach(function (e) { e.key = makeKey(e.time, e.msg); });
    return result;
  }

  function getMeetingId() {
    var match = window.location.pathname.match(/\/wc\/(\d+)/) ||
      window.location.pathname.match(/\/j\/(\d+)/);
    return match ? match[1] : window.location.pathname + window.location.search;
  }

  function resetLog() {
    if (collectTimer) {
      clearTimeout(collectTimer);
      collectTimer = null;
    }
    log = [];
    seen = new Set();
    lastCapturedTime = null;
    localStorage.removeItem('__ztLog');
  }

  // ─── State ───────────────────────────────────────────────────────────────
  var SETTLE_MS = 5000;
  var collectTimer = null;
  var harvesting = false;
  var meetingId = getMeetingId();
  var storedMeetingId = localStorage.getItem('__ztMeetingId');
  if (storedMeetingId && storedMeetingId !== meetingId) {
    localStorage.removeItem('__ztLog');
  }
  localStorage.setItem('__ztMeetingId', meetingId);
  var rawLog = JSON.parse(localStorage.getItem('__ztLog') || '[]');
  var log = dedupLog(rawLog);
  if (log.length !== rawLog.length) {
    localStorage.setItem('__ztLog', JSON.stringify(log));
  }
  var seen = new Set(log.map(function (l) { return l.key; }));
  var observer = null;
  var containerCheckInterval = null;
  var lastContainer = null;
  var lastCapturedTime = null;
  var status = 'Waiting for transcript panel...';

  // ─── UI ──────────────────────────────────────────────────────────────────
  var panel = document.createElement('div');
  panel.id = '__zt-panel';
  panel.style.cssText = [
    'position:fixed',
    'top:12px',
    'left:12px',
    'z-index:2147483647',
    'background:#1a1a2e',
    'color:#e0e0e0',
    'font-family:system-ui,sans-serif',
    'font-size:12px',
    'border-radius:10px',
    'padding:12px 14px',
    'width:220px',
    'box-shadow:0 4px 20px rgba(0,0,0,0.6)',
    'user-select:none',
    'border:1px solid rgba(255,255,255,0.08)'
  ].join(';');

  panel.innerHTML = [
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">',
      '<div style="display:flex;align-items:center;gap:7px;">',
        '<div id="__zt-dot" style="width:9px;height:9px;border-radius:50%;background:#555;flex-shrink:0;transition:background 0.3s;"></div>',
        '<span style="font-weight:700;font-size:13px;color:#fff;">ZT Recorder</span>',
      '</div>',
      '<button id="__zt-close" style="background:none;border:none;color:#888;font-size:16px;cursor:pointer;padding:0;line-height:1;">×</button>',
    '</div>',
    '<div style="margin-bottom:8px;padding:8px;background:rgba(255,255,255,0.05);border-radius:6px;">',
      '<div id="__zt-status" style="color:#aaa;margin-bottom:5px;line-height:1.4;">Initializing...</div>',
      '<div style="display:flex;justify-content:space-between;">',
        '<span style="color:#888;">Lines captured</span>',
        '<span id="__zt-count" style="color:#fff;font-weight:700;">0</span>',
      '</div>',
      '<div style="display:flex;justify-content:space-between;margin-top:3px;">',
        '<span style="color:#888;">Last captured</span>',
        '<span id="__zt-last" style="color:#fff;">—</span>',
      '</div>',
    '</div>',
    '<div style="display:flex;flex-direction:column;gap:6px;">',
      '<button id="__zt-save" style="background:#0a6ebd;color:#fff;border:none;border-radius:6px;padding:7px;font-size:12px;font-weight:700;cursor:pointer;width:100%;">⬇ Download Transcript</button>',
      '<button id="__zt-copy" style="background:#1e6641;color:#fff;border:none;border-radius:6px;padding:7px;font-size:12px;font-weight:700;cursor:pointer;width:100%;">⧉ Copy to Clipboard</button>',
      '<button id="__zt-clear" style="background:rgba(255,255,255,0.06);color:#aaa;border:none;border-radius:6px;padding:6px;font-size:11px;cursor:pointer;width:100%;">✕ Clear &amp; Reset</button>',
    '</div>'
  ].join('');

  document.body.appendChild(panel);

  var dot = document.getElementById('__zt-dot');
  var statusEl = document.getElementById('__zt-status');
  var countEl = document.getElementById('__zt-count');
  var lastEl = document.getElementById('__zt-last');

  function updateUI() {
    countEl.textContent = log.length;
    lastEl.textContent = lastCapturedTime || '—';
    statusEl.textContent = status;
    dot.style.background = observer ? '#22c55e' : (lastContainer ? '#f59e0b' : '#555');
  }

  // ─── Parse & collect ─────────────────────────────────────────────────────
  function readLine(item) {
    var timeEl = item.querySelector('.lt-full-transcript__time');
    var msgEl = item.querySelector('.lt-full-transcript__message');
    if (!timeEl || !msgEl) return null;
    var time = timeEl.innerText.trim();
    var msg = msgEl.innerText.trim();
    if (!msg) return null;
    var nameEl = item.querySelector('.lt-full-transcript__display-name');
    var name = nameEl ? nameEl.innerText.trim() : null;
    return { time: time, name: name, msg: msg };
  }

  function syncSeenFromLog() {
    seen = new Set(log.map(function (l) { return l.key; }));
  }

  function persistLog() {
    var before = log.length;
    log = dedupLog(log);
    syncSeenFromLog();
    if (log.length !== before || log.length > 0) {
      lastCapturedTime = new Date().toLocaleTimeString();
      localStorage.setItem('__ztLog', JSON.stringify(log));
    }
    updateUI();
  }

  function collectImmediate(container) {
    var added = 0;
    container.querySelectorAll('.lt-full-transcript__item').forEach(function (item) {
      var line = readLine(item);
      if (!line) return;
      var key = makeKey(line.time, line.msg);
      if (seen.has(key)) return;
      seen.add(key);
      log.push({
        key: key,
        time: line.time,
        name: line.name,
        msg: line.msg
      });
      added++;
    });
    return added;
  }

  function scheduleCollect(container) {
    if (collectTimer) clearTimeout(collectTimer);
    collectTimer = setTimeout(function () {
      collectTimer = null;
      if (!lastContainer) return;
      collectImmediate(lastContainer);
      persistLog();
    }, SETTLE_MS);
  }

  function flushCollect() {
    if (collectTimer) {
      clearTimeout(collectTimer);
      collectTimer = null;
    }
    if (lastContainer) collectImmediate(lastContainer);
    persistLog();
  }

  // ─── Scroll harvest ──────────────────────────────────────────────────────
  function scrollHarvest(container, done) {
    var inner = container.querySelector('.ReactVirtualized__Grid__innerScrollContainer');
    if (!inner) { if (done) done(); return; }
    harvesting = true;
    var totalHeight = inner.scrollHeight;
    var step = 300;
    var pos = 0;
    container.scrollTop = 0;
    status = 'Scanning transcript...';
    updateUI();
    function tick() {
      collectImmediate(container);
      if (pos >= totalHeight) {
        collectImmediate(container);
        status = 'Waiting for lines to settle...';
        updateUI();
        setTimeout(function () {
          collectImmediate(container);
          persistLog();
          harvesting = false;
          status = 'Recording live...';
          updateUI();
          if (done) done();
        }, SETTLE_MS);
        return;
      }
      pos += step;
      container.scrollTop = pos;
      setTimeout(tick, 120);
    }
    setTimeout(tick, 300);
  }

  // ─── Observer attachment ─────────────────────────────────────────────────
  function attachObserver(container) {
    if (observer) { observer.disconnect(); observer = null; }
    lastContainer = container;
    scrollHarvest(container, function () {
      observer = new MutationObserver(function () {
        if (!harvesting) scheduleCollect(container);
      });
      observer.observe(container, { childList: true, subtree: true });
      status = 'Recording live...';
      updateUI();
    });
  }

  function findContainer() {
    return (
      document.querySelector("[aria-label='Live Transcription List']") ||
      document.querySelector('.lt-virtualized-list') ||
      document.querySelector('#full-transcription .ReactVirtualized__List') ||
      document.querySelector('#wc-container-right .ReactVirtualized__List') ||
      document.querySelector('.ReactVirtualized__List')
    );
  }

  // ─── Watch for container appearing/disappearing (screen share safe) ──────
  containerCheckInterval = setInterval(function () {
    var container = findContainer();
    if (container && container !== lastContainer) {
      // Panel reappeared (e.g. after screen share ended)
      status = 'Panel reattached, scanning...';
      updateUI();
      attachObserver(container);
    } else if (!container && lastContainer) {
      // Panel disappeared (e.g. screen share started)
      if (observer) { observer.disconnect(); observer = null; }
      lastContainer = null;
      status = 'Panel hidden (screen share?)';
      updateUI();
    }
  }, 1500);

  // Initial attach
  var initial = findContainer();
  if (initial) {
    attachObserver(initial);
  } else {
    status = 'Waiting for transcript panel...';
    updateUI();
  }

  // ─── Format output ───────────────────────────────────────────────────────
  function formatOutput() {
    flushCollect();
    var lastSpeaker = null;
    return log.map(function (e) {
      var line = '';
      if (e.name && e.name !== lastSpeaker) {
        line += '\n[' + e.name + ']\n';
        lastSpeaker = e.name;
      }
      line += e.time + '  ' + e.msg;
      return line;
    }).join('\n').trim();
  }

  // ─── Buttons ─────────────────────────────────────────────────────────────
  document.getElementById('__zt-save').onclick = function () {
    var text = formatOutput();
    var defaultName = 'transcript-' + new Date().toISOString().slice(0, 16).replace('T', '-');
    var name = prompt('File name:', defaultName);
    if (name === null) return;
    name = (name.trim() || defaultName).replace(/[\\/:*?"<>|]/g, '-');
    if (!/\.txt$/i.test(name)) name += '.txt';
    var a = document.createElement('a');
    a.href = 'data:text/plain;charset=utf-8,' + encodeURIComponent(text);
    a.download = name;
    a.click();
  };

  document.getElementById('__zt-copy').onclick = function () {
    var text = formatOutput();
    navigator.clipboard.writeText(text).then(function () {
      var btn = document.getElementById('__zt-copy');
      btn.textContent = '✓ Copied!';
      setTimeout(function () { btn.textContent = '⧉ Copy to Clipboard'; }, 2000);
    }).catch(function () {
      console.log(formatOutput());
      alert('Clipboard blocked — output logged to console.');
    });
  };

  document.getElementById('__zt-clear').onclick = function () {
    if (!confirm('Clear all captured transcript data?')) return;
    resetLog();
    status = observer ? 'Recording live...' : 'Waiting for transcript panel...';
    updateUI();
  };

  document.getElementById('__zt-close').onclick = function () {
    if (observer) observer.disconnect();
    clearInterval(containerCheckInterval);
    window.__ztLoaded = false;
    document.body.removeChild(panel);
  };

  // ─── Auto-download if host ends meeting ──────────────────────────────────
  var endObserver = new MutationObserver(function () {
    var modal = document.querySelector('.zm-modal-body-title');
    if (modal && modal.innerText.indexOf('ended by host') !== -1) {
      var text = formatOutput();
      var a = document.createElement('a');
      a.href = 'data:text/plain;charset=utf-8,' + encodeURIComponent(text);
      a.download = 'transcript-' + new Date().toISOString().slice(0, 16).replace('T', '-') + '.txt';
      a.click();
      resetLog();
      localStorage.removeItem('__ztMeetingId');
    }
  });
  endObserver.observe(document.body, { childList: true, subtree: true });

  updateUI();
})();
