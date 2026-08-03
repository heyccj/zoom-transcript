import { app } from './state.js';
export function ensureStyles(doc) {
  if (doc.getElementById('__zt-caption-styles')) return;
  let style = doc.createElement('style');
  style.id = '__zt-caption-styles';
  style.textContent = `
    :root {
      --zt-panel-width: ${app.panelWidth}px;
      --zt-log-height: ${app.logHeight}px;

      --zt-widget-bg:           rgba(255,255,255,0.97);
      --zt-widget-border:       rgba(0,0,0,0.09);
      --zt-text-primary:        #111827;
      --zt-text-secondary:      #6b7280;
      --zt-text-dim:            #9ca3af;
      --zt-text-msg:            #374151;
      --zt-text-marker:         #9ca3af;
      --zt-text-idle:           rgba(0,0,0,0.3);
      --zt-text-idle-strong:    #2563eb;
      --zt-session-color:       #111827;
      --zt-session-placeholder: #9ca3af;
      --zt-tab-inactive:        #9ca3af;
      --zt-tab-active-text:     #111827;
      --zt-tab-active-line:     #2563eb;
      --zt-tab-border:          rgba(0,0,0,0.08);
      --zt-search-bg:           rgba(0,0,0,0.04);
      --zt-search-border:       rgba(0,0,0,0.1);
      --zt-search-text:         #111827;
      --zt-search-placeholder:  #9ca3af;
      --zt-entry-border:        rgba(0,0,0,0.05);
      --zt-btn-bg:              rgba(0,0,0,0.05);
      --zt-btn-border:          rgba(0,0,0,0.1);
      --zt-btn-text:            #374151;
      --zt-btn-hover-bg:        rgba(0,0,0,0.09);
      --zt-btn-pause-text:      #92400e;
      --zt-btn-pause-border:    rgba(146,64,14,0.2);
      --zt-btn-pause-bg:        rgba(146,64,14,0.06);
      --zt-btn-pause-hover:     rgba(146,64,14,0.1);
      --zt-btn-stop-text:       #b91c1c;
      --zt-btn-stop-border:     rgba(185,28,28,0.2);
      --zt-btn-stop-bg:         rgba(185,28,28,0.06);
      --zt-btn-stop-hover:      rgba(185,28,28,0.1);
      --zt-btn-primary-text:    #1d4ed8;
      --zt-btn-primary-border:  rgba(29,78,216,0.2);
      --zt-btn-primary-bg:      rgba(29,78,216,0.06);
      --zt-btn-primary-hover:   rgba(29,78,216,0.1);
      --zt-btn-resume-text:     #15803d;
      --zt-btn-resume-border:   rgba(21,128,61,0.2);
      --zt-btn-resume-bg:       rgba(21,128,61,0.06);
      --zt-icon-btn-bg:         rgba(0,0,0,0.05);
      --zt-icon-btn-border:     rgba(0,0,0,0.1);
      --zt-icon-btn-text:       #6b7280;
      --zt-icon-btn-active-bg:  rgba(37,99,235,0.08);
      --zt-icon-btn-active-border: rgba(37,99,235,0.25);
      --zt-icon-btn-active-text: #1d4ed8;
      --zt-footer-border:       rgba(0,0,0,0.07);
      --zt-scrollbar:           rgba(0,0,0,0.14);
      --zt-dropdown-bg:         #ffffff;
      --zt-dropdown-border:     rgba(0,0,0,0.1);
      --zt-dropdown-hover:      rgba(0,0,0,0.04);
      --zt-dropdown-label:      #9ca3af;
      --zt-dropdown-ext:        #9ca3af;
      --zt-dropdown-shadow:     0 8px 24px rgba(0,0,0,0.14);
      --zt-paused-bg:           rgba(161,98,7,0.06);
      --zt-paused-border:       rgba(161,98,7,0.18);
      --zt-paused-text:         #92400e;
      --zt-collapsed-bg:        rgba(255,255,255,0.97);
      --zt-collapsed-hover:     rgba(248,249,250,0.99);
      --zt-chip-bg:             rgba(0,0,0,0.06);
      --zt-stats-label:         #9ca3af;
      --zt-stats-bar-bg:        rgba(0,0,0,0.07);
      --zt-stat-lines-text:     #9ca3af;
      --zt-stat-name-text:      #374151;
      --zt-mark-bg:             rgba(250,204,21,0.25);
      --zt-mark-text:           #92400e;
    }
    .__zt-dark {
      --zt-widget-bg:           rgba(0,0,0,0.82);
      --zt-widget-border:       rgba(255,255,255,0.08);
      --zt-text-primary:        #e8e8e8;
      --zt-text-secondary:      #9aa3af;
      --zt-text-dim:            #4b5563;
      --zt-text-msg:            #d1d5db;
      --zt-text-marker:         #6b7280;
      --zt-text-idle:           rgba(255,255,255,0.35);
      --zt-text-idle-strong:    #7dd3fc;
      --zt-session-color:       #e8e8e8;
      --zt-session-placeholder: #4b5563;
      --zt-tab-inactive:        #6b7280;
      --zt-tab-active-text:     #e8e8e8;
      --zt-tab-active-line:     #7dd3fc;
      --zt-tab-border:          rgba(255,255,255,0.08);
      --zt-search-bg:           rgba(255,255,255,0.06);
      --zt-search-border:       rgba(255,255,255,0.1);
      --zt-search-text:         #e8e8e8;
      --zt-search-placeholder:  #4b5563;
      --zt-entry-border:        rgba(255,255,255,0.04);
      --zt-btn-bg:              rgba(255,255,255,0.08);
      --zt-btn-border:          rgba(255,255,255,0.1);
      --zt-btn-text:            #d1d5db;
      --zt-btn-hover-bg:        rgba(255,255,255,0.14);
      --zt-btn-pause-text:      #fcd34d;
      --zt-btn-pause-border:    rgba(252,211,77,0.2);
      --zt-btn-pause-bg:        rgba(252,211,77,0.07);
      --zt-btn-pause-hover:     rgba(252,211,77,0.14);
      --zt-btn-stop-text:       #f87171;
      --zt-btn-stop-border:     rgba(248,113,113,0.2);
      --zt-btn-stop-bg:         rgba(248,113,113,0.07);
      --zt-btn-stop-hover:      rgba(248,113,113,0.14);
      --zt-btn-primary-text:    #7dd3fc;
      --zt-btn-primary-border:  rgba(125,211,252,0.2);
      --zt-btn-primary-bg:      rgba(125,211,252,0.07);
      --zt-btn-primary-hover:   rgba(125,211,252,0.14);
      --zt-btn-resume-text:     #4ade80;
      --zt-btn-resume-border:   rgba(74,222,128,0.2);
      --zt-btn-resume-bg:       rgba(74,222,128,0.07);
      --zt-icon-btn-bg:         rgba(255,255,255,0.08);
      --zt-icon-btn-border:     rgba(255,255,255,0.1);
      --zt-icon-btn-text:       #aaa;
      --zt-icon-btn-active-bg:  rgba(99,102,241,0.25);
      --zt-icon-btn-active-border: rgba(99,102,241,0.4);
      --zt-icon-btn-active-text: #a5b4fc;
      --zt-footer-border:       rgba(255,255,255,0.07);
      --zt-scrollbar:           rgba(255,255,255,0.15);
      --zt-dropdown-bg:         #1f2937;
      --zt-dropdown-border:     rgba(255,255,255,0.12);
      --zt-dropdown-hover:      rgba(255,255,255,0.07);
      --zt-dropdown-label:      #6b7280;
      --zt-dropdown-ext:        #6b7280;
      --zt-dropdown-shadow:     0 8px 24px rgba(0,0,0,0.5);
      --zt-paused-bg:           rgba(252,211,77,0.08);
      --zt-paused-border:       rgba(252,211,77,0.18);
      --zt-paused-text:         #fcd34d;
      --zt-collapsed-bg:        rgba(0,0,0,0.82);
      --zt-collapsed-hover:     rgba(0,0,0,0.88);
      --zt-chip-bg:             rgba(255,255,255,0.06);
      --zt-stats-label:         #6b7280;
      --zt-stats-bar-bg:        rgba(255,255,255,0.08);
      --zt-stat-lines-text:     #4b5563;
      --zt-stat-name-text:      #e8e8e8;
      --zt-mark-text:           #fde68a;
    }

    /* ── Mount + structural ── */
    .__zt-caption-mount {
      position: relative;
      display: block;
      width: 100%;
      flex: 0 0 auto;
      align-self: stretch;
      margin-top: 6px;
      pointer-events: auto;
      font-family: system-app.ui, -apple-system, sans-serif;
      box-sizing: border-box;
      background: var(--zt-widget-bg);
      border: 1px solid var(--zt-widget-border);
      border-radius: 10px;
      padding: 8px 10px 10px;
      box-shadow: 0 4px 18px rgba(0,0,0,0.3);
      transition: background 0.2s, border-color 0.2s;
    }
    .__zt-caption-mount *, .__zt-pill * { box-sizing: border-box; }
    .__zt-caption-mount input {
      user-select: text !important;
      -webkit-user-select: text !important;
      pointer-events: auto !important;
    }
    .__zt-resize-handle {
      position: absolute;
      z-index: 1;
    }
    .__zt-resize-handle::after {
      content: '';
      position: absolute;
      border-radius: 2px;
      transition: background 0.15s;
    }
    .__zt-resize-handle:hover::after,
    .__zt-resize-handle.active::after { background: var(--zt-icon-btn-active-border); }
    .__zt-resize-handle--left,
    .__zt-resize-handle--right {
      top: 0;
      bottom: 0;
      width: 16px;
      cursor: ew-resize;
    }
    .__zt-resize-handle--right { right: -8px; }
    .__zt-resize-handle--left { left: -8px; }
    .__zt-resize-handle--left::after,
    .__zt-resize-handle--right::after {
      top: 0;
      bottom: 0;
      left: 6px;
      width: 4px;
    }
    .__zt-resize-handle--top,
    .__zt-resize-handle--bottom {
      left: 0;
      right: 0;
      height: 16px;
      cursor: ns-resize;
    }
    .__zt-resize-handle--bottom { bottom: -8px; }
    .__zt-resize-handle--top { top: -8px; }
    .__zt-resize-handle--top::after,
    .__zt-resize-handle--bottom::after {
      left: 0;
      right: 0;
      top: 6px;
      height: 4px;
    }
    .live-transcription-subtitle__box:has(.__zt-caption-mount) {
      flex-wrap: wrap;
      align-items: stretch;
      width: var(--zt-panel-width) !important;
      min-width: var(--zt-panel-width) !important;
      max-width: var(--zt-panel-width) !important;
      box-sizing: border-box !important;
      display: flex !important;
      visibility: visible !important;
      opacity: 1 !important;
      /* New overlay layout sets a fixed inline height on the box; let our
         panel size it instead so the log isn't clipped. */
      height: auto !important;
      min-height: 0 !important;
      max-height: none !important;
    }
    .live-transcription-subtitle__box:has(.__zt-caption-mount) [id="live-transcription-subtitle"] {
      display: none !important;
    }
    /* New overlay layout: Zoom idle-hides the draggable caption container
       with a --hidden modifier. Keep it (and our panel inside) visible. */
    .live-transcription-subtitle__overlay-container:has(.__zt-caption-mount) {
      visibility: visible !important;
      opacity: 1 !important;
      pointer-events: auto !important;
    }
    .live-transcription-subtitle__overlay-container--hidden:has(.__zt-caption-mount) {
      display: block !important;
    }
    .live-transcription-subtitle__box:has(.__zt-caption-mount) .live-transcription-subtitle__overlay-corner-icons {
      display: none !important;
    }
    .__zt-caption-dock {
      position: fixed;
      left: 50%;
      transform: translateX(-50%);
      bottom: 68px;
      z-index: 2147483646;
      width: var(--zt-panel-width);
      min-width: var(--zt-panel-width);
      max-width: var(--zt-panel-width);
      padding: 0;
      pointer-events: auto;
      box-sizing: border-box;
      background: transparent;
    }

    /* ── Header ── */
    .__zt-header {
      display: flex;
      align-items: center;
      gap: 8px;
      height: 32px;
      margin-bottom: 6px;
    }
    .__zt-dot {
      width: 9px;
      height: 9px;
      border-radius: 50%;
      flex-shrink: 0;
      background: #6b7280;
    }
    .__zt-dot--rec {
      background: #ef4444;
      box-shadow: 0 0 8px rgba(239,68,68,0.7);
      animation: __zt-blink 1s ease-in-out infinite;
    }
    .__zt-dot--idle { background: #22c55e; box-shadow: none; animation: none; }
    .__zt-dot--waiting { background: #f59e0b; box-shadow: none; animation: none; }
    @keyframes __zt-blink { 0%,100%{opacity:1} 50%{opacity:0.2} }
    .__zt-session-name {
      flex: 1;
      color: var(--zt-session-color);
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      border-radius: 4px;
      padding: 3px 4px;
      margin: -3px -4px;
      transition: background 0.15s;
    }
    .__zt-session-name:hover { background: var(--zt-btn-bg); }
    .__zt-session-name--empty { color: var(--zt-session-placeholder); font-weight: 400; font-style: italic; }
    .__zt-meta {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-shrink: 0;
    }
    .__zt-timer {
      color: var(--zt-text-secondary);
      font-size: 11px;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .__zt-btn-icon {
      background: var(--zt-icon-btn-bg);
      border: 1px solid var(--zt-icon-btn-border);
      color: var(--zt-icon-btn-text);
      width: 24px;
      height: 24px;
      border-radius: 5px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      padding: 0;
      transition: background 0.15s, color 0.15s;
      flex-shrink: 0;
      font-family: inherit;
    }
    .__zt-btn-icon:hover { background: var(--zt-btn-hover-bg); color: var(--zt-text-primary); }
    .__zt-btn-icon--active {
      background: var(--zt-icon-btn-active-bg);
      border-color: var(--zt-icon-btn-active-border);
      color: var(--zt-icon-btn-active-text);
    }
    .__zt-btn-icon .__zt-bookmark-icon {
      display: block;
    }
    .__zt-bookmark-mode .__zt-caption-mount,
    .__zt-bookmark-mode .__zt-log-entries {
      cursor: default;
    }
    .__zt-bookmark-mode #__zt-settled .__zt-entry:not(.__zt-entry--marker) {
      cursor: pointer;
    }
    .__zt-bookmark-mode #__zt-settled .__zt-entry:not(.__zt-entry--marker):hover {
      background: var(--zt-btn-hover-bg);
      border-radius: 4px;
    }
    .__zt-entry--bookmarked .__zt-entry-header {
      border-left: 2px solid #f59e0b;
      padding-left: 4px;
      margin-left: -6px;
    }
    .__zt-entry-bookmark {
      border: none;
      background: rgba(245, 158, 11, 0.15);
      color: #f59e0b;
      font-size: 10px;
      font-weight: 600;
      padding: 1px 5px;
      border-radius: 4px;
      cursor: pointer;
      margin-right: 4px;
      flex-shrink: 0;
      font-family: inherit;
      max-width: 140px;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      line-height: 1.3;
    }
    .__zt-entry-bookmark-icon {
      display: inline-flex;
      flex-shrink: 0;
      line-height: 0;
    }
    .__zt-entry-bookmark-label {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
    }
    .__zt-entry-bookmark:hover {
      background: rgba(245, 158, 11, 0.28);
    }
    .__zt-entry--continued .__zt-entry-bookmark {
      display: inline-flex;
      margin-bottom: 2px;
      margin-left: 56px;
    }
    .__zt-entry--continued.__zt-entry--bookmarked .__zt-entry-header {
      display: none;
    }
    .__zt-bookmark-dialog {
      position: absolute;
      inset: 0;
      z-index: 20;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.35);
      border-radius: 8px;
      padding: 12px;
      box-sizing: border-box;
    }
    .__zt-bookmark-dialog-card {
      width: 100%;
      max-width: 280px;
      background: var(--zt-widget-bg);
      border: 1px solid var(--zt-widget-border);
      border-radius: 8px;
      padding: 10px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
    }
    .__zt-bookmark-dialog-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--zt-text-primary);
      margin-bottom: 8px;
    }
    .__zt-bookmark-dialog-card input {
      width: 100%;
      box-sizing: border-box;
      background: var(--zt-search-bg);
      border: 1px solid var(--zt-search-border);
      border-radius: 6px;
      color: var(--zt-search-text);
      font-size: 12px;
      padding: 6px 8px;
      margin-bottom: 8px;
      font-family: inherit;
    }
    .__zt-bookmark-dialog-actions {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 6px;
    }
    .__zt-bookmark-dialog-actions-right {
      display: flex;
      gap: 6px;
      margin-left: auto;
    }

    /* ── Paused banner ── */
    .__zt-paused-banner {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 6px 8px;
      background: var(--zt-paused-bg);
      border: 1px solid var(--zt-paused-border);
      border-radius: 6px;
      margin-bottom: 6px;
      font-size: 12px;
      color: var(--zt-paused-text);
    }
    .__zt-paused-banner .__zt-btn { padding: 3px 8px; font-size: 10px; margin-left: 4px; }

    /* ── Tabs ── */
    .__zt-tabs {
      display: flex;
      gap: 2px;
      margin-bottom: 8px;
      border-bottom: 1px solid var(--zt-tab-border);
    }
    .__zt-tab {
      padding: 5px 12px;
      font-size: 11px;
      font-weight: 600;
      color: var(--zt-tab-inactive);
      cursor: pointer;
      border-bottom: 2px solid transparent;
      margin-bottom: -1px;
      transition: color 0.15s, border-color 0.15s;
      white-space: nowrap;
    }
    .__zt-tab:hover { color: var(--zt-text-secondary); }
    .__zt-tab.active { color: var(--zt-tab-active-text); border-bottom-color: var(--zt-tab-active-line); }

    /* ── Search ── */
    .__zt-search {
      display: none; /* temporarily hidden — restore to flex to bring back search */
      align-items: center;
      gap: 6px;
      background: var(--zt-search-bg);
      border: 1px solid var(--zt-search-border);
      border-radius: 6px;
      padding: 5px 9px;
      margin-bottom: 6px;
      color: var(--zt-search-text);
      transition: background 0.2s;
    }
    .__zt-search svg { opacity: 0.35; flex-shrink: 0; }
    .__zt-search input {
      flex: 1;
      min-width: 0;
      background: transparent;
      border: none;
      outline: none;
      color: var(--zt-search-text);
      font-size: 12px;
      caret-color: var(--zt-tab-active-line);
      font-family: inherit;
      padding: 0;
    }
    .__zt-search input::placeholder { color: var(--zt-search-placeholder); }

    /* ── Log entries ── */
    .__zt-log-entries {
      height: var(--zt-log-height);
      overflow-y: auto;
      overflow-x: hidden;
      padding-right: 2px;
    }
    .__zt-log-entries::-webkit-scrollbar { width: 3px; }
    .__zt-log-entries::-webkit-scrollbar-track { background: transparent; }
    .__zt-log-entries::-webkit-scrollbar-thumb { background: var(--zt-scrollbar); border-radius: 2px; }
    .__zt-log--paused { opacity: 0.45; pointer-events: none; }
    .__zt-entry {
      display: block;
      padding: 1px 0;
      font-size: 12px;
      line-height: 1.45;
    }
    .__zt-entry-header {
      display: flex;
      align-items: baseline;
      gap: 6px;
      margin-bottom: 1px;
    }
    .__zt-entry-time {
      color: var(--zt-text-dim);
      font-size: 10px;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
      flex-shrink: 0;
      min-width: 50px;
    }
    .__zt-entry-name {
      font-size: 11px;
      font-weight: 700;
      white-space: nowrap;
    }
    .__zt-entry-msg {
      display: block;
      color: var(--zt-text-msg);
      word-wrap: break-word;
      padding-left: 56px;
    }
    .__zt-entry-msg mark {
      background: var(--zt-mark-bg);
      color: var(--zt-mark-text);
      border-radius: 2px;
      padding: 0 1px;
    }
    .__zt-entry--marker {
      display: flex;
      align-items: baseline;
      gap: 6px;
    }
    .__zt-entry--marker .__zt-entry-msg {
      color: var(--zt-text-marker);
      font-style: italic;
      font-size: 11px;
      padding-left: 0;
      flex: 1;
      min-width: 0;
    }
    .__zt-entry--chat .__zt-entry-name::after {
      content: ' · chat';
      font-weight: 500;
      color: var(--zt-text-dim);
    }
    .__zt-entry--chat .__zt-entry-msg {
      font-style: italic;
    }
    .__zt-entry--run-head,
    .__zt-entry--marker {
      border-top: 1px solid var(--zt-entry-border);
      margin-top: 4px;
      padding-top: 5px;
    }
    #__zt-settled > .__zt-entry:first-child {
      border-top: none;
      margin-top: 0;
      padding-top: 1px;
    }
    .__zt-entry--continued .__zt-entry-header { display: none; }
    .__zt-entry--show-name .__zt-entry-header { display: flex; }
    /* In-flight lines get a pulsing dot in the left gutter; once a line is
       logged the dot disappears and it renders like every other entry. */
    .__zt-entry--pending .__zt-entry-msg { position: relative; }
    .__zt-entry--pending .__zt-entry-msg::before {
      content: '';
      position: absolute;
      left: 44px;
      top: 0.45em;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #f59e0b;
      animation: __zt-blink 1s ease-in-out infinite;
    }
    /* Just-logged lines run a one-shot pop: the gutter dot turns green,
       swells slightly, and vanishes. */
    .__zt-entry--just-logged .__zt-entry-msg { position: relative; }
    .__zt-entry--just-logged .__zt-entry-msg::before {
      content: '';
      position: absolute;
      left: 44px;
      top: 0.45em;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      animation: __zt-pop 0.55s ease-out forwards;
    }
    @keyframes __zt-pop {
      0%   { background: #f59e0b; transform: scale(1);    opacity: 1; }
      35%  { background: #22c55e; transform: scale(1);    opacity: 1; }
      65%  { background: #22c55e; transform: scale(1.45); opacity: 0.9; }
      100% { background: #22c55e; transform: scale(0.3);  opacity: 0; }
    }
    .__zt-idle {
      color: var(--zt-text-idle);
      font-style: italic;
      font-size: 13px;
      display: flex;
      align-items: center;
      gap: 6px;
      min-height: 36px;
      padding: 8px 0;
    }
    .__zt-idle strong { color: var(--zt-text-idle-strong); margin: 0 4px; font-style: normal; }

    /* ── Stats ── */
    /* Match the app.log panel's user-set height so switching tabs doesn't
       change the widget size. */
    .__zt-tab-panel[data-panel="stats"] {
      height: var(--zt-log-height);
      overflow-y: auto;
      overflow-x: hidden;
    }
    .__zt-tab-panel[data-panel="stats"]::-webkit-scrollbar { width: 3px; }
    .__zt-tab-panel[data-panel="stats"]::-webkit-scrollbar-track { background: transparent; }
    .__zt-tab-panel[data-panel="stats"]::-webkit-scrollbar-thumb { background: var(--zt-scrollbar); border-radius: 2px; }
    .__zt-stats-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
    }
    .__zt-stats-label {
      color: var(--zt-stats-label);
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .__zt-stat-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 5px 0;
      border-bottom: 1px solid var(--zt-entry-border);
    }
    .__zt-stat-row:last-child { border-bottom: none; }
    .__zt-stat-swatch {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .__zt-stat-name {
      font-size: 12px;
      color: var(--zt-stat-name-text);
      flex: 1;
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .__zt-stat-bar-wrap {
      width: 80px;
      height: 4px;
      background: var(--zt-stats-bar-bg);
      border-radius: 2px;
      overflow: hidden;
      flex-shrink: 0;
    }
    .__zt-stat-bar { height: 100%; border-radius: 2px; }
    .__zt-stat-pct {
      color: var(--zt-text-secondary);
      font-size: 11px;
      font-variant-numeric: tabular-nums;
      width: 28px;
      text-align: right;
      flex-shrink: 0;
    }
    .__zt-stat-lines {
      color: var(--zt-stat-lines-text);
      font-size: 10px;
      width: 44px;
      text-align: right;
      flex-shrink: 0;
    }

    /* ── Footer ── */
    .__zt-footer {
      display: flex;
      align-items: center;
      gap: 5px;
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid var(--zt-footer-border);
    }
    .__zt-btn {
      background: var(--zt-btn-bg);
      border: 1px solid var(--zt-btn-border);
      color: var(--zt-btn-text);
      border-radius: 5px;
      padding: 5px 10px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 5px;
      white-space: nowrap;
      transition: background 0.15s, color 0.15s;
      font-family: inherit;
    }
    .__zt-btn:hover { background: var(--zt-btn-hover-bg); }
    .__zt-btn--pause { color: var(--zt-btn-pause-text); border-color: var(--zt-btn-pause-border); background: var(--zt-btn-pause-bg); }
    .__zt-btn--pause:hover { background: var(--zt-btn-pause-hover); }
    .__zt-btn--stop { color: var(--zt-btn-stop-text); border-color: var(--zt-btn-stop-border); background: var(--zt-btn-stop-bg); }
    .__zt-btn--stop:hover { background: var(--zt-btn-stop-hover); }
    .__zt-btn--primary { color: var(--zt-btn-primary-text); border-color: var(--zt-btn-primary-border); background: var(--zt-btn-primary-bg); }
    .__zt-btn--primary:hover { background: var(--zt-btn-primary-hover); }
    .__zt-btn--resume { color: var(--zt-btn-resume-text); border-color: var(--zt-btn-resume-border); background: var(--zt-btn-resume-bg); }
    .__zt-spacer { flex: 1; }

    /* ── Download dropdown ── */
    .__zt-download-wrap { position: relative; }
    .__zt-dropdown {
      position: absolute;
      bottom: calc(100% + 5px);
      right: 0;
      background: var(--zt-dropdown-bg);
      border: 1px solid var(--zt-dropdown-border);
      border-radius: 7px;
      overflow: hidden;
      min-width: 130px;
      box-shadow: var(--zt-dropdown-shadow);
      display: none;
      z-index: 2147483647;
    }
    .__zt-dropdown.open { display: block; }
    .__zt-dropdown-label {
      padding: 7px 12px 4px;
      font-size: 10px;
      font-weight: 600;
      color: var(--zt-dropdown-label);
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .__zt-dropdown-item {
      padding: 7px 12px;
      font-size: 12px;
      color: var(--zt-btn-text);
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 8px;
      white-space: nowrap;
      transition: background 0.12s;
    }
    .__zt-dropdown-item:hover { background: var(--zt-dropdown-hover); }
    .__zt-dropdown-item span { color: var(--zt-dropdown-ext); font-size: 10px; flex: 1; text-align: right; }

    /* ── Collapsed pill ── */
    .__zt-pill {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      flex: 0 0 auto;
      align-self: stretch;
      margin-top: 6px;
      padding: 8px 10px;
      pointer-events: auto;
      font-family: system-app.ui, -apple-system, sans-serif;
      box-sizing: border-box;
      background: var(--zt-collapsed-bg);
      border: 1px solid var(--zt-widget-border);
      border-radius: 10px;
      cursor: pointer;
      box-shadow: 0 4px 18px rgba(0,0,0,0.3);
      transition: background 0.15s;
    }
    .__zt-pill:hover { background: var(--zt-collapsed-hover); }
    .__zt-pill-dot { width: 8px; height: 8px; }
    .__zt-pill-speakers {
      flex: 1;
      display: flex;
      align-items: center;
      gap: 4px;
      min-width: 0;
    }
    .__zt-pill-speaking { font-size: 10px; color: var(--zt-text-secondary); opacity: 0.5; }
    .__zt-pill-meta {
      font-size: 11px;
      color: var(--zt-text-secondary);
      white-space: nowrap;
    }
    .__zt-pill-meta strong { color: var(--zt-text-primary); }
    .__zt-speaker-chip {
      display: flex;
      align-items: center;
      gap: 4px;
      background: var(--zt-chip-bg);
      border-radius: 20px;
      padding: 2px 7px 2px 3px;
      font-size: 10px;
      font-weight: 600;
      color: var(--zt-text-primary);
      min-width: 0;
    }
    .__zt-speaker-chip span {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .__zt-chip-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      flex-shrink: 0;
    }
  `;
  doc.head.appendChild(style);
}
