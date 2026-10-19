/* ═══════════════════════════════════════════════════════════
   session.js — Session control: course selector, start/end
   class, session timer.

   v3: API calls now go directly to RTDB via api.js.
       The store listener keeps session state in sync,
       so syncSessionFromPoll() is preserved for compat.
   ═══════════════════════════════════════════════════════════ */

import { fetchCourses, startSession, endSession, fetchSessionState } from './api.js';

/* ── State ─────────────────────────────────────────────── */
let _sessionActive  = false;
let _sessionId      = null;
let _sectionId      = null;
let _startedAt      = null;
let _timerInterval  = null;
let _onSessionChange = null; /* callback for app.js */

export function getCurrentSessionId() { return _sessionId; }

let _lastCoursesKey = null;

/**
 * (Re)fill the course dropdown. Safe to call on every store update —
 * it only touches the DOM when the course list actually changes,
 * and preserves the current selection.
 * @param {Array<{ sectionId, courseName, sectionName }>} courses
 */
export function renderCourseOptions(courses) {
  const selector = document.getElementById('course-selector');
  const btnStart = document.getElementById('btn-start-class');
  if (!selector) return;

  const key = JSON.stringify(courses.map(c => [c.sectionId, c.courseName, c.sectionName]));
  if (key === _lastCoursesKey) return;
  _lastCoursesKey = key;

  const previous = selector.value;

  if (courses.length === 0) {
    selector.innerHTML = '<option value="" disabled selected>No courses found</option>';
    if (btnStart) btnStart.disabled = true;
    return;
  }

  selector.innerHTML = '<option value="" disabled selected>Select a course…</option>';
  for (const c of courses) {
    const opt = document.createElement('option');
    opt.value = c.sectionId;
    opt.textContent = `${c.courseName} — ${c.sectionName}`;
    selector.appendChild(opt);
  }

  if (previous && courses.some(c => c.sectionId === previous)) {
    selector.value = previous;
  }
  if (btnStart) btnStart.disabled = !selector.value || _sessionActive;
}

/* ── Init ──────────────────────────────────────────────── */

/**
 * Initialize session control UI.
 * @param {Function} onSessionChange — called with (isActive, summary?) whenever session state changes
 */
export async function initSessionControl(onSessionChange) {
  _onSessionChange = onSessionChange;

  const selector = document.getElementById('course-selector');
  const btnStart = document.getElementById('btn-start-class');
  const btnEnd   = document.getElementById('btn-end-class');

  if (!selector || !btnStart || !btnEnd) return;

  /* ── Load courses ─────────────────────────────────────── */
  /* In live mode the store may not be connected yet (pre sign-in);
     app.js calls renderCourseOptions() again whenever courses arrive. */
  const result = await fetchCourses();
  renderCourseOptions(result.courses || []);

  /* Enable/disable start button based on selector */
  selector.addEventListener('change', () => {
    btnStart.disabled = !selector.value || _sessionActive;
  });

  /* ── Start Class ─────────────────────────────────────── */
  btnStart.addEventListener('click', async () => {
    if (!selector.value || _sessionActive) return;

    btnStart.disabled    = true;
    btnStart.textContent = 'Starting…';

    const result = await startSession(selector.value);

    if (result.error) {
      alert('Failed to start session: ' + result.error);
      btnStart.disabled    = false;
      btnStart.textContent = 'Start Class';
      return;
    }

    _sessionActive = true;
    _sessionId     = result.sessionId;
    _sectionId     = result.sectionId;
    _startedAt     = result.startedAt;

    updateSessionUI();
    startTimer();

    if (_onSessionChange) _onSessionChange(true);
  });

  /* ── End Class ───────────────────────────────────────── */
  btnEnd.addEventListener('click', async () => {
    if (!_sessionActive) return;
    if (!confirm('Are you sure you want to end this class session?')) return;

    btnEnd.disabled    = true;
    btnEnd.textContent = 'Ending…';

    const result = await endSession(_sessionId);

    if (result.error) {
      alert('Failed to end session: ' + result.error);
      btnEnd.disabled    = false;
      btnEnd.textContent = 'End Class';
      return;
    }

    /* Export the session report to Google Sheets via the slim Apps Script exporter */
    _exportSessionReport(_sessionId, _sectionId, _startedAt, result.endedAt).catch(err =>
      console.warn('[session] Report export failed:', err.message)
    );

    _sessionActive = false;
    _sessionId     = null;
    _sectionId     = null;
    _startedAt     = null;

    stopTimer();
    updateSessionUI();

    if (_onSessionChange) _onSessionChange(false, result.summary || null);
  });

  /* ── Restore state if session was already active ─────── */
  const state = await fetchSessionState();
  if (state && state.active) {
    _sessionActive = true;
    _sessionId     = state.sessionId;
    _sectionId     = state.sectionId;
    _startedAt     = state.startedAt;

    /* Select the correct course in the dropdown */
    const opt = selector.querySelector(`option[value="${state.sectionId}"]`);
    if (opt) selector.value = state.sectionId;

    updateSessionUI();
    startTimer();

    if (_onSessionChange) _onSessionChange(true);
  }
}

/* ── Session Report Export ─────────────────────────────── */

/**
 * POST the session summary JSON to the slim Apps Script exporter.
 * The exporter writes one tab in the "Kuwago Reports" spreadsheet.
 *
 * @param {string} sessionId
 * @param {string} sectionId
 * @param {string} startedAt
 * @param {string} endedAt
 */
async function _exportSessionReport(sessionId, sectionId, startedAt, endedAt) {
  /* Import here to avoid circular deps at module parse time */
  const { getState } = await import('./store.js');
  const { buildDashboardData } = await import('./engagement.js');

  const state   = getState();
  const data    = buildDashboardData(state);
  const summary = {
    sessionId,
    sectionId,
    startedAt,
    endedAt,
    students: data.students.map(s => ({
      name:             s.name,
      attendanceStatus: s.attendanceStatus,
      liveStatus:       s.liveStatus
    }))
  };

  /* Apps Script exporter URL — set after deploying the slim exporter */
  const EXPORTER_URL = 'https://script.google.com/macros/s/AKfycbxxr5ZJdb0rvdH7Z3GEWX_4agoJvYCOOh9nYSbP8rdiVV6LZmxJ3U77f_qlYejRN4QyIA/exec';

  await fetch(EXPORTER_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'text/plain' },
    body:    JSON.stringify({ action: 'exportSessionSummary', summary })
  });
}

/* ── Session State Queries ─────────────────────────────── */

export function isSessionActive() { return _sessionActive; }

export function getSessionState() {
  return {
    active:    _sessionActive,
    sessionId: _sessionId,
    sectionId: _sectionId,
    startedAt: _startedAt
  };
}

/**
 * Update session state from RTDB store data.
 * Called by app.js whenever the store notifies of a change.
 */
export function syncSessionFromPoll(sessionData) {
  if (!sessionData || !sessionData.active) {
    if (_sessionActive) {
      _sessionActive = false;
      _sessionId     = null;
      _sectionId     = null;
      _startedAt     = null;
      stopTimer();
      updateSessionUI();
      if (_onSessionChange) _onSessionChange(false);
    }
    return;
  }

  if (sessionData.active && !_sessionActive) {
    _sessionActive = true;
    _sessionId     = sessionData.sessionId;
    _sectionId     = sessionData.sectionId;
    _startedAt     = sessionData.startedAt;
    updateSessionUI();
    startTimer();
    if (_onSessionChange) _onSessionChange(true);
  }
}

/* ── Timer ─────────────────────────────────────────────── */

function startTimer() {
  stopTimer();
  updateTimerDisplay();
  _timerInterval = setInterval(updateTimerDisplay, 1000);
}

function stopTimer() {
  if (_timerInterval) {
    clearInterval(_timerInterval);
    _timerInterval = null;
  }
}

function updateTimerDisplay() {
  const el = document.getElementById('session-timer');
  if (!el) return;

  if (!_startedAt) { el.textContent = '0:00:00'; return; }

  const elapsed = Math.floor((Date.now() - new Date(_startedAt).getTime()) / 1000);
  const h = Math.floor(elapsed / 3600);
  const m = Math.floor((elapsed % 3600) / 60);
  const s = elapsed % 60;

  el.textContent = `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/* ── UI Updates ────────────────────────────────────────── */

function updateSessionUI() {
  const selector = document.getElementById('course-selector');
  const btnStart = document.getElementById('btn-start-class');
  const btnEnd   = document.getElementById('btn-end-class');
  const timerEl  = document.getElementById('session-timer');
  const bar      = document.getElementById('session-control');

  if (_sessionActive) {
    if (selector) selector.disabled = true;
    if (btnStart) {
      btnStart.disabled    = true;
      btnStart.textContent = 'Start Class';
    }
    if (btnEnd) {
      btnEnd.disabled    = false;
      btnEnd.textContent = 'End Class';
      btnEnd.classList.remove('btn--hidden');
    }
    if (bar) bar.classList.add('session-control--active');
  } else {
    if (selector) selector.disabled = false;
    if (btnStart) {
      btnStart.disabled    = !selector || !selector.value;
      btnStart.textContent = 'Start Class';
    }
    if (btnEnd) {
      btnEnd.disabled    = true;
      btnEnd.textContent = 'End Class';
      btnEnd.classList.add('btn--hidden');
    }
    if (timerEl) timerEl.textContent = '0:00:00';
    if (bar)     bar.classList.remove('session-control--active');
  }
}
