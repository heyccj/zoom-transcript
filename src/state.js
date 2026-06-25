import { dedupLog } from './dedup.js';
import { getMeetingId, getWebclientWindow } from './meeting.js';
import {
  CAPTION_PANEL_WIDTH, DEFAULT_LOG_HEIGHT, MIN_LOG_HEIGHT, MAX_LOG_HEIGHT,
  MIN_PANEL_WIDTH, MAX_PANEL_WIDTH
} from './constants.js';

export const keys = {
  meetingId: '',
  storageKey: '__ztCaptionLog',
  meetingKey: '__ztCaptionMeetingId',
  sessionKey: '__ztCaptionSession',
  autoDownloadKey: '__ztCaptionAutoDownloaded',
  bookmarksKey: '__ztCaptionBookmarks',
  darkKey: '__ztCaptionDark',
  collapsedKey: '__ztCaptionCollapsed',
  widthKey: '__ztCaptionWidth',
  heightKey: '__ztCaptionHeight'
};

export const app = {
  injectAttempted: false,
  pendingInjectSource: null,
  injectRetries: 0,
  wcWin: null,
  log: [],
  seen: new Set(),
  pauseSkipped: new Set(),
  store: null,
  pollTimer: null,
  settleTimer: null,
  lastSnapshot: '',
  pollCount: 0,
  pendingLines: null,
  openCaptionAttemptAt: 0,
  captionsEnableTimer: null,
  captionsEnabledOnce: false,
  langModalSaveAt: 0,
  renderedLogCount: 0,
  lastRenderedSpeaker: null,
  ui: null,
  attachBoxLogged: false,
  attachDockLogged: false,
  captionDomObserver: null,
  autoDownloadDoc: null,
  autoDownloadWin: null,
  meetingExitClickHandler: null,
  tabCloseBeforeUnloadHandler: null,
  tabClosePageHideHandler: null,
  hostEndedObserver: null,
  hostEndedTimer: null,
  hostEndedTriggered: false,
  speakerColorMap: {},
  speakerColorIdx: 0,
  sessionName: '',
  paused: false,
  darkMode: false,
  collapsed: false,
  activeTab: 'log',
  elapsedStart: null,
  elapsedTimer: null,
  speakerStats: {},
  searchQuery: '',
  bookmarkMode: false,
  bookmarks: [],
  bookmarkByKey: new Map(),
  panelWidth: CAPTION_PANEL_WIDTH,
  logHeight: DEFAULT_LOG_HEIGHT,
  bookmarkDialogCtx: null,
  debugPending: false,
  _pendingDebugPrev: null,
  debugBookmark: false,
  prevSharers: null,
  boxAttachTimer: null,
  lastPanelWatchAt: 0
};

export function initAppState() {
  app.wcWin = getWebclientWindow();
  keys.meetingId = getMeetingId(app.wcWin);

  if (localStorage.getItem(keys.meetingKey) !== keys.meetingId) {
    localStorage.removeItem(keys.storageKey);
    localStorage.removeItem(keys.sessionKey);
    localStorage.removeItem(keys.autoDownloadKey);
    localStorage.removeItem(keys.bookmarksKey);
  }
  localStorage.setItem(keys.meetingKey, keys.meetingId);

  app.log = dedupLog(JSON.parse(localStorage.getItem(keys.storageKey) || '[]'));
  app.seen = new Set(app.log.map(function (l) { return l.key; }));
  app.sessionName = localStorage.getItem(keys.sessionKey) || '';
  app.darkMode = localStorage.getItem(keys.darkKey) === '1';
  app.collapsed = localStorage.getItem(keys.collapsedKey) === '1';

  let w = parseInt(localStorage.getItem(keys.widthKey), 10);
  app.panelWidth = isNaN(w) ? CAPTION_PANEL_WIDTH : Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, w));
  let h = parseInt(localStorage.getItem(keys.heightKey), 10);
  app.logHeight = isNaN(h) ? DEFAULT_LOG_HEIGHT : Math.max(MIN_LOG_HEIGHT, Math.min(MAX_LOG_HEIGHT, h));
}
