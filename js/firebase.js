/* ═══════════════════════════════════════════════════════════
   firebase.js — Firebase app init, Auth (Google Sign-In),
   and RTDB reference exports.

   Uses the Firebase compat CDN SDK (loaded via <script> tags
   in index.html before any ES module is executed).
   ═══════════════════════════════════════════════════════════ */

import { isMockMode } from './mock.js';

/* ── Firebase Config ──────────────────────────────────────── */
/* Public client config — safe to commit. */
const FIREBASE_CONFIG = {
  apiKey:            'AIzaSyAKln9uIm0uPTWloVmQWUK715WkxhfunNY',
  authDomain:        'kuwago-d6c14.firebaseapp.com',
  databaseURL:       'https://kuwago-d6c14-default-rtdb.asia-southeast1.firebasedatabase.app',
  projectId:         'kuwago-d6c14',
  storageBucket:     'kuwago-d6c14.firebasestorage.app',
  messagingSenderId: '250909872237',
  appId:             '1:250909872237:web:a848fbdf3aa7f10e686f64',
  measurementId:     'G-HF7N77M5GF'
};

/* ── Module State ─────────────────────────────────────────── */
let _app  = null;
let _db   = null;
let _auth = null;
let _user = null;

let _authResolved        = false;
let _authReadyCallbacks  = [];
let _authChangeCallbacks = [];

/* ── Init ─────────────────────────────────────────────────── */

/**
 * Initialize Firebase app, Auth, and RTDB.
 * No-op in ?mock=true mode.
 * @returns {Promise<firebase.User|null>} Resolves once auth state is known.
 */
export function initFirebase() {
  if (isMockMode()) return Promise.resolve(null);

  _app  = firebase.initializeApp(FIREBASE_CONFIG);
  _auth = firebase.auth();
  _db   = firebase.database();

  return new Promise((resolve) => {
    _auth.onAuthStateChanged((user) => {
      _user         = user;
      _authResolved = true;
      _updateAuthUI(user);

      /* Flush any callbacks that were registered before auth resolved */
      const pending = _authReadyCallbacks.slice();
      _authReadyCallbacks = [];
      for (const cb of pending) cb(user);

      /* Notify persistent subscribers on every sign-in / sign-out */
      for (const cb of _authChangeCallbacks) cb(user);

      resolve(user);
    });
  });
}

/* ── Accessors ────────────────────────────────────────────── */

/** Get the RTDB Database instance. */
export function getDb() { return _db; }

/** Get the Firebase Auth instance. */
export function getAuth() { return _auth; }

/** Get the currently signed-in professor (or null). */
export function getCurrentUser() { return _user; }

/**
 * Register a callback that fires once auth state is first known.
 * If auth is already resolved, fires immediately (synchronously).
 * @param {Function} cb - called with (user: firebase.User|null)
 */
export function onAuthReady(cb) {
  if (_authResolved) {
    cb(_user);
    return;
  }
  _authReadyCallbacks.push(cb);
}

/**
 * Subscribe to every auth state change (sign-in AND sign-out).
 * Fires immediately with the current user if auth is already resolved.
 * @param {Function} cb - called with (user: firebase.User|null)
 */
export function onAuthChange(cb) {
  _authChangeCallbacks.push(cb);
  if (_authResolved) cb(_user);
}

/* ── Auth Actions ─────────────────────────────────────────── */

/**
 * Open a Google Sign-In popup.
 * Professor authenticates with their school Google account.
 */
export async function signInWithGoogle() {
  if (!_auth) return;
  const provider = new firebase.auth.GoogleAuthProvider();
  try {
    await _auth.signInWithPopup(provider);
  } catch (err) {
    console.error('[firebase] Google sign-in failed:', err.code, err.message);

    const hints = {
      'auth/configuration-not-found':
        'Firebase Authentication is not set up. In the Firebase console go to Authentication → Get started, then enable the Google provider.',
      'auth/operation-not-allowed':
        'The Google sign-in provider is disabled. Enable it in Firebase console → Authentication → Sign-in method.',
      'auth/unauthorized-domain':
        `This domain (${location.hostname}) is not authorized. Add it in Firebase console → Authentication → Settings → Authorized domains.`,
      'auth/popup-blocked':
        'The sign-in popup was blocked by the browser. Allow popups for this site and try again.'
    };

    /* User closing the popup is not an error worth alerting */
    if (err.code === 'auth/popup-closed-by-user' || err.code === 'auth/cancelled-popup-request') return;

    alert(`Sign-in failed (${err.code}).\n\n${hints[err.code] || err.message}`);
  }
}

/** Sign the professor out. */
export async function signOut() {
  if (!_auth) return;
  try {
    await _auth.signOut();
  } catch (err) {
    console.error('[firebase] Sign-out failed:', err.message);
  }
}

/* ── Auth UI Helper ───────────────────────────────────────── */

function _updateAuthUI(user) {
  const signInBtn = document.getElementById('btn-google-signin');
  const userEl    = document.getElementById('auth-user-name');
  const avatarEl  = document.querySelector('.avatar');
  const nameEl    = document.querySelector('.professor-name');

  if (user) {
    if (signInBtn) signInBtn.style.display = 'none';
    if (userEl)    { userEl.style.display = ''; userEl.textContent = ''; }

    /* Update the topbar professor display */
    if (nameEl)   nameEl.textContent  = user.displayName || user.email || 'Professor';
    if (avatarEl) avatarEl.textContent = (user.displayName || user.email || 'P')[0].toUpperCase();
  } else {
    if (signInBtn) signInBtn.style.display = '';
    if (userEl)    userEl.style.display = 'none';
    if (nameEl)    nameEl.textContent  = 'Professor';
    if (avatarEl)  avatarEl.textContent = 'P';
  }
}

/* ── Shared Key Sanitizer ─────────────────────────────────── */

/**
 * Sanitize any string for use as an RTDB key.
 * RTDB keys cannot contain: . $ # [ ] /
 *
 * Examples:
 *   "Dela Cruz, Juan A." → "dela_cruz_juan_a"
 *   "Juan Dela Cruz"     → "juan_dela_cruz"
 *
 * @param {string} name
 * @returns {string}
 */
export function sanitizeName(name) {
  return String(name)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')     /* strip diacritics: ñ → n */
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .sort()                                /* order-insensitive: "Last, First" == "First Last" */
    .join('_');
}
