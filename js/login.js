/* ═══════════════════════════════════════════════════════════
   login.js — Firebase Auth for the Kuwago Login Page
   Handles Google Sign-In and redirects to the dashboard
   on success.
   ═══════════════════════════════════════════════════════════ */

/* ── Firebase Config (same as firebase.js) ─────────────── */
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

/* ── DOM References ────────────────────────────────────── */
const googleBtn = document.getElementById('btn-google-signin');
const errorEl   = document.getElementById('login-error');
const card      = document.getElementById('login-card');

/* ── Init Firebase ─────────────────────────────────────── */
const app  = firebase.initializeApp(FIREBASE_CONFIG);
const auth = firebase.auth();

/* Check for mock mode — skip auth entirely */
const urlParams = new URLSearchParams(window.location.search);
if (urlParams.get('mock') === 'true') {
  window.location.replace('index.html?mock=true');
}

/* ── If already signed in, skip login page ─────────────── */
auth.onAuthStateChanged((user) => {
  if (user) {
    /* Already authenticated — go straight to dashboard */
    card?.classList.add('is-success');
    setTimeout(() => {
      window.location.replace('index.html');
    }, 400);
  }
});

/* ── Google Sign-In Handler ────────────────────────────── */
googleBtn?.addEventListener('click', async () => {
  /* Show loading state */
  googleBtn.classList.add('is-loading');
  googleBtn.querySelector('span').textContent = 'Signing in…';
  hideError();

  const provider = new firebase.auth.GoogleAuthProvider();
  /* Request Sheets + Drive scopes so the dashboard can write reports to the professor's Drive */
  provider.addScope('https://www.googleapis.com/auth/spreadsheets');
  provider.addScope('https://www.googleapis.com/auth/drive.file');

  try {
    const result = await auth.signInWithPopup(provider);
    /* Capture the Google OAuth access token and persist it for index.html to use.
       NOTE: result.credential.accessToken is the compat-SDK way (not credentialFromResult). */
    const token = result.credential?.accessToken;
    if (token) {
      const TTL = 55 * 60 * 1000; /* 55 min */
      try {
        sessionStorage.setItem('_kuwago_gat',     token);
        sessionStorage.setItem('_kuwago_gat_exp', String(Date.now() + TTL));
      } catch { /* private browsing */ }
    }
    /* onAuthStateChanged above will handle redirect */
  } catch (err) {
    googleBtn.classList.remove('is-loading');
    googleBtn.querySelector('span').textContent = 'Sign in with Google';

    /* User closing the popup is not an error */
    if (err.code === 'auth/popup-closed-by-user' ||
        err.code === 'auth/cancelled-popup-request') {
      return;
    }

    const hints = {
      'auth/configuration-not-found':
        'Firebase Authentication is not set up. Enable the Google provider in the Firebase console.',
      'auth/operation-not-allowed':
        'The Google sign-in provider is disabled. Enable it in Firebase console → Authentication → Sign-in method.',
      'auth/unauthorized-domain':
        `This domain (${location.hostname}) is not authorized. Add it in Firebase console → Authentication → Settings → Authorized domains.`,
      'auth/popup-blocked':
        'The sign-in popup was blocked by your browser. Please allow popups for this site and try again.',
      'auth/network-request-failed':
        'Network error. Please check your internet connection and try again.'
    };

    showError(hints[err.code] || `Sign-in failed: ${err.message}`);
    console.error('[login] Google sign-in failed:', err.code, err.message);
  }
});

/* ── Error Helpers ─────────────────────────────────────── */
function showError(msg) {
  if (!errorEl) return;
  errorEl.textContent = msg;
  errorEl.hidden = false;
}

function hideError() {
  if (!errorEl) return;
  errorEl.hidden = true;
}
