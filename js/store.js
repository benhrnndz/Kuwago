/* ═══════════════════════════════════════════════════════════
   store.js — Realtime Database listeners and reactive state.

   Subscribes to RTDB paths with Firebase .on() listeners,
   maintains a single state object, and calls the registered
   onUpdate callback on every change. The dashboard replaces
   its 5-second poll loop with this module.

   Usage:
     initStore(state => renderAll(buildDashboardData(state)));
     writeToDb('kuwago/activeSession', { ... });
   ═══════════════════════════════════════════════════════════ */

import { getDb } from './firebase.js';
import { isMockMode } from './mock.js';

/* ── State ────────────────────────────────────────────────── */

/**
 * @typedef {Object} KuwagoState
 * @property {{ active: boolean, sessionId?: string, sectionId?: string, startedAt?: string }|null} session
 * @property {Array<{ sectionId: string, courseName: string, sectionName: string }>} courses
 * @property {Array<{ sectionId: string, key: string, name: string, aliases: string[] }>} students
 * @property {Object.<string, { joinTime: string, leaveTime?: string, status: string, override?: Object, matched: boolean }>} attendance
 * @property {Array<{ id: string, student: string, type: string, at: string }>} focusEvents
 * @property {Object.<string, { phrase: string, issuedAt: string, expiresAt: string, active: boolean }>} prompts
 * @property {Array<{ id: string, student: string, promptId: string, text: string, matched: boolean, at: string }>} responses
 * @property {Object.<string, { detectedName: string, version: string, at: number }>} heartbeats
 * @property {Object.<string, { canonical: string }>} aliases
 */

/** @type {KuwagoState} */
let _state = {
  session:     null,
  courses:     [],
  students:    [],
  attendance:  {},
  focusEvents: [],
  prompts:     {},
  responses:   [],
  heartbeats:  {},
  aliases:     {}
};

let _onUpdate        = null;
let _globalListeners = [];   /* [{ ref, event, cb }] */
let _sessionListeners = [];  /* same — torn down on session change */
let _currentSessionId = null;

/* ── Public: Init ─────────────────────────────────────────── */

/**
 * Attach all RTDB listeners and start streaming state.
 * @param {function(KuwagoState): void} onUpdate
 *   Called with a shallow copy of state on every change.
 */
export function initStore(onUpdate) {
  if (isMockMode()) return;

  /* Re-init safe: drop any old (possibly permission-cancelled) listeners */
  stopStore();

  _onUpdate = onUpdate;
  const db = getDb();

  /* ── Courses + Students ─────────────────────────────────── */
  _listen(db.ref('kuwago/courses'), 'value', (snap) => {
    const val = snap.val() || {};
    const courses  = [];
    const students = [];

    for (const [sectionId, course] of Object.entries(val)) {
      courses.push({
        sectionId,
        courseName:  course.courseName  || '',
        sectionName: course.sectionName || ''
      });

      if (course.students) {
        for (const [key, s] of Object.entries(course.students)) {
          students.push({
            sectionId,
            key,
            name:    s.name    || key,
            aliases: s.aliases || []
          });
        }
      }
    }

    _state.courses  = courses;
    _state.students = students;
    _notify();
  });

  /* ── Active Session ─────────────────────────────────────── */
  _listen(db.ref('kuwago/activeSession'), 'value', (snap) => {
    const val = snap.val();

    if (val && val.active) {
      _state.session = {
        active:     true,
        sessionId:  val.sessionId  || '',
        sectionId:  val.sectionId  || '',
        startedAt:  val.startedAt  || ''
      };
      _subscribeToSession(val.sessionId);
    } else {
      _state.session = { active: false };
      _unsubscribeFromSession();
    }

    _notify();
  });

  /* ── Heartbeats (global, not session-scoped) ────────────── */
  _listen(db.ref('kuwago/heartbeats'), 'value', (snap) => {
    _state.heartbeats = snap.val() || {};
    _notify();
  });

  /* ── Aliases (global) ───────────────────────────────────── */
  _listen(db.ref('kuwago/aliases'), 'value', (snap) => {
    _state.aliases = snap.val() || {};
    _notify();
  });
}

/**
 * Detach every listener and reset state to empty.
 * Called on sign-out, and before re-initialising on sign-in.
 */
export function stopStore() {
  _unsubscribeFromSession();
  for (const { ref, event, cb } of _globalListeners) ref.off(event, cb);
  _globalListeners = [];

  _state.session    = null;
  _state.courses    = [];
  _state.students   = [];
  _state.heartbeats = {};
  _state.aliases    = {};
}

/* ── Session-Scoped Listeners ─────────────────────────────── */

function _subscribeToSession(sessionId) {
  if (_currentSessionId === sessionId) return;  /* Already subscribed */
  _unsubscribeFromSession();
  _currentSessionId = sessionId;

  const db   = getDb();
  const base = `kuwago/classSessions/${sessionId}`;

  /* Attendance */
  _sessionListen(db.ref(`${base}/attendance`), 'value', (snap) => {
    _state.attendance = snap.val() || {};
    _notify();
  });

  /* Focus Events */
  _sessionListen(db.ref(`${base}/focusEvents`), 'value', (snap) => {
    const val = snap.val() || {};
    _state.focusEvents = Object.entries(val).map(([id, e]) => ({ id, ...e }));
    _notify();
  });

  /* Prompts */
  _sessionListen(db.ref(`${base}/prompts`), 'value', (snap) => {
    _state.prompts = snap.val() || {};
    _notify();
  });

  /* Responses */
  _sessionListen(db.ref(`${base}/responses`), 'value', (snap) => {
    const val = snap.val() || {};
    _state.responses = Object.entries(val).map(([id, r]) => ({ id, ...r }));
    _notify();
  });
}

function _unsubscribeFromSession() {
  for (const { ref, event, cb } of _sessionListeners) ref.off(event, cb);
  _sessionListeners = [];
  _currentSessionId = null;

  /* Reset session-scoped state */
  _state.attendance  = {};
  _state.focusEvents = [];
  _state.prompts     = {};
  _state.responses   = [];
}

/* ── Listener Helpers ─────────────────────────────────────── */

function _listen(ref, event, cb) {
  ref.on(event, cb, (err) => {
    console.error(`[store] Listener error on ${ref.toString()}:`, err.message);
  });
  _globalListeners.push({ ref, event, cb });
}

function _sessionListen(ref, event, cb) {
  ref.on(event, cb, (err) => {
    console.error(`[store] Session listener error on ${ref.toString()}:`, err.message);
  });
  _sessionListeners.push({ ref, event, cb });
}

function _notify() {
  if (_onUpdate) _onUpdate({ ..._state });
}

/* ── Public: State Read ───────────────────────────────────── */

/**
 * Get a shallow copy of the current state snapshot.
 * @returns {KuwagoState}
 */
export function getState() {
  return { ..._state };
}

/* ── Public: Write Helpers ────────────────────────────────── */

/**
 * Set (overwrite) a value at an RTDB path.
 * @param {string} path
 * @param {*} data
 * @returns {Promise}
 */
export function writeToDb(path, data) {
  return getDb().ref(path).set(data);
}

/**
 * Update specific fields at an RTDB path (merge, not overwrite).
 * @param {string} path
 * @param {Object} data
 * @returns {Promise}
 */
export function updateDb(path, data) {
  return getDb().ref(path).update(data);
}

/**
 * Push a new child to a list at the RTDB path.
 * Returns a Promise that resolves to the new child's key.
 * @param {string} path
 * @param {*} data
 * @returns {Promise<string>} the new push key
 */
export async function pushToDb(path, data) {
  const ref = await getDb().ref(path).push(data);
  return ref.key;
}

/**
 * Remove data at a specific RTDB path.
 * @param {string} path
 * @returns {Promise}
 */
export function removeFromDb(path) {
  return getDb().ref(path).remove();
}

/**
 * Perform multiple writes atomically.
 * @param {Object.<string, *>} updates  e.g. { 'kuwago/activeSession/active': false }
 * @returns {Promise}
 */
export function multiUpdate(updates) {
  return getDb().ref().update(updates);
}

/**
 * Firebase server timestamp placeholder.
 * Use as a value in writes: { at: serverTimestamp() }
 * @returns {Object}
 */
export function serverTimestamp() {
  return firebase.database.ServerValue.TIMESTAMP;
}

/**
 * Generate a new push key without writing.
 * Useful for creating IDs before a multi-path write.
 * @param {string} path
 * @returns {string}
 */
export function newKey(path) {
  return getDb().ref(path).push().key;
}

/**
 * Read a path once (no persistent listener).
 * @param {string} path
 * @returns {Promise<*>}
 */
export async function readOnce(path) {
  const snap = await getDb().ref(path).once('value');
  return snap.val();
}
