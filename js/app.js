/* ═══════════════════════════════════════════════════════════
   app.js — Entry point: init, realtime store, nav switching,
   search filtering, table sorting.

   v3: Poll loop replaced by RTDB store listeners.
       In mock mode (?mock=true), the poll loop is preserved.
   ═══════════════════════════════════════════════════════════ */

import { fetchDashboardData, fetchStudentDetail } from './api.js';
import { initFirebase, signInWithGoogle, signOut, onAuthChange } from './firebase.js';
import { initStore, stopStore, getState } from './store.js';
import { buildDashboardData } from './engagement.js';
import { isMockMode } from './mock.js';
import {
  renderAll,
  renderRosterTable,
  renderSummaryCards,
  renderStudentDetail,
  renderSessionSummary,
  setFilter,
  setSearch,
  setSort
} from './render.js';
import { initPromptModal } from './prompt.js';
import { initRespondentsModal, updateRespondentData } from './respondents.js';
import { initSessionControl, syncSessionFromPoll, isSessionActive, renderCourseOptions } from './session.js';
import { initBatch2Interactions } from './attendance.js';

/* ── Configuration ─────────────────────────────────────── */
const POLL_INTERVAL_MS    = 5000;  /* mock mode only */
const COUNTDOWN_INTERVAL_MS = 1000;

/* ── State ─────────────────────────────────────────────── */
let _pollTimer      = null;
let _countdownTimer = null;
let _currentView    = 'roster'; /* 'roster' | 'unmatched' | 'health' */
let _latestData     = null;
let _pollInProgress = false;

/* ── Init ──────────────────────────────────────────────── */

document.addEventListener('DOMContentLoaded', async () => {
  /* ── Auth Gate (live mode only) ─────────────────────────
     If not signed in, redirect to the login page.
     Mock mode bypasses the gate entirely. */
  if (!isMockMode()) {
    const user = await initFirebase();
    if (!user) {
      window.location.replace('login.html');
      return; /* Stop dashboard initialization */
    }
  }

  initNavigation();
  initSearch();
  initSort();
  initPromptModal();
  initRespondentsModal();
  initBatch2Interactions(async () => {
    /* In mock mode, re-poll after resolution/override.
       In live mode, the store listener fires automatically. */
    if (isMockMode()) await poll(true);
  });
  initStudentDetail();
  initFilters();
  initSessionSummary();

  /* Initialize Firebase Auth (already done for live mode above, no-op for mock) */
  if (isMockMode()) await initFirebase();
  document.getElementById('btn-google-signin')?.addEventListener('click', signInWithGoogle);

  /* Sign-out button — only visible in live mode */
  const signOutBtn = document.getElementById('btn-signout');
  if (!isMockMode() && signOutBtn) {
    signOutBtn.style.display = '';
    signOutBtn.addEventListener('click', async () => {
      await signOut();
      window.location.replace('login.html');
    });
  }


  /* Initialize session control */
  await initSessionControl((isActive, summary) => {
    /* Callback when session state changes */
    updatePromptButtonState(isActive);
    if (!isActive && summary) {
      renderSessionSummary(summary);
    }
  });

  if (isMockMode()) {
    /* ── MOCK MODE: use poll loop as before ─────────────── */
    await poll();
    _pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  } else {
    /* ── LIVE MODE: subscribe to RTDB store ─────────────── */
    /* RTDB rules require auth, and Firebase permanently cancels a
       listener that gets permission_denied. So only attach listeners
       while signed in, and re-attach after every sign-in. */
    onAuthChange((user) => {
      if (!user) {
        stopStore();
        renderCourseOptions([]);
        return;
      }

      initStore((state) => {
        renderCourseOptions(state.courses);

        const data = buildDashboardData(state);
        _latestData = data;
        renderAll(data, false /* never "poll failed" in RTDB mode */);
        updateRespondentData(data.activePrompt);

        /* Keep session.js UI in sync */
        if (data.session) syncSessionFromPoll(data.session);
        else syncSessionFromPoll(null);
      });
    });
  }

  /* Countdown refresh loop — re-renders prompt timer every second */
  _countdownTimer = setInterval(() => {
    if (_latestData) renderSummaryCards(_latestData);
  }, COUNTDOWN_INTERVAL_MS);

  /* Remove the loading state */
  document.querySelector('.shell')?.classList.remove('app-loading');
});

/* ── Poll (mock mode only) ─────────────────────────────── */

async function poll(force = false) {
  if (_pollInProgress && !force) return;
  _pollInProgress = true;

  try {
    const { data, pollFailed } = await fetchDashboardData();
    if (data) {
      _latestData = data;
      renderAll(data, pollFailed);
      updateRespondentData(data.activePrompt);

      /* Sync session state from poll data */
      if (data.session) syncSessionFromPoll(data.session);
    }
  } finally {
    _pollInProgress = false;
  }
}

/* ── Navigation ────────────────────────────────────────── */

function initNavigation() {
  const navRoster    = document.getElementById('nav-roster');
  const navUnmatched = document.getElementById('nav-unmatched');
  const navHealth    = document.getElementById('nav-health');

  const viewRoster    = document.getElementById('view-roster');
  const viewUnmatched = document.getElementById('view-unmatched');
  const viewHealth    = document.getElementById('view-health');

  function switchView(view) {
    _currentView = view;

    /* Update nav active state */
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('nav-item--active'));

    /* Show/hide views */
    if (viewRoster)    viewRoster.hidden    = view !== 'roster';
    if (viewUnmatched) viewUnmatched.hidden = view !== 'unmatched';
    if (viewHealth)    viewHealth.hidden    = view !== 'health';

    if (view === 'roster'    && navRoster)    navRoster.classList.add('nav-item--active');
    if (view === 'unmatched' && navUnmatched) navUnmatched.classList.add('nav-item--active');
    if (view === 'health'    && navHealth)    navHealth.classList.add('nav-item--active');
  }

  if (navRoster) {
    navRoster.addEventListener('click', () => switchView('roster'));
    navRoster.addEventListener('keydown', (e) => { if (e.key === 'Enter') switchView('roster'); });
  }

  if (navUnmatched) {
    navUnmatched.addEventListener('click', () => switchView('unmatched'));
    navUnmatched.addEventListener('keydown', (e) => { if (e.key === 'Enter') switchView('unmatched'); });
  }

  if (navHealth) {
    navHealth.addEventListener('click', () => switchView('health'));
    navHealth.addEventListener('keydown', (e) => { if (e.key === 'Enter') switchView('health'); });
  }
}

/* ── Search ────────────────────────────────────────────── */

function initSearch() {
  const input = document.getElementById('search-input');
  const kbd = document.getElementById('search-kbd');
  if (!input) return;

  // Platform detection for keyboard shortcut hint
  if (kbd && typeof navigator !== 'undefined') {
    const isMac = /(Mac|iPhone|iPod|iPad)/i.test(navigator.platform || navigator.userAgent);
    kbd.textContent = isMac ? '⌘K' : 'Ctrl+K';
  }

  input.addEventListener('input', () => {
    setSearch(input.value);
    if (_latestData) renderRosterTable(_latestData.students);
  });

  // Global Emil Kowalski keyboard ergonomics: ⌘K / Ctrl+K or '/' to focus search
  document.addEventListener('keydown', (e) => {
    const isModifier = e.metaKey || e.ctrlKey;
    const isCmdK = isModifier && (e.key === 'k' || e.key === 'K');
    const isSlash = e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);

    if (isCmdK || isSlash) {
      e.preventDefault();
      input.focus();
      input.select();
    } else if (e.key === 'Escape' && document.activeElement === input) {
      input.value = '';
      setSearch('');
      input.blur();
      if (_latestData) renderRosterTable(_latestData.students);
    }
  });
}

/* ── Sort ──────────────────────────────────────────────── */

function initSort() {
  document.querySelectorAll('.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.getAttribute('data-sort');
      if (!key) return;
      setSort(key);
      if (_latestData) renderRosterTable(_latestData.students);
    });
  });
}

/* ── Filter Buttons ────────────────────────────────────── */

function initFilters() {
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('filter-btn--active'));
      btn.classList.add('filter-btn--active');

      const filter = btn.getAttribute('data-filter');
      setFilter(filter);
      if (_latestData) renderRosterTable(_latestData.students);
    });
  });
}

/* ── Session Summary Modal ─────────────────────────────── */

function initSessionSummary() {
  const modal = document.getElementById('session-summary-modal');
  if (!modal) return;

  function close() { modal.classList.remove('is-open'); }

  document.getElementById('ss-close-btn')?.addEventListener('click', close);
  document.getElementById('ss-close-footer-btn')?.addEventListener('click', close);
  modal.addEventListener('click', e => { if (e.target === modal) close(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && modal.classList.contains('is-open')) close();
  });
}

/* ── Prompt Button State ───────────────────────────────── */

function updatePromptButtonState(isActive) {
  const btn = document.getElementById('btn-set-prompt');
  if (!btn) return;

  if (isActive) {
    btn.disabled = false;
    btn.title = '';
  } else {
    btn.disabled = true;
    btn.title = 'Start a class session first';
  }
}

/* ── Student Detail Overlay ────────────────────────────── */

function initStudentDetail() {
  const modal       = document.getElementById('student-detail-modal');
  const closeBtn    = document.getElementById('sd-close-btn');
  const rosterTable = document.getElementById('roster-table');

  if (!modal || !closeBtn || !rosterTable) return;

  function closeModal() { modal.classList.remove('is-open'); }

  closeBtn.addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.classList.contains('is-open')) closeModal();
  });

  rosterTable.addEventListener('click', async (e) => {
    const row = e.target.closest('tr.roster-row');
    if (!row || e.target.closest('.attendance-badge')) return;

    const studentName = row.dataset.name;
    if (!studentName) return;

    const sessionId = _latestData && _latestData.session ? _latestData.session.sessionId : null;

    modal.classList.add('is-open');
    document.getElementById('sd-loading').hidden = false;
    document.getElementById('sd-content').hidden = true;
    document.getElementById('sd-name').textContent = studentName;

    const data = await fetchStudentDetail(sessionId, studentName);

    if (data && !data.error) {
      renderStudentDetail(data);
    } else {
      document.getElementById('sd-loading').innerHTML =
        '<p style="color:var(--status-unmatched)">Error loading student data.</p>';
    }
  });
}
