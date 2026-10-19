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

    /* Snapshot the report data FIRST — once the session is marked
       inactive the store clears attendance/focus/prompt data. */
    const endedAtIso = new Date().toISOString();
    let summary = null;
    try {
      const { getState }            = await import('./store.js');
      const { buildSessionSummary } = await import('./engagement.js');
      const { isMockMode }          = await import('./mock.js');
      if (!isMockMode()) summary = buildSessionSummary(getState(), endedAtIso);
    } catch (err) {
      console.warn('[session] Could not build summary:', err.message);
    }

    const result = await endSession(_sessionId);

    if (result.error) {
      alert('Failed to end session: ' + result.error);
      btnEnd.disabled    = false;
      btnEnd.textContent = 'End Class';
      return;
    }

    if (summary) summary.endedAt = result.endedAt || endedAtIso;

    _sessionActive = false;
    _sessionId     = null;
    _sectionId     = null;
    _startedAt     = null;

    stopTimer();
    updateSessionUI();

    /* Open the summary modal immediately, then export to Google Sheets */
    if (summary) {
      const { renderSessionSummary } = await import('./render.js');
      renderSessionSummary({ ...summary, sheetName: '' });
      _runExport(summary);
    }

    if (_onSessionChange) _onSessionChange(false, null);
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

/* Apps Script exporter URL — the slim exporter web app */
const EXPORTER_URL = 'https://script.google.com/macros/s/AKfycbxxr5ZJdb0rvdH7Z3GEWX_4agoJvYCOOh9nYSbP8rdiVV6LZmxJ3U77f_qlYejRN4QyIA/exec';

/**
 * Show export progress in the summary modal.
 * @param {'saving'|'saved'|'unconfirmed'|'error'} state
 * @param {{ sheetName?: string, url?: string, message?: string }} [info]
 */
function _setExportStatus(state, info = {}) {
  const el = document.getElementById('ss-export-status');
  if (!el) return;

  const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  el.className = 'ss-hint ss-export ss-export--' + state;
  if (state === 'saving') {
    el.innerHTML = '⏳ Saving report to Google Sheets…';
  } else if (state === 'saved') {
    const link = info.url
      ? ` <a href="${esc(info.url)}" target="_blank" rel="noopener">Open sheet ↗</a>`
      : '';
    el.innerHTML = `✅ Saved to <strong>Kuwago Reports</strong> → tab <strong>${esc(info.sheetName || '')}</strong>.${link}`;
  } else if (state === 'unconfirmed') {
    el.innerHTML = '⚠️ Report was sent, but the exporter did not confirm. Check the <strong>Kuwago Reports</strong> sheet in your Google Drive.'
      + ' <button type="button" class="btn btn--ghost" id="ss-retry-export">Retry</button>';
  } else {
    el.innerHTML = `❌ Could not save to Google Sheets: ${esc(info.message || 'unknown error')}`
      + ' <button type="button" class="btn btn--ghost" id="ss-retry-export">Retry</button>';
  }
}

/** Run the export for a summary and reflect the outcome in the modal. */
async function _runExport(summary) {
  _setExportStatus('saving');
  try {
    const out = await _exportSessionReport(summary);
    if (out && out.ok) {
      const nameEl = document.getElementById('ss-sheet-name');
      const inlineEl = document.getElementById('ss-sheet-name-inline');
      if (nameEl) nameEl.textContent = out.sheetName || '';
      if (inlineEl) inlineEl.textContent = out.sheetName || '';
      _setExportStatus('saved', out);
    } else if (out && out.opaque) {
      _setExportStatus('unconfirmed');
    } else {
      _setExportStatus('error', { message: (out && out.error) || 'Exporter returned an error' });
    }
  } catch (err) {
    console.warn('[session] Report export failed:', err.message);
    _setExportStatus('error', { message: err.message });
  }

  document.getElementById('ss-retry-export')?.addEventListener('click', () => _runExport(summary));
}

/**
 * POST the session summary JSON to the slim Apps Script exporter.
 * The exporter writes one tab in the "Kuwago Reports" spreadsheet.
 *
 * @param {Object} summary — from buildSessionSummary()
 * @returns {Promise<{ ok?: boolean, sheetName?: string, url?: string, error?: string, opaque?: boolean }>}
 */
async function _exportSessionReport(summary) {
  const payload = {
    sessionId: summary.sessionId,
    sectionId: summary.sectionId,
    startedAt: summary.startedAt,
    endedAt:   summary.endedAt,
    students:  summary.students.map(s => ({
      name:             s.name,
      attendanceStatus: s.attendanceStatus,
      focusLapses:      s.focusLapses,
      attentivenessPct: s.attentivenessPct,
      answered:         s.answered,
      issued:           s.issued,
      participationPct: s.participationPct
    }))
  };

  const res = await fetch(EXPORTER_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'text/plain' },
    body:    JSON.stringify({ action: 'exportSessionSummary', summary: payload })
  });

  if (!res.ok) throw new Error(`Exporter HTTP ${res.status}`);

  try {
    return await res.json();
  } catch {
    return { opaque: true };
  }
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
