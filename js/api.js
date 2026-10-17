/* ═══════════════════════════════════════════════════════════
   api.js — All data operations for the dashboard.

   BEFORE (v2): fetch() calls to Apps Script web app.
   AFTER  (v3): direct RTDB writes via store.js helpers.

   Mock mode (?mock=true) is fully preserved — all functions
   fall through to the same mock implementations as before.

   Public API surface is identical to v2, so all callers
   (session.js, attendance.js, prompt.js, app.js) work as-is.
   ═══════════════════════════════════════════════════════════ */

import {
  isMockMode, generateMockData, mockSendPrompt,
  mockGetCourses, mockStartSession, mockEndSession, mockGetSessionState,
  mockResolveMatch, mockOverrideAttendance, mockStudentDetail
} from './mock.js';
import {
  writeToDb, updateDb, pushToDb, multiUpdate, newKey, readOnce, getState
} from './store.js';
import { sanitizeName } from './firebase.js';
import { buildStudentDetail } from './engagement.js';

/* ── Backward-compat shim ─────────────────────────────────── */

/**
 * @deprecated In v3 the dashboard uses store listeners instead of polling.
 * This function is kept only so any remaining callers don't throw.
 * It returns the last known state built from the RTDB snapshot.
 */
export async function fetchDashboardData() {
  if (isMockMode()) {
    const data = generateMockData();
    return { data, pollFailed: false };
  }
  /* In live mode the store drives rendering — this should not be called.
     Return a sentinel so callers can detect the migration. */
  return { data: null, pollFailed: false };
}

/** No longer meaningful in RTDB mode — kept for API compat. */
export function isPollFailed()         { return false; }
export function getConsecutiveFailures() { return 0; }

/* ═══════════════════════════════════════════════════════════
   PROMPT
   ═══════════════════════════════════════════════════════════ */

/**
 * Set a new chat prompt.
 * Expires any currently active prompt and creates the new one.
 *
 * @param {string} phrase — expected phrase
 * @param {number} durationSeconds
 * @returns {{ success: boolean, error?: string }}
 */
export async function sendPrompt(phrase, durationSeconds) {
  if (isMockMode()) return mockSendPrompt(phrase, durationSeconds);

  try {
    const state    = getState();
    const session  = state.session;
    if (!session || !session.active) {
      return { success: false, error: 'No active class session' };
    }

    const sessionId = session.sessionId;
    const base      = `kuwago/classSessions/${sessionId}/prompts`;
    const now       = new Date();
    const expiresAt = new Date(now.getTime() + (durationSeconds || 60) * 1000).toISOString();
    const promptId  = newKey(base);

    /* Expire all existing active prompts first */
    const existingPrompts = state.prompts || {};
    const expireUpdates = {};
    for (const [pid, p] of Object.entries(existingPrompts)) {
      if (p.active) expireUpdates[`${base}/${pid}/active`] = false;
    }

    /* Write new prompt atomically */
    const newPrompt = {
      phrase,
      issuedAt:  now.toISOString(),
      expiresAt,
      active:    true
    };

    await multiUpdate({
      ...expireUpdates,
      [`${base}/${promptId}`]: newPrompt
    });

    return {
      success:   true,
      promptId,
      phrase,
      issuedAt:  now.toISOString(),
      expiresAt
    };
  } catch (err) {
    console.error('[api] sendPrompt failed:', err.message);
    return { success: false, error: err.message };
  }
}

/* ═══════════════════════════════════════════════════════════
   SESSION CONTROL
   ═══════════════════════════════════════════════════════════ */

/**
 * Fetch the list of available courses/sections from RTDB state.
 * @returns {{ courses: Array<{ sectionId, courseName, sectionName }> }}
 */
export async function fetchCourses() {
  if (isMockMode()) return mockGetCourses();

  try {
    const { courses } = getState();
    if (courses.length > 0) return { courses };

    /* Fallback: read once if store hasn't synced yet */
    const val = await readOnce('kuwago/courses');
    if (!val) return { courses: [] };

    const result = Object.entries(val).map(([sectionId, c]) => ({
      sectionId,
      courseName:  c.courseName  || '',
      sectionName: c.sectionName || ''
    }));
    return { courses: result };
  } catch (err) {
    console.error('[api] fetchCourses failed:', err.message);
    return { courses: [], error: err.message };
  }
}

/**
 * Start a new class session.
 * @param {string} sectionId
 * @returns {{ success, sessionId, sectionId, startedAt } | { error }}
 */
export async function startSession(sectionId) {
  if (isMockMode()) return mockStartSession(sectionId);

  try {
    /* Check for already-active session */
    const current = await readOnce('kuwago/activeSession');
    if (current && current.active) {
      return { error: 'A session is already active. End it before starting a new one.' };
    }

    const sessionId  = 'cls_' + Date.now();
    const startedAt  = new Date().toISOString();

    await multiUpdate({
      'kuwago/activeSession': { active: true, sessionId, sectionId, startedAt },
      [`kuwago/classSessions/${sessionId}`]: {
        sectionId,
        startedAt,
        endedAt: null
      }
    });

    return { success: true, sessionId, sectionId, startedAt };
  } catch (err) {
    console.error('[api] startSession failed:', err.message);
    return { error: err.message };
  }
}

/**
 * End the current class session.
 * Marks all open attendance records closed, expires active prompts,
 * and sets the session inactive.
 *
 * @param {string} sessionId
 * @returns {{ success, endedAt, summary? } | { error }}
 */
export async function endSession(sessionId) {
  if (isMockMode()) return mockEndSession();

  try {
    const endedAt = new Date().toISOString();
    const state   = getState();
    const base    = `kuwago/classSessions/${sessionId}`;

    const updates = {
      'kuwago/activeSession/active':    false,
      [`${base}/endedAt`]:              endedAt
    };

    /* Close all open attendance records */
    for (const [key, att] of Object.entries(state.attendance)) {
      if (att.joinTime && !att.leaveTime) {
        updates[`${base}/attendance/${key}/leaveTime`] = endedAt;
      }
    }

    /* Expire all active prompts */
    for (const [pid, p] of Object.entries(state.prompts)) {
      if (p.active) updates[`${base}/prompts/${pid}/active`] = false;
    }

    await multiUpdate(updates);

    return { success: true, endedAt };
  } catch (err) {
    console.error('[api] endSession failed:', err.message);
    return { error: err.message };
  }
}

/**
 * Get the current session state from RTDB state snapshot.
 * @returns {{ active, sessionId?, sectionId?, startedAt? }}
 */
export async function fetchSessionState() {
  if (isMockMode()) return mockGetSessionState();

  try {
    const { session } = getState();
    if (session && session.active) return session;

    /* Fallback: read once */
    const val = await readOnce('kuwago/activeSession');
    return val && val.active ? val : { active: false };
  } catch (err) {
    console.error('[api] fetchSessionState failed:', err.message);
    return { active: false, error: err.message };
  }
}

/* ═══════════════════════════════════════════════════════════
   BATCH 2 — Name Resolution & Attendance
   ═══════════════════════════════════════════════════════════ */

/**
 * Resolve an unmatched display name to a roster student, or dismiss.
 * Writes to RTDB aliases path for future auto-matching.
 *
 * @param {string} detectedName — raw unmatched name
 * @param {string|null} resolvedTo — canonical roster name, or null to dismiss
 */
export async function resolveMatch(detectedName, resolvedTo) {
  if (isMockMode()) return mockResolveMatch(detectedName, resolvedTo);

  try {
    const aliasKey = sanitizeName(detectedName);
    const canonical = resolvedTo || null;

    if (canonical) {
      /* Save alias so future joins auto-match */
      await writeToDb(`kuwago/aliases/${aliasKey}`, { canonical });

      /* Retroactively re-key the attendance record if it exists */
      const state     = getState();
      const session   = state.session;
      if (session && session.active) {
        const oldKey  = sanitizeName(detectedName);
        const newK    = sanitizeName(canonical);
        const existingAtt = state.attendance[oldKey];

        if (existingAtt && oldKey !== newK) {
          const base = `kuwago/classSessions/${session.sessionId}/attendance`;
          await multiUpdate({
            [`${base}/${newK}`]:  { ...existingAtt, matched: true },
            [`${base}/${oldKey}`]: null  /* delete old key */
          });
        }
      }
    } else {
      /* Dismissed — write a null canonical so we don't re-ask */
      await writeToDb(`kuwago/aliases/${aliasKey}`, { canonical: null, dismissed: true });
    }

    return {
      success:    true,
      detectedName,
      resolvedTo: canonical,
      dismissed:  canonical === null
    };
  } catch (err) {
    console.error('[api] resolveMatch failed:', err.message);
    return { error: err.message };
  }
}

/**
 * Override a student's attendance status manually.
 *
 * @param {string} sessionId
 * @param {string} studentName
 * @param {string} status — 'Present' | 'Late' | 'Absent' | 'Excused'
 * @param {string} reason
 */
export async function overrideAttendance(sessionId, studentName, status, reason) {
  if (isMockMode()) return mockOverrideAttendance(sessionId, studentName, status, reason);

  const validStatuses = ['Present', 'Late', 'Absent', 'Excused'];
  if (!validStatuses.includes(status)) {
    return { error: `Invalid status: ${status}` };
  }

  try {
    const sKey = sanitizeName(studentName);
    const sid  = sessionId || getState().session?.sessionId;
    if (!sid) return { error: 'No active session' };

    await writeToDb(`kuwago/classSessions/${sid}/attendance/${sKey}/override`, {
      status,
      reason: reason || '',
      at:     new Date().toISOString()
    });

    return {
      success:   true,
      studentName,
      newStatus: status,
      reason:    reason || '',
      changedAt: new Date().toISOString()
    };
  } catch (err) {
    console.error('[api] overrideAttendance failed:', err.message);
    return { error: err.message };
  }
}

/**
 * Fetch rich per-student detail for the overlay panel.
 * Computed client-side from RTDB state — no network call.
 *
 * @param {string} _sessionId — ignored (RTDB state is always current-session scoped)
 * @param {string} studentName
 */
export async function fetchStudentDetail(_sessionId, studentName) {
  if (isMockMode()) return mockStudentDetail(_sessionId, studentName);

  try {
    const state = getState();
    return buildStudentDetail(studentName, state);
  } catch (err) {
    console.error('[api] fetchStudentDetail failed:', err.message);
    return { error: err.message };
  }
}
