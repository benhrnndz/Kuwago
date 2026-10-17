/* ═══════════════════════════════════════════════════════════
   background.js — Service worker for the Chrome extension.

   Responsibilities:
   1. Focus tracking (tab activation + window focus)
   2. Session lifecycle (join on content script load, leave on tab close)
   3. Prompt polling (every ~5–10 seconds while on active Meet)
   4. Event dispatch with debouncing (avoids flooding the Sheet)
   ═══════════════════════════════════════════════════════════ */

/* ── Configuration ─────────────────────────────────────── */

/**
 * IMPORTANT: Replace this with your deployed Apps Script web app URL.
 * The URL looks like: https://script.google.com/macros/s/DEPLOY_ID/exec
 */
const API_BASE = 'https://script.google.com/macros/s/AKfycbwFicAeiL0R-2Uke92ewDm-aduaoRpcFG8aO1Z7Ri7VVCAIWCT7tLMTzFIGSA9hvaTXww/exec';

const PROMPT_POLL_INTERVAL = 7000;  /* Poll for active prompt every ~7 seconds */
const FOCUS_DEBOUNCE_MS = 1500;     /* Ignore focus changes shorter than 1.5s */
const REQUEST_TIMEOUT_MS = 20000;   /* API request timeout (Apps Script can be slow on cold start) */

/* ── State ─────────────────────────────────────────────── */
let _activeMeetTabs = new Map();    /* tabId → { studentName, sessionId, url } */
let _promptPollTimer = null;
let _heartbeatInFlight = false;

/**
 * Report to the server that this extension is alive.
 * Called on every content-script keepalive (~15s). The dashboard marks a
 * joined student "disconnected" if no heartbeat arrives for ~60s.
 * @param {string|null} studentName - Detected Meet display name
 */
async function sendServerHeartbeat(studentName) {
  if (!studentName || _heartbeatInFlight) return;
  _heartbeatInFlight = true;
  try {
    await apiPost('heartbeat', {
      studentName,
      version: chrome.runtime.getManifest().version
    });
  } catch (err) {
    console.warn('[cam-bg] heartbeat failed:', err.message);
  } finally {
    _heartbeatInFlight = false;
  }
}
let _currentPromptPhrase = null;
let _currentPrompt = null;          /* { id, phrase, issuedAt, expiresAt } */
let _promptAnswered = false;        /* Student's reply matched the current prompt */

const PROMPT_NOTIFICATION_ID = 'kuwago-prompt';

/* Focus debounce state per tab */
let _focusDebounce = new Map();     /* tabId → { timer, pendingType } */

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
          sessionId: null,
          url: message.url || ''
        });
        console.log('[bg] Re-registered tab after worker restart:', tabId);
        /* Re-trigger join if we have a name */
        if (message.studentName) {
          handleNameDetected(tabId, message.studentName);
        }
      }
      /* Tell the server this extension is alive (drives the
         dashboard's "connected" / "extension detected" state) */
      sendServerHeartbeat(message.studentName || _activeMeetTabs.get(tabId)?.studentName);
      sendResponse({ ok: true });
      break;

    case 'GET_EXTENSION_STATUS':
      sendResponse({
        activeTabs: Array.from(_activeMeetTabs.entries()).map(([id, data]) => ({
          tabId: id,
          ...data
        })),
        apiBase: API_BASE,
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

/**
 * Content script loaded on a Meet page — register this tab.
 */
function handleMeetPageLoaded(tabId, url) {
  if (!tabId) return;

  _activeMeetTabs.set(tabId, {
    studentName: null,
    sessionId: null,
    url: url,
    joinedAt: Date.now()
  });

  console.log('[cam-bg] Meet tab registered:', tabId);

  /* Start prompt polling if not already running */
  startPromptPolling();

  /* A prompt may already be live when this tab opens/reloads */
  if (_currentPrompt) {
    sendPromptToTab(tabId);
  }
}

/**
 * Student name detected by content script — fire join event.
 */
async function handleNameDetected(tabId, name) {
  if (!tabId || !name) return;

  const tabData = _activeMeetTabs.get(tabId);
  if (!tabData) return;

  /* If we already have a name and it hasn't changed, skip */
  if (tabData.studentName === name) return;

  tabData.studentName = name;

  /* Fire the join event */
  console.log('[cam-bg] Firing join event for:', name);
  const result = await apiPost('logEvent', {
    studentName: name,
    type: 'join'
  });

  if (result && result.sessionId) {
    tabData.sessionId = result.sessionId;
  }

  _activeMeetTabs.set(tabId, tabData);
}

/**
 * Meet page unloading — fire leave event.
 */
async function handleMeetPageUnloading(tabId, studentName) {
  const tabData = _activeMeetTabs.get(tabId);
  const name = studentName || tabData?.studentName;

  if (name) {
    console.log('[cam-bg] Firing leave event for:', name);
    await apiPost('logEvent', {
      studentName: name,
      type: 'leave'
    });
  }

  _activeMeetTabs.delete(tabId);
  _focusDebounce.delete(tabId);

  /* Stop prompt polling if no more Meet tabs */
  if (_activeMeetTabs.size === 0) {
    stopPromptPolling();
  }
}

/* ── Tab removal listener ──────────────────────────────── */
chrome.tabs.onRemoved.addListener((tabId) => {
  if (_activeMeetTabs.has(tabId)) {
    handleMeetPageUnloading(tabId, null);
  }
});

/* ── Tab navigation listener (leaving Meet) ────────────── */
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!_activeMeetTabs.has(tabId)) return;

  if (changeInfo.url && !changeInfo.url.startsWith('https://meet.google.com/')) {
    /* Navigated away from Meet */
    handleMeetPageUnloading(tabId, null);
  }
});

/* ═══════════════════════════════════════════════════════════
   2. FOCUS TRACKING
   Combines tab activation + window focus + visibility signals.
   Debounces rapid focus toggling.
   ═══════════════════════════════════════════════════════════ */

/**
 * Tab activation change — another tab was selected.
 */
chrome.tabs.onActivated.addListener((activeInfo) => {
  /* Mark all Meet tabs in this window as unfocused except the active one */
  for (const [tabId, tabData] of _activeMeetTabs) {
    if (tabId === activeInfo.tabId) {
      debouncedFocusEvent(tabId, 'focus_regained', tabData.studentName);
    } else {
      /* Check if this tab is in the same window */
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError) return;
        if (tab.windowId === activeInfo.windowId) {
          debouncedFocusEvent(tabId, 'focus_lost', tabData.studentName);
        }
      });
    }
  }
});

/**
 * Window focus change — the browser window lost/gained focus.
 */
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    /* All chrome windows lost focus (user switched to another app) */
    for (const [tabId, tabData] of _activeMeetTabs) {
      debouncedFocusEvent(tabId, 'focus_lost', tabData.studentName);
    }
  } else {
    /* A Chrome window gained focus — check if it has a Meet tab */
    for (const [tabId, tabData] of _activeMeetTabs) {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError) return;
        if (tab.windowId === windowId && tab.active) {
          debouncedFocusEvent(tabId, 'focus_regained', tabData.studentName);
        }
      });
    }
  }
});

/**
 * Visibility change from the content script.
 * Secondary signal to complement tab-level tracking.
 */
function handleVisibilityChange(tabId, visible, studentName) {
  if (!tabId || !_activeMeetTabs.has(tabId)) return;

  const type = visible ? 'focus_regained' : 'focus_lost';
  debouncedFocusEvent(tabId, type, studentName);
}

/**
 * Debounce focus events to avoid flooding the Sheet.
 * Sub-second tab flicks are ignored.
 */
function debouncedFocusEvent(tabId, type, studentName) {
  if (!studentName) return;

  const existing = _focusDebounce.get(tabId);

  if (existing) {
    clearTimeout(existing.timer);

    /* If the new event cancels the pending one (e.g., lost→regained
       within the debounce window), just cancel both. */
    if (existing.pendingType !== type) {
      _focusDebounce.delete(tabId);
      return;
    }
  }

  const timer = setTimeout(async () => {
    _focusDebounce.delete(tabId);
    console.log('[cam-bg] Focus event:', type, 'for:', studentName);

    await apiPost('logEvent', {
      studentName: studentName,
      type: type
    });
  }, FOCUS_DEBOUNCE_MS);

  _focusDebounce.set(tabId, { timer, pendingType: type });
}

/* ═══════════════════════════════════════════════════════════
   3. PROMPT POLLING
   Polls the server for the active prompt every ~7 seconds.
   ═══════════════════════════════════════════════════════════ */

function startPromptPolling() {
  if (_promptPollTimer) return; /* Already polling */

  async function pollPrompt() {
    try {
      const result = await apiGet('currentPrompt');
      if (!result) return;

      const active = result.activePrompt || null;
      const phrase = active?.phrase || null;
      /* Same phrase can be re-issued, so identity includes the issue time */
      const id = active ? `${active.issuedAt || ''}|${phrase}` : null;

      if (id !== (_currentPrompt?.id || null)) {
        _currentPromptPhrase = phrase;
        _promptAnswered = false;
        _currentPrompt = active
          ? { id, phrase, issuedAt: active.issuedAt || null, expiresAt: active.expiresAt || null }
          : null;
        console.log('[cam-bg] Active prompt updated:', phrase || 'none');

        /* Notify all content scripts about the new prompt */
        for (const [tabId] of _activeMeetTabs) {
          sendPromptToTab(tabId);
        }

        if (_currentPrompt) {
          setPromptBadge(true);
          notifyPromptIfAway();
        } else {
          clearPromptAlerts();
        }
      }
    } catch (err) {
      console.warn('[cam-bg] Prompt poll failed:', err.message);
    }
  }

  /* Immediate poll */
  pollPrompt();

  /* Start interval */
  _promptPollTimer = setInterval(pollPrompt, PROMPT_POLL_INTERVAL);
}

function stopPromptPolling() {
  if (_promptPollTimer) {
    clearInterval(_promptPollTimer);
    _promptPollTimer = null;
  }
  _currentPromptPhrase = null;
  _currentPrompt = null;
  _promptAnswered = false;
  clearPromptAlerts();
}

/* ── Prompt delivery to the page ───────────────────────── */

/**
 * Send the current prompt (or its absence) to one Meet tab's overlay.
 */
function sendPromptToTab(tabId) {
  chrome.tabs.sendMessage(tabId, {
    type: 'ACTIVE_PROMPT',
    phrase: _currentPrompt ? _currentPrompt.phrase : null,
    issuedAt: _currentPrompt ? _currentPrompt.issuedAt : null,
    expiresAt: _currentPrompt ? _currentPrompt.expiresAt : null,
    answered: _promptAnswered
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

/**
 * True if any tracked Meet tab is the active tab of the focused window.
 */
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
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'Prompt from your professor',
    message: `Type "${_currentPrompt.phrase}" in the Meet chat`,
    priority: 2,
    requireInteraction: true
  });
}

function clearPromptAlerts() {
  setPromptBadge(false);
  try { chrome.notifications.clear(PROMPT_NOTIFICATION_ID); } catch (e) { /* ignore */ }
}

/* Clicking the toast brings the student back to Meet */
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

  console.log('[cam-bg] Submitting chat:', text.substring(0, 30));

  const result = await apiPost('submitChat', {
    studentName: studentName,
    text: text
  });

  /* Reply matched the live prompt — confirm on the page and quiet the alerts */
  if (result && result.matched && _currentPrompt && !_promptAnswered) {
    _promptAnswered = true;
    clearPromptAlerts();
    for (const [tabId] of _activeMeetTabs) {
      chrome.tabs.sendMessage(tabId, { type: 'PROMPT_ANSWERED' })
        .catch(() => { /* Tab might not be ready */ });
    }
  }
}

/* ═══════════════════════════════════════════════════════════
   API HELPERS
   ═══════════════════════════════════════════════════════════ */

/**
 * Make a GET request to the Apps Script web app.
 * @param {string} action — Query parameter action
 * @returns {Object|null}
 */
async function apiGet(action) {
  if (API_BASE === 'YOUR_APPS_SCRIPT_WEB_APP_URL_HERE') {
    console.warn('[cam-bg] API_BASE not configured — skipping request');
    return null;
  }

  try {
    const url = `${API_BASE}?action=${encodeURIComponent(action)}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });

    /* Apps Script web apps redirect — follow the redirect */
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.json();
  } catch (err) {
    console.warn(`[cam-bg] GET ${action} failed:`, err.message);
    return null;
  }
}

/**
 * Make a POST request to the Apps Script web app.
 * Chrome extensions with host_permissions bypass CORS,
 * so POST works here (unlike from a web page).
 * @param {string} action
 * @param {Object} data — Request body (action will be added)
 * @returns {Object|null}
 */
async function apiPost(action, data) {
  if (API_BASE === 'YOUR_APPS_SCRIPT_WEB_APP_URL_HERE') {
    console.warn('[cam-bg] API_BASE not configured — skipping request');
    return null;
  }

  try {
    console.log(`[cam-bg] POST ${action}:`, JSON.stringify(data));

    const response = await fetch(API_BASE, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain', /* Avoid CORS preflight */
        'Accept': 'application/json'
      },
      body: JSON.stringify({ action, ...data }),
      redirect: 'follow',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });

    const text = await response.text();
    console.log(`[cam-bg] POST ${action} response (${response.status}):`, text.substring(0, 200));

    try {
      return JSON.parse(text);
    } catch (e) {
      /* GAS sometimes returns HTML on error — log it */
      console.warn(`[cam-bg] POST ${action} — non-JSON response:`, text.substring(0, 300));
      return null;
    }
  } catch (err) {
    console.error(`[cam-bg] POST ${action} FAILED:`, err.message, err.stack);
    return null;
  }
}

/* ═══════════════════════════════════════════════════════════
   SERVICE WORKER LIFECYCLE
   ═══════════════════════════════════════════════════════════ */

chrome.runtime.onInstalled.addListener(() => {
  console.log('[cam-bg] Extension installed/updated');
});

/* Keep service worker alive while Meet tabs exist */
chrome.runtime.onConnect.addListener(() => { });
