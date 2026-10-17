/* ═══════════════════════════════════════════════════════════
   background.js — Service worker for the Chrome extension.

   v3: Writes directly to Firebase Realtime Database via
   the REST API instead of routing through Apps Script.
   Uses Firebase Anonymous Auth for a per-device token.

   Responsibilities:
   1. Focus tracking (tab activation + window focus)
   2. Session lifecycle (join on content script load, leave on tab close)
   3. Prompt polling (RTDB listener via REST long-poll / periodic GET)
   4. Event dispatch with debouncing (avoids flooding RTDB)
   5. Heartbeat (every 15s → kuwago/heartbeats/{key})
   ═══════════════════════════════════════════════════════════ */

/* ── Configuration ─────────────────────────────────────── */

const RTDB_BASE       = 'https://kuwago-d6c14-default-rtdb.asia-southeast1.firebasedatabase.app';
const FIREBASE_API_KEY = 'AIzaSyAKln9uIm0uPTWloVmQWUK715WkxhfunNY';

const PROMPT_POLL_INTERVAL = 7000;   /* Poll active prompt every ~7 s */
const FOCUS_DEBOUNCE_MS    = 1500;   /* Ignore focus flicks < 1.5 s */
const REQUEST_TIMEOUT_MS   = 15000;  /* REST request timeout */

/* ── State ─────────────────────────────────────────────── */
let _activeMeetTabs    = new Map();  /* tabId → { studentName, sessionId, url } */
let _promptPollTimer   = null;
let _heartbeatInFlight = false;

let _currentPromptPhrase = null;
let _currentPrompt       = null;   /* { id, phrase, issuedAt, expiresAt } */
let _promptAnswered      = false;

const PROMPT_NOTIFICATION_ID = 'kuwago-prompt';
let _focusDebounce = new Map();    /* tabId → { timer, pendingType } */

/* ── Anonymous Auth Token ──────────────────────────────── */

let _authToken     = null;
let _authTokenExp  = 0;     /* ms timestamp when the token expires */

/**
 * Get a Firebase anonymous auth token, refreshing if expired.
 * Tokens last 1 hour; we refresh after 50 min.
 */
async function getAuthToken() {
  if (_authToken && Date.now() < _authTokenExp) return _authToken;

  try {
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ returnSecureToken: true }),
        signal:  AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      }
    );
    const data = await res.json();
    if (!data.idToken) throw new Error('No idToken in response');

    _authToken    = data.idToken;
    _authTokenExp = Date.now() + 50 * 60 * 1000;  /* 50 min */
    console.log('[bg] Anonymous auth token acquired');
    return _authToken;
  } catch (err) {
    console.error('[bg] Anonymous auth failed:', err.message);
    return null;
  }
}

/* ── Shared Key Sanitizer ──────────────────────────────── */

/**
 * Convert a student name to a safe RTDB key.
 * Must match the dashboard's sanitizeName() in firebase.js.
 */
function sanitizeName(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

/* ── RTDB REST Helpers ─────────────────────────────────── */

/**
 * PUT (set/overwrite) a value at an RTDB path.
 * @param {string} path — relative to RTDB_BASE, no leading slash
 * @param {*} data
 */
async function rtdbPut(path, data) {
  const token = await getAuthToken();
  if (!token) return null;

  try {
    const res = await fetch(`${RTDB_BASE}/${path}.json?auth=${token}`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(data),
      signal:  AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    return await res.json();
  } catch (err) {
    console.warn(`[bg] rtdbPut ${path} failed:`, err.message);
    return null;
  }
}

/**
 * PATCH (merge update) at an RTDB path.
 * @param {string} path
 * @param {Object} data — only specified keys are updated
 */
async function rtdbPatch(path, data) {
  const token = await getAuthToken();
  if (!token) return null;

  try {
    const res = await fetch(`${RTDB_BASE}/${path}.json?auth=${token}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(data),
      signal:  AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    return await res.json();
  } catch (err) {
    console.warn(`[bg] rtdbPatch ${path} failed:`, err.message);
    return null;
  }
}

/**
 * POST (push/append) to a list at an RTDB path.
 * Returns the new push key.
 * @param {string} path
 * @param {*} data
 * @returns {string|null} push key
 */
async function rtdbPost(path, data) {
  const token = await getAuthToken();
  if (!token) return null;

  try {
    const res = await fetch(`${RTDB_BASE}/${path}.json?auth=${token}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(data),
      signal:  AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    const result = await res.json();
    return result ? result.name : null;  /* Firebase returns { "name": "-Nabc123" } */
  } catch (err) {
    console.warn(`[bg] rtdbPost ${path} failed:`, err.message);
    return null;
  }
}

/**
 * GET a value from an RTDB path.
 * @param {string} path
 * @returns {*|null}
 */
async function rtdbGet(path) {
  const token = await getAuthToken();
  if (!token) return null;

  try {
    const res = await fetch(`${RTDB_BASE}/${path}.json?auth=${token}`, {
      method: 'GET',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    return await res.json();
  } catch (err) {
    console.warn(`[bg] rtdbGet ${path} failed:`, err.message);
    return null;
  }
}

/* ── Active Session Discovery ──────────────────────────── */

let _activeSessionId  = null;
let _activeSectionId  = null;

/**
 * Fetch and cache the current active session ID from RTDB.
 * Returns null if no session is active.
 */
async function getActiveSessionId() {
  const data = await rtdbGet('kuwago/activeSession');
  if (data && data.active && data.sessionId) {
    _activeSessionId = data.sessionId;
    _activeSectionId = data.sectionId || null;
  } else {
    _activeSessionId = null;
    _activeSectionId = null;
  }
  return _activeSessionId;
}

/* ═══════════════════════════════════════════════════════════
   MESSAGE HANDLING (from content script)
   ═══════════════════════════════════════════════════════════ */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  switch (message.type) {
    case 'MEET_PAGE_LOADED':
      handleMeetPageLoaded(tabId, message.url);
      sendResponse({ ok: true });
      break;

    case 'NAME_DETECTED':
      handleNameDetected(tabId, message.name);
      sendResponse({ ok: true });
      break;

    case 'CHAT_MESSAGE':
      handleChatMessage(message.studentName, message.text);
      sendResponse({ ok: true });
      break;

    case 'VISIBILITY_CHANGE':
      handleVisibilityChange(tabId, message.visible, message.studentName);
      sendResponse({ ok: true });
      break;

    case 'MEET_PAGE_UNLOADING':
      handleMeetPageUnloading(tabId, message.studentName);
      sendResponse({ ok: true });
      break;

    case 'HEARTBEAT':
      /* Service worker keepalive — also re-register the tab
         if state was lost due to worker restart */
      if (tabId && !_activeMeetTabs.has(tabId)) {
        _activeMeetTabs.set(tabId, {
          studentName: message.studentName || null,
          sessionId:   null,
          url:         message.url || ''
        });
        console.log('[bg] Re-registered tab after worker restart:', tabId);
        if (message.studentName) handleNameDetected(tabId, message.studentName);
      }
      /* Send heartbeat to RTDB */
      sendServerHeartbeat(
        message.studentName || _activeMeetTabs.get(tabId)?.studentName
      );
      sendResponse({ ok: true });
      break;

    case 'GET_EXTENSION_STATUS':
      sendResponse({
        activeTabs:    Array.from(_activeMeetTabs.entries()).map(([id, data]) => ({ tabId: id, ...data })),
        rtdbBase:      RTDB_BASE,
        promptPolling: _promptPollTimer !== null,
        currentPrompt: _currentPromptPhrase
      });
      break;
  }

  return true; /* Keep message channel open for async responses */
});

/* ═══════════════════════════════════════════════════════════
   1. SESSION LIFECYCLE
   ═══════════════════════════════════════════════════════════ */

function handleMeetPageLoaded(tabId, url) {
  if (!tabId) return;

  _activeMeetTabs.set(tabId, {
    studentName: null,
    sessionId:   null,
    url,
    joinedAt:    Date.now()
  });

  console.log('[bg] Meet tab registered:', tabId);

  startPromptPolling();

  if (_currentPrompt) sendPromptToTab(tabId);
}

async function handleNameDetected(tabId, name) {
  if (!tabId || !name) return;

  const tabData = _activeMeetTabs.get(tabId);
  if (!tabData) return;

  if (tabData.studentName === name) return;  /* No change */

  tabData.studentName = name;

  /* Discover active session */
  const sessionId = _activeSessionId || await getActiveSessionId();
  if (!sessionId) {
    console.log('[bg] No active session — join event not written for:', name);
    _activeMeetTabs.set(tabId, tabData);
    return;
  }

  const sKey = sanitizeName(name);
  const now  = new Date().toISOString();

  console.log('[bg] Writing join for:', name, '→', sKey);

  /* Determine attendance status based on session start time */
  const sessionData = await rtdbGet('kuwago/activeSession');
  let status = 'Present';
  if (sessionData && sessionData.startedAt) {
    const startMs = new Date(sessionData.startedAt).getTime();
    const joinMs  = Date.now();
    status = (joinMs <= startMs + 10 * 60 * 1000) ? 'Present' : 'Late';
  }

  await rtdbPut(
    `kuwago/classSessions/${sessionId}/attendance/${sKey}`,
    { joinTime: now, leaveTime: null, status, matched: true }
  );

  tabData.sessionId = sessionId;
  _activeMeetTabs.set(tabId, tabData);
}

async function handleMeetPageUnloading(tabId, studentName) {
  const tabData = _activeMeetTabs.get(tabId);
  const name    = studentName || tabData?.studentName;

  if (name) {
    const sessionId = tabData?.sessionId || _activeSessionId;
    if (sessionId) {
      const sKey = sanitizeName(name);
      console.log('[bg] Writing leave for:', name);
      await rtdbPatch(
        `kuwago/classSessions/${sessionId}/attendance/${sKey}`,
        { leaveTime: new Date().toISOString() }
      );
    }
  }

  _activeMeetTabs.delete(tabId);
  _focusDebounce.delete(tabId);

  if (_activeMeetTabs.size === 0) stopPromptPolling();
}

/* ── Tab removal listener ──────────────────────────────── */
chrome.tabs.onRemoved.addListener((tabId) => {
  if (_activeMeetTabs.has(tabId)) handleMeetPageUnloading(tabId, null);
});

/* ── Tab navigation listener (leaving Meet) ────────────── */
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!_activeMeetTabs.has(tabId)) return;
  if (changeInfo.url && !changeInfo.url.startsWith('https://meet.google.com/')) {
    handleMeetPageUnloading(tabId, null);
  }
});

/* ═══════════════════════════════════════════════════════════
   2. FOCUS TRACKING
   ═══════════════════════════════════════════════════════════ */

chrome.tabs.onActivated.addListener((activeInfo) => {
  for (const [tabId, tabData] of _activeMeetTabs) {
    if (tabId === activeInfo.tabId) {
      debouncedFocusEvent(tabId, 'regained', tabData.studentName);
    } else {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError) return;
        if (tab.windowId === activeInfo.windowId) {
          debouncedFocusEvent(tabId, 'lost', tabData.studentName);
        }
      });
    }
  }
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    for (const [tabId, tabData] of _activeMeetTabs) {
      debouncedFocusEvent(tabId, 'lost', tabData.studentName);
    }
  } else {
    for (const [tabId, tabData] of _activeMeetTabs) {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError) return;
        if (tab.windowId === windowId && tab.active) {
          debouncedFocusEvent(tabId, 'regained', tabData.studentName);
        }
      });
    }
  }
});

function handleVisibilityChange(tabId, visible, studentName) {
  if (!tabId || !_activeMeetTabs.has(tabId)) return;
  debouncedFocusEvent(tabId, visible ? 'regained' : 'lost', studentName);
}

function debouncedFocusEvent(tabId, type, studentName) {
  if (!studentName) return;

  const existing = _focusDebounce.get(tabId);

  if (existing) {
    clearTimeout(existing.timer);
    if (existing.pendingType !== type) {
      /* Cancels out — e.g. lost then regained quickly */
      _focusDebounce.delete(tabId);
      return;
    }
  }

  const timer = setTimeout(async () => {
    _focusDebounce.delete(tabId);
    console.log('[bg] Focus event:', type, 'for:', studentName);

    const tabData   = _activeMeetTabs.get(tabId);
    const sessionId = tabData?.sessionId || _activeSessionId;
    if (!sessionId) return;

    const sKey = sanitizeName(studentName);
    await rtdbPost(`kuwago/classSessions/${sessionId}/focusEvents`, {
      student: sKey,
      type,
      at: new Date().toISOString()
    });
  }, FOCUS_DEBOUNCE_MS);

  _focusDebounce.set(tabId, { timer, pendingType: type });
}

/* ═══════════════════════════════════════════════════════════
   3. PROMPT POLLING
   Polls RTDB for the active prompt every ~7 seconds.
   ═══════════════════════════════════════════════════════════ */

function startPromptPolling() {
  if (_promptPollTimer) return;

  /* Refresh session ID first */
  getActiveSessionId();

  async function pollPrompt() {
    /* Refresh session ID each poll cycle */
    const sessionId = _activeSessionId || await getActiveSessionId();
    if (!sessionId) return;

    try {
      const prompts = await rtdbGet(`kuwago/classSessions/${sessionId}/prompts`);
      if (!prompts) { _clearActivePrompt(); return; }

      const now = Date.now();
      let found = null;

      for (const [pid, p] of Object.entries(prompts)) {
        const notExpired = !p.expiresAt || new Date(p.expiresAt).getTime() > now;
        if (p.active && notExpired) { found = { id: pid, ...p }; break; }
      }

      const id = found ? `${found.issuedAt || ''}|${found.phrase}` : null;

      if (id !== (_currentPrompt?.id || null)) {
        _currentPromptPhrase = found ? found.phrase : null;
        _promptAnswered      = false;
        _currentPrompt       = found
          ? { id, phrase: found.phrase, issuedAt: found.issuedAt || null, expiresAt: found.expiresAt || null, _id: found.id }
          : null;

        console.log('[bg] Prompt updated:', _currentPromptPhrase || 'none');

        for (const [tabId] of _activeMeetTabs) sendPromptToTab(tabId);

        if (_currentPrompt) { setPromptBadge(true); notifyPromptIfAway(); }
        else                clearPromptAlerts();
      }
    } catch (err) {
      console.warn('[bg] Prompt poll failed:', err.message);
    }
  }

  pollPrompt();
  _promptPollTimer = setInterval(pollPrompt, PROMPT_POLL_INTERVAL);
}

function stopPromptPolling() {
  if (_promptPollTimer) { clearInterval(_promptPollTimer); _promptPollTimer = null; }
  _clearActivePrompt();
  clearPromptAlerts();
}

function _clearActivePrompt() {
  _currentPromptPhrase = null;
  _currentPrompt       = null;
  _promptAnswered      = false;
}

function sendPromptToTab(tabId) {
  chrome.tabs.sendMessage(tabId, {
    type:      'ACTIVE_PROMPT',
    phrase:    _currentPrompt ? _currentPrompt.phrase    : null,
    issuedAt:  _currentPrompt ? _currentPrompt.issuedAt  : null,
    expiresAt: _currentPrompt ? _currentPrompt.expiresAt : null,
    answered:  _promptAnswered
  }).catch(() => { /* Tab might not be ready */ });
}

/* ── Toolbar badge ─────────────────────────────────────── */

function setPromptBadge(on) {
  try {
    chrome.action.setBadgeText({ text: on ? '!' : '' });
    if (on) chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
  } catch (e) { /* action API unavailable */ }
}

/* ── System notification (when Meet isn't in front) ────── */

async function isMeetInFront() {
  for (const [tabId] of _activeMeetTabs) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!tab.active) continue;
      const win = await chrome.windows.get(tab.windowId);
      if (win.focused) return true;
    } catch (e) { /* tab closed */ }
  }
  return false;
}

async function notifyPromptIfAway() {
  if (!_currentPrompt || _promptAnswered) return;
  if (await isMeetInFront()) return;

  chrome.notifications.create(PROMPT_NOTIFICATION_ID, {
    type:               'basic',
    iconUrl:            'icons/icon128.png',
    title:              'Prompt from your professor',
    message:            `Type "${_currentPrompt.phrase}" in the Meet chat`,
    priority:           2,
    requireInteraction: true
  });
}

function clearPromptAlerts() {
  setPromptBadge(false);
  try { chrome.notifications.clear(PROMPT_NOTIFICATION_ID); } catch (e) { /* ignore */ }
}

chrome.notifications.onClicked.addListener(async (notificationId) => {
  if (notificationId !== PROMPT_NOTIFICATION_ID) return;

  const tabId = _activeMeetTabs.keys().next().value;
  if (tabId !== undefined) {
    try {
      const tab = await chrome.tabs.update(tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
    } catch (e) { /* tab closed */ }
  }
  chrome.notifications.clear(notificationId);
});

/* ═══════════════════════════════════════════════════════════
   4. CHAT MESSAGE HANDLING
   ═══════════════════════════════════════════════════════════ */

async function handleChatMessage(studentName, text) {
  if (!studentName || !text) return;

  console.log('[bg] Submitting chat:', text.substring(0, 30));

  const sessionId = _activeSessionId || await getActiveSessionId();
  if (!sessionId || !_currentPrompt) return;

  /* Normalize and check for match */
  const normalizedText   = text.trim().toLowerCase().replace(/\s+/g, ' ');
  const normalizedPhrase = (_currentPrompt.phrase || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const matched          = normalizedText === normalizedPhrase;

  const sKey = sanitizeName(studentName);

  await rtdbPost(`kuwago/classSessions/${sessionId}/responses`, {
    student:  sKey,
    promptId: _currentPrompt._id || '',
    text,
    matched,
    at:       new Date().toISOString()
  });

  if (matched && !_promptAnswered) {
    _promptAnswered = true;
    clearPromptAlerts();
    for (const [tabId] of _activeMeetTabs) {
      chrome.tabs.sendMessage(tabId, { type: 'PROMPT_ANSWERED' }).catch(() => {});
    }
  }
}

/* ═══════════════════════════════════════════════════════════
   5. HEARTBEAT
   ═══════════════════════════════════════════════════════════ */

/**
 * Write a heartbeat to RTDB for the student.
 * Drives the dashboard's "connected / extension detected" state.
 * The server timestamp ({".sv":"timestamp"}) is set by RTDB.
 */
async function sendServerHeartbeat(studentName) {
  if (!studentName || _heartbeatInFlight) return;
  _heartbeatInFlight = true;

  try {
    const sKey = sanitizeName(studentName);
    await rtdbPut(`kuwago/heartbeats/${sKey}`, {
      detectedName: studentName,
      version:      chrome.runtime.getManifest().version,
      at:           { '.sv': 'timestamp' }  /* Firebase server timestamp */
    });
  } catch (err) {
    console.warn('[bg] Heartbeat failed:', err.message);
  } finally {
    _heartbeatInFlight = false;
  }
}

/* ═══════════════════════════════════════════════════════════
   SERVICE WORKER LIFECYCLE
   ═══════════════════════════════════════════════════════════ */

chrome.runtime.onInstalled.addListener(() => {
  console.log('[bg] Extension installed/updated v' + chrome.runtime.getManifest().version);
});

/* Keep service worker alive while Meet tabs exist */
chrome.runtime.onConnect.addListener(() => { });
