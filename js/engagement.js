/* ═══════════════════════════════════════════════════════════
   engagement.js — Client-side engagement calculation engine.

   Ported from apps-script/Engagement.gs and the
   buildStudentList / buildActivePromptData functions in Code.gs.

   All logic runs in the browser from the RTDB state snapshot
   delivered by store.js — no network calls, no polling.
   ═══════════════════════════════════════════════════════════ */

import { sanitizeName } from './firebase.js';

/* ── Thresholds (match Engagement.gs) ────────────────────── */

const FOCUS_LAPSE_THRESHOLD_MS = 60 * 1000;   /* 60 s unfocused → lapse */
const HEARTBEAT_DISCONNECT_MS  = 60 * 1000;   /* 60 s no heartbeat → disconnected */
const GRACE_PERIOD_MS          = 10 * 60 * 1000; /* 10 min join grace → Present */

/* ═══════════════════════════════════════════════════════════
   CORE CALCULATIONS
   ═══════════════════════════════════════════════════════════ */

/**
 * Determine a student's current live status.
 *
 * @param {Object|null} att — attendance record from RTDB
 *   { joinTime, leaveTime?, ... }
 * @param {Array<{ type: string, at: string|number }>} focusEvents
 *   Focus events for this student in the current session.
 * @returns {'not_joined'|'on_meet'|'away'}
 */
export function determineStatus(att, focusEvents) {
  if (!att || !att.joinTime)  return 'not_joined';
  if (att.leaveTime)          return 'not_joined';

  /* Most recent focus event determines in-tab status */
  const sorted = focusEvents
    .filter(e => e.at)
    .sort((a, b) => _ts(b.at) - _ts(a.at));

  if (sorted.length > 0 && sorted[0].type === 'lost') return 'away';
  return 'on_meet';
}

/**
 * Compute focus lapses for a student within a session.
 * A lapse is a focus_lost → focus_regained pair (or lost → session end)
 * whose gap exceeds FOCUS_LAPSE_THRESHOLD_MS.
 *
 * @param {Object|null} att — attendance record
 * @param {Array<{ type: string, at: string|number }>} focusEvents
 * @returns {{ count: number, totalSeconds: number, lapses: Array<{ startedAt: string, durationSeconds: number }> }}
 */
export function computeFocusLapses(att, focusEvents) {
  if (!att || !att.joinTime) return { count: 0, totalSeconds: 0, lapses: [] };

  const endTime = att.leaveTime ? _ts(att.leaveTime) : Date.now();

  const events = focusEvents
    .filter(e => e.at)
    .map(e => ({ type: e.type, time: _ts(e.at) }))
    .sort((a, b) => a.time - b.time);

  const lapses = [];
  let lostAt = null;

  for (const evt of events) {
    if (evt.type === 'lost' && lostAt === null) {
      lostAt = evt.time;
    } else if (evt.type === 'regained' && lostAt !== null) {
      const durationMs = evt.time - lostAt;
      if (durationMs >= FOCUS_LAPSE_THRESHOLD_MS) {
        lapses.push({ startedAt: new Date(lostAt).toISOString(), durationSeconds: Math.round(durationMs / 1000) });
      }
      lostAt = null;
    }
  }

  /* Still unfocused at session end */
  if (lostAt !== null) {
    const durationMs = endTime - lostAt;
    if (durationMs >= FOCUS_LAPSE_THRESHOLD_MS) {
      lapses.push({ startedAt: new Date(lostAt).toISOString(), durationSeconds: Math.round(durationMs / 1000) });
    }
  }

  const totalSeconds = lapses.reduce((sum, l) => sum + l.durationSeconds, 0);
  return { count: lapses.length, totalSeconds, lapses };
}

/**
 * Compute prompt participation for a student.
 *
 * @param {Object|null} att — attendance record
 * @param {Object.<string, { issuedAt: string, expiresAt: string, active: boolean }>} allPrompts
 * @param {Array<{ promptId: string, matched: boolean }>} studentResponses
 * @returns {{ answered: number, issued: number, rate: number }}
 */
export function computeParticipation(att, allPrompts, studentResponses) {
  const promptEntries = Object.entries(allPrompts || {});
  if (promptEntries.length === 0 || !att || !att.joinTime) {
    return { answered: 0, issued: 0, rate: 0 };
  }

  const joinMs  = _ts(att.joinTime);
  const leaveMs = att.leaveTime ? _ts(att.leaveTime) : Date.now();

  let issued   = 0;
  let answered = 0;

  for (const [pid, prompt] of promptEntries) {
    const issuedAt = _ts(prompt.issuedAt);
    if (issuedAt >= joinMs && issuedAt <= leaveMs) {
      issued++;
      const hasCorrect = studentResponses.some(r => r.promptId === pid && r.matched === true);
      if (hasCorrect) answered++;
    }
  }

  const rate = issued > 0 ? Math.round((answered / issued) * 100) : 0;
  return { answered, issued, rate };
}

/**
 * Compute active alerts for a single joined student.
 *
 * @param {'not_joined'|'on_meet'|'away'} liveStatus
 * @param {Array<{ type: string, at: string|number }>} focusEvents
 * @param {Object|null} heartbeat — { at: number } or null
 * @param {Object|null} activePrompt — { _id, expiresAt } or null
 * @param {Array<{ promptId: string, matched: boolean }>} studentResponses
 * @returns {string[]}
 */
export function computeActiveAlerts(liveStatus, focusEvents, heartbeat, activePrompt, studentResponses) {
  const alerts = [];
  const now    = Date.now();

  if (liveStatus === 'not_joined') return alerts;

  /* ── Sustained unfocus ──────────────────────────────────── */
  if (liveStatus === 'away') {
    const sorted = focusEvents
      .filter(e => e.at)
      .sort((a, b) => _ts(b.at) - _ts(a.at));

    const latestLost = sorted.find(e => e.type === 'lost');
    if (latestLost) {
      const lostMs = now - _ts(latestLost.at);
      if (lostMs >= FOCUS_LAPSE_THRESHOLD_MS) alerts.push('sustained_unfocus');
    }
  }

  /* ── Missing extension heartbeat ───────────────────────── */
  if (!heartbeat || !heartbeat.at) {
    alerts.push('missing_extension');
  } else {
    const lastBeat = typeof heartbeat.at === 'number' ? heartbeat.at : _ts(heartbeat.at);
    if (now - lastBeat > HEARTBEAT_DISCONNECT_MS) alerts.push('missing_extension');
  }

  /* ── Unanswered prompt ──────────────────────────────────── */
  if (activePrompt) {
    const promptExpired = activePrompt.expiresAt
      ? _ts(activePrompt.expiresAt) < now
      : false;

    if (promptExpired) {
      const hasResponse = studentResponses.some(
        r => r.promptId === activePrompt._id && r.matched === true
      );
      if (!hasResponse) alerts.push('unanswered_prompt');
    }
  }

  return alerts;
}

/* ═══════════════════════════════════════════════════════════
   MAIN DATA BUILDER — produces the shape renderAll() expects
   ═══════════════════════════════════════════════════════════ */

/**
 * Build the full dashboard data object from RTDB state.
 * This replaces the Apps Script handleDashboardData() call.
 *
 * Output shape matches what renderAll(data) expects:
 *   { sessionActive, activePrompt, students, extensionHealth, session }
 *
 * @param {import('./store.js').KuwagoState} state
 * @returns {Object}
 */
export function buildDashboardData(state) {
  const { session, students: roster, attendance, focusEvents,
          prompts, responses, heartbeats } = state;

  const sessionActive   = !!(session && session.active);
  const sessionStartedAt = sessionActive ? session.startedAt : null;
  const sectionId       = sessionActive ? session.sectionId  : null;

  /* ── Filter roster to active section ─────────────────────── */
  const sectionStudents = sectionId
    ? roster.filter(s => s.sectionId === sectionId)
    : roster;

  /* ── Find active prompt ───────────────────────────────────── */
  const now = Date.now();
  let activePromptObj = null;

  for (const [pid, p] of Object.entries(prompts)) {
    const notExpired = !p.expiresAt || _ts(p.expiresAt) > now;
    if (p.active && notExpired) {
      activePromptObj = { ...p, _id: pid };
      break;
    }
  }

  /* Most recent prompt (active or expired) — for the prompt card */
  const sortedPrompts = Object.entries(prompts)
    .map(([id, p]) => ({ id, ...p }))
    .sort((a, b) => _ts(b.issuedAt) - _ts(a.issuedAt));
  const latestPrompt = sortedPrompts[0] || null;

  /* ── Build student list ───────────────────────────────────── */
  const studentList = [];

  for (const rosterStudent of sectionStudents) {
    const sKey = sanitizeName(rosterStudent.name);

    const att              = attendance[sKey] || null;
    const studentFocusEvts = focusEvents.filter(e => e.student === sKey);
    const studentResponses = responses.filter(r => r.student === sKey);
    const heartbeat        = heartbeats[sKey] || null;

    const liveStatus = determineStatus(att, studentFocusEvts);

    /* Attendance status */
    let attendanceStatus = sessionStartedAt ? 'Absent' : null;
    if (sessionStartedAt && att) {
      if (att.override && att.override.status) {
        attendanceStatus = att.override.status;
      } else if (att.status) {
        attendanceStatus = att.status;
      } else if (att.joinTime) {
        const joinMs  = _ts(att.joinTime);
        const startMs = _ts(sessionStartedAt);
        attendanceStatus = (joinMs <= startMs + GRACE_PERIOD_MS) ? 'Present' : 'Late';
      }
    }

    const activeAlerts = computeActiveAlerts(
      liveStatus, studentFocusEvts, heartbeat,
      activePromptObj, studentResponses
    );

    studentList.push({
      name:             rosterStudent.name,
      liveStatus,
      attendanceStatus,
      activeAlerts,
      matched:          true
    });
  }

  /* ── Build unmatched session identities ───────────────────── */
  if (sessionActive) {
    const rosterKeys = new Set(sectionStudents.map(student => sanitizeName(student.name)));
    const unmatchedKeys = new Set();

    for (const [attendanceKey, att] of Object.entries(attendance)) {
      const attendanceIdentityKey = sanitizeName(attendanceKey);
      if (rosterKeys.has(attendanceIdentityKey)) continue;

      const detectedName = att.detectedName || attendanceKey;
      const identityKey = sanitizeName(detectedName);
      if (unmatchedKeys.has(identityKey)) continue;
      unmatchedKeys.add(identityKey);

      const unmatchedFocusEvents = focusEvents.filter(e => e.student === attendanceKey);
      const unmatchedHeartbeat = heartbeats[attendanceKey] || null;

      studentList.push({
        name: detectedName,
        liveStatus: determineStatus(att, unmatchedFocusEvents),
        attendanceStatus: null,
        activeAlerts: computeActiveAlerts(
          determineStatus(att, unmatchedFocusEvents),
          unmatchedFocusEvents,
          unmatchedHeartbeat,
          activePromptObj,
          responses.filter(r => r.student === attendanceKey)
        ),
        matched: false,
        action: 'Unmatched'
      });
    }
  }

  /* ── Build prompt card data ───────────────────────────────── */
  let activePromptData = null;

  if (latestPrompt) {
    const matchedResponses = responses.filter(
      r => r.promptId === latestPrompt.id && r.matched === true
    );

    /* Reverse-lookup sanitized keys → display names */
    const respondentNames = [...new Set(matchedResponses.map(r => {
      const found = sectionStudents.find(s => sanitizeName(s.name) === r.student);
      return found ? found.name : r.student;
    }))];

    const allRosterNames     = sectionStudents.map(s => s.name);
    const respondentsNormSet = new Set(respondentNames.map(n => sanitizeName(n)));
    const nonRespondents     = allRosterNames.filter(n => !respondentsNormSet.has(sanitizeName(n)));

    activePromptData = {
      phrase:            latestPrompt.phrase,
      issuedAt:          latestPrompt.issuedAt,
      expiresAt:         latestPrompt.expiresAt,
      responsesReceived: matchedResponses.length,
      rosterCount:       sectionStudents.length,
      respondents:       respondentNames,
      nonRespondents
    };
  }

  /* ── Build extension health ───────────────────────────────── */
  const extensionHealth = sectionStudents.map(s => {
    const sKey = sanitizeName(s.name);
    const hb   = heartbeats[sKey] || null;
    const att  = attendance[sKey] || null;
    const hasOpenSession = att && att.joinTime && !att.leaveTime;

    if (!hb) {
      return {
        name:             s.name,
        connected:        false,
        detectedName:     null,
        extensionVersion: null,
        lastHeartbeat:    null,
        status:           hasOpenSession ? 'no_heartbeat' : 'never_connected'
      };
    }

    const lastBeat  = typeof hb.at === 'number' ? hb.at : _ts(hb.at);
    const connected = (now - lastBeat) < HEARTBEAT_DISCONNECT_MS;

    let status = 'connected';
    if (!connected && hasOpenSession) status = 'connection_lost';
    else if (!connected)             status = 'disconnected';

    return {
      name:             s.name,
      connected,
      detectedName:     hb.detectedName   || '',
      extensionVersion: hb.version        || 'unknown',
      lastHeartbeat:    hb.at ? new Date(lastBeat).toISOString() : null,
      status
    };
  });

  return {
    sessionActive,
    activePrompt: activePromptData,
    students:     studentList,
    extensionHealth,
    session:      sessionActive ? session : null
  };
}

/* ═══════════════════════════════════════════════════════════
   STUDENT DETAIL BUILDER (replaces handleStudentDetail in Code.gs)
   ═══════════════════════════════════════════════════════════ */

/**
 * Build rich per-student detail for the overlay panel.
 * Called on demand when the professor clicks a roster row.
 *
 * @param {string} studentName — canonical roster name
 * @param {import('./store.js').KuwagoState} state
 * @returns {Object} — shape expected by renderStudentDetail()
 */
export function buildStudentDetail(studentName, state) {
  const { session, attendance, focusEvents, prompts, responses, heartbeats } = state;
  const sKey        = sanitizeName(studentName);
  const att         = attendance[sKey] || null;
  const studentFocusEvts = focusEvents.filter(e => e.student === sKey);
  const studentResponses = responses.filter(r => r.student === sKey);
  const hb          = heartbeats[sKey] || null;

  const liveStatus  = determineStatus(att, studentFocusEvts);
  const focusLapses = computeFocusLapses(att, studentFocusEvts);
  const participation = computeParticipation(att, prompts, studentResponses);

  /* Per-prompt response detail */
  const promptDetail = Object.entries(prompts).map(([pid, p]) => {
    const resp = studentResponses.find(r => r.promptId === pid);
    return {
      promptId:      pid,
      phrase:        p.phrase,
      issuedAt:      p.issuedAt,
      submittedText: resp ? resp.text  : null,
      matched:       resp ? resp.matched : false,
      responded:     !!resp,
      timestamp:     resp ? resp.at : null
    };
  });

  /* Attendance */
  let attendanceStatus = 'Absent';
  if (att) {
    if (att.override && att.override.status) {
      attendanceStatus = att.override.status;
    } else if (att.status) {
      attendanceStatus = att.status;
    }
  }

  /* Extension health */
  const now = Date.now();
  const lastBeat = hb && hb.at
    ? (typeof hb.at === 'number' ? hb.at : _ts(hb.at))
    : 0;
  const connected = lastBeat > 0 && (now - lastBeat) < HEARTBEAT_DISCONNECT_MS;

  return {
    name:      studentName,
    liveStatus,
    joinedAt:  att ? att.joinTime  || null : null,
    leftAt:    att ? att.leaveTime || null : null,
    attendance: {
      status:    attendanceStatus,
      overrides: att && att.override ? [att.override] : []
    },
    focusLapses,
    participation: {
      answered: participation.answered,
      issued:   participation.issued,
      prompts:  promptDetail
    },
    extension: {
      connected,
      version:         hb ? (hb.version || null) : null,
      lastHeartbeatAt: lastBeat > 0 ? new Date(lastBeat).toISOString() : null,
      detectedName:    hb ? (hb.detectedName || null) : null
    },
    identity: { matched: true }
  };
}

/* ═══════════════════════════════════════════════════════════
   SESSION SUMMARY BUILDER (end-of-class report)
   ═══════════════════════════════════════════════════════════ */

/**
 * Build the end-of-class summary for every roster student in the
 * active section. MUST be called while the session's attendance /
 * focus / prompt data is still loaded in the store (i.e. before the
 * session is marked inactive, which makes the store clear it).
 *
 * @param {import('./store.js').KuwagoState} state
 * @param {string} endedAtIso — class end time (ISO)
 * @returns {{ sessionId, sectionId, startedAt, endedAt, students: Array<Object> }}
 */
export function buildSessionSummary(state, endedAtIso) {
  const { session, students: roster, attendance, focusEvents,
          prompts, responses } = state;

  const sectionId = session ? session.sectionId : null;
  const section   = sectionId ? roster.filter(s => s.sectionId === sectionId) : roster;
  const endMs     = _ts(endedAtIso);

  const students = section.map(rs => {
    const sKey  = sanitizeName(rs.name);
    const att   = attendance[sKey] || null;
    const evts  = focusEvents.filter(e => e.student === sKey);
    const resps = responses.filter(r => r.student === sKey);

    /* Close open attendance at class end for stats */
    const attForStats = att && att.joinTime && !att.leaveTime
      ? { ...att, leaveTime: endedAtIso }
      : att;

    let attendanceStatus = 'Absent';
    if (att) {
      if (att.override && att.override.status) attendanceStatus = att.override.status;
      else if (att.status)                     attendanceStatus = att.status;
    }

    const lapses = computeFocusLapses(attForStats, evts);
    const part   = computeParticipation(attForStats, prompts, resps);

    let attentivenessPct = 0;
    if (att && att.joinTime) {
      const durMs = (att.leaveTime ? _ts(att.leaveTime) : endMs) - _ts(att.joinTime);
      if (durMs > 0) {
        attentivenessPct = Math.max(0, Math.min(100,
          Math.round(100 - (lapses.totalSeconds * 1000 / durMs) * 100)));
      }
    }

    return {
      name:             rs.name,
      timeIn:           att ? att.joinTime  || null : null,
      timeOut:          att ? att.leaveTime || endedAtIso : null,
      attendance:       attendanceStatus,
      attendanceStatus,
      focusLapses:      lapses.count,
      awaySeconds:      lapses.totalSeconds,
      attentivenessPct,
      answered:         part.answered,
      issued:           part.issued,
      participationPct: part.rate
    };
  });

  return {
    sessionId: session ? session.sessionId : null,
    sectionId,
    startedAt: session ? session.startedAt : null,
    endedAt:   endedAtIso,
    students
  };
}

/* ── Helpers ──────────────────────────────────────────────── */

/** Parse a timestamp (ISO string or ms number) to ms number. */
function _ts(v) {
  if (typeof v === 'number') return v;
  return new Date(v).getTime();
}
