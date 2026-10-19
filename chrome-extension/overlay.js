/* ═══════════════════════════════════════════════════════════
   overlay.js — In-page prompt pop-up for Google Meet.

   Shows the professor's active prompt directly on the Meet page
   (phrase + live countdown), collapses to a corner pill, and
   flips to "Answered ✓" when the background worker reports that
   the student's chat reply matched.

   Rendered inside a Shadow DOM so Meet's CSS cannot affect it
   (and ours cannot leak into Meet).

   Messages handled (from background.js):
     ACTIVE_PROMPT   { phrase, expiresAt, issuedAt, answered }
     PROMPT_ANSWERED {}
   ═══════════════════════════════════════════════════════════ */

(() => {
  'use strict';

  if (window.__kuwagoOverlayLoaded) return;
  window.__kuwagoOverlayLoaded = true;

  const MUTE_KEY = 'kuwagoMuted';
  const ANSWERED_LINGER_MS = 3500;

  /* ── State ─────────────────────────────────────────────── */
  let host = null;
  let els = {};
  let prompt = null;        /* { phrase, expiresAtMs, totalMs, id } */
  let answered = false;
  let collapsed = false;
  let muted = false;
  let tickTimer = null;
  let hideTimer = null;
  let audioCtx = null;

  /* ── Mute preference ───────────────────────────────────── */
  try {
    chrome.storage.local.get(MUTE_KEY, (res) => { muted = !!(res && res[MUTE_KEY]); });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[MUTE_KEY]) muted = !!changes[MUTE_KEY].newValue;
    });
  } catch (e) { /* storage unavailable — default to sound on */ }

  /* ── Sounds (WebAudio, no asset files) ─────────────────── */
  function playTones(freqs, duration, volume) {
    if (muted) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const t0 = audioCtx.currentTime;
      freqs.forEach((freq, i) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        const start = t0 + i * 0.14;
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(volume, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(start);
        osc.stop(start + duration + 0.05);
      });
    } catch (e) { /* autoplay blocked or unsupported — stay silent */ }
  }

  const playChime = () => playTones([659.25, 880], 0.35, 0.06);  /* arrival: soft two-note rise */
  const playTick  = () => playTones([1046.5], 0.14, 0.04);       /* answered: single soft tick */

  /* ── DOM construction ──────────────────────────────────── */
  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }

    .wrap {
      position: fixed; top: 16px; right: 16px; z-index: 2147483647;
      font-family: "Plus Jakarta Sans", "Google Sans", "Segoe UI", system-ui, sans-serif;
      color: #f8fafc; pointer-events: none;
      -webkit-font-smoothing: antialiased;
    }
    .card, .pill { pointer-events: auto; }

    /* ── Expanded card ─────────────────────────────────── */
    .card {
      width: 300px;
      padding: 14px 16px 14px;
      border-radius: 16px;
      background: linear-gradient(145deg, #1244ab 0%, #1d61ea 55%, #1e6bf5 100%);
      border: 1px solid rgba(96, 165, 250, .3);
      box-shadow:
        0 20px 48px -12px rgba(16, 45, 115, .65),
        0 4px 12px -2px rgba(0, 0, 0, .2),
        0 0 0 1px rgba(255, 255, 255, .06) inset;
      animation: slideIn .42s cubic-bezier(.16, 1, .3, 1) both;
    }

    /* ── Header row ─────────────────────────────────────── */
    .head {
      display: flex; align-items: center;
      justify-content: space-between;
      margin-bottom: 10px;
    }

    .label {
      display: flex; align-items: center; gap: 7px;
      font-size: 10.5px; font-weight: 700;
      letter-spacing: .08em; text-transform: uppercase;
      color: rgba(255, 255, 255, .75);
    }

    /* Pulsing dot — amber for pending, green for answered */
    .dot {
      width: 7px; height: 7px; border-radius: 50%;
      background: #fbbf24;
      box-shadow: 0 0 0 0 rgba(251, 191, 36, .5);
      animation: pulse 1.6s infinite;
    }

    .btn {
      all: unset; cursor: pointer;
      width: 26px; height: 26px;
      border-radius: 8px;
      display: grid; place-items: center;
      color: rgba(255, 255, 255, .6);
      font-size: 18px; line-height: 1;
      transition: background .15s, color .15s;
    }
    .btn:hover { background: rgba(255, 255, 255, .12); color: white; }
    .btn:focus-visible { outline: 2px solid rgba(255, 255, 255, .5); }

    /* ── Instruction hint ────────────────────────────────── */
    .hint {
      font-size: 11.5px;
      color: rgba(255, 255, 255, .6);
      margin-bottom: 8px;
      font-weight: 500;
    }

    /* ── Phrase chip ─────────────────────────────────────── */
    .phrase {
      font-size: 20px; font-weight: 800;
      line-height: 1.3; word-break: break-word;
      padding: 10px 13px;
      border-radius: 12px;
      background: rgba(0, 0, 0, .22);
      border: 1px solid rgba(255, 255, 255, .14);
      color: #fff;
      letter-spacing: -0.01em;
    }

    /* ── Footer: time ────────────────────────────────────── */
    .foot {
      display: flex; align-items: center;
      justify-content: space-between;
      margin-top: 11px;
      font-size: 11.5px;
      color: rgba(255, 255, 255, .6);
    }
    .time {
      font-variant-numeric: tabular-nums;
      font-weight: 800;
      font-size: 14px;
      color: #fff;
    }

    /* ── Progress bar ────────────────────────────────────── */
    .bar {
      height: 3px;
      border-radius: 99px;
      background: rgba(255, 255, 255, .15);
      margin-top: 9px;
      overflow: hidden;
    }
    .fill {
      height: 100%; width: 100%;
      border-radius: 99px;
      background: linear-gradient(90deg, #60a5fa, #93c5fd);
      transition: width .25s linear;
    }

    /* ── Collapsed pill ──────────────────────────────────── */
    .pill {
      all: unset; cursor: pointer;
      display: none; align-items: center; gap: 8px;
      padding: 8px 14px;
      border-radius: 999px;
      max-width: 260px;
      background: linear-gradient(135deg, #1244ab, #1d61ea);
      border: 1px solid rgba(96, 165, 250, .35);
      box-shadow: 0 10px 28px -8px rgba(16, 45, 115, .55);
      font-size: 12.5px; font-weight: 700;
      color: #fff;
      animation: slideIn .32s cubic-bezier(.16, 1, .3, 1) both;
    }
    .pill:focus-visible { outline: 2px solid rgba(255,255,255,.5); }
    .pill .ptime {
      font-variant-numeric: tabular-nums;
      font-weight: 800;
    }
    .pill .pphrase {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: rgba(255, 255, 255, .7);
      font-weight: 600;
    }

    /* ── Collapsed state ─────────────────────────────────── */
    .wrap.collapsed .card { display: none; }
    .wrap.collapsed .pill { display: inline-flex; }

    /* ── Answered state (green) ──────────────────────────── */
    .wrap.answered .card {
      background: linear-gradient(145deg, #064e3b 0%, #065f46 60%, #047857 100%);
      border-color: rgba(110, 231, 183, .4);
    }
    .wrap.answered .pill {
      background: linear-gradient(135deg, #064e3b, #065f46);
      border-color: rgba(110, 231, 183, .4);
    }
    .wrap.answered .dot {
      background: #34d399;
      box-shadow: 0 0 0 0 rgba(52, 211, 153, 0);
      animation: none;
    }
    .wrap.answered .label,
    .wrap.answered .hint,
    .wrap.answered .foot { color: rgba(167, 243, 208, .8); }
    .wrap.answered .fill {
      background: #34d399;
      width: 100% !important;
    }
    .wrap.answered .pill .pphrase { color: rgba(167, 243, 208, .75); }

    /* ── Animations ──────────────────────────────────────── */
    @keyframes slideIn {
      from { opacity: 0; transform: translateY(-12px) scale(.97); }
      to   { opacity: 1; transform: none; }
    }
    @keyframes pulse {
      0%   { box-shadow: 0 0 0 0 rgba(251, 191, 36, .5); }
      70%  { box-shadow: 0 0 0 7px rgba(251, 191, 36, 0); }
      100% { box-shadow: 0 0 0 0 rgba(251, 191, 36, 0); }
    }

    @media (prefers-reduced-motion: reduce) {
      .card, .pill { animation: none; }
      .dot { animation: none; }
      .fill { transition: none; }
    }
  `;


  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function build() {
    if (host) return;

    host = document.createElement('div');
    host.id = 'kuwago-prompt-overlay';
    const root = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = CSS;

    const wrap = el('div', 'wrap');
    wrap.setAttribute('role', 'alert');
    wrap.setAttribute('aria-live', 'assertive');

    /* Expanded card */
    const card = el('div', 'card');
    const head = el('div', 'head');
    const label = el('div', 'label');
    label.appendChild(el('span', 'dot'));
    const labelText = el('span', null, 'Prompt from your professor');
    label.appendChild(labelText);
    const collapseBtn = el('button', 'btn', '–');
    collapseBtn.type = 'button';
    collapseBtn.title = 'Minimize';
    collapseBtn.setAttribute('aria-label', 'Minimize prompt');
    collapseBtn.addEventListener('click', () => setCollapsed(true));
    head.appendChild(label);
    head.appendChild(collapseBtn);

    const hint = el('div', 'hint', 'Type this in the Meet chat:');
    const phrase = el('div', 'phrase');

    const foot = el('div', 'foot');
    const footLabel = el('span', null, 'Time left');
    const time = el('span', 'time');
    foot.appendChild(footLabel);
    foot.appendChild(time);

    const bar = el('div', 'bar');
    const fill = el('div', 'fill');
    bar.appendChild(fill);

    card.append(head, hint, phrase, foot, bar);

    /* Collapsed pill */
    const pill = el('button', 'pill');
    pill.type = 'button';
    pill.title = 'Show prompt';
    pill.setAttribute('aria-label', 'Show prompt');
    const pillIcon = el('span', 'dot');
    const pillTime = el('span', 'ptime');
    const pillPhrase = el('span', 'pphrase');
    pill.append(pillIcon, pillTime, pillPhrase);
    pill.addEventListener('click', () => setCollapsed(false));

    wrap.append(card, pill);
    root.append(style, wrap);

    els = { wrap, labelText, hint, phrase, footLabel, time, fill, pillTime, pillPhrase };
    document.documentElement.appendChild(host);
  }

  /* ── Rendering ─────────────────────────────────────────── */
  function formatTime(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return m + ':' + String(s).padStart(2, '0');
  }

  function render() {
    if (!prompt) return;
    build();

    els.wrap.classList.toggle('collapsed', collapsed);
    els.wrap.classList.toggle('answered', answered);
    els.phrase.textContent = '"' + prompt.phrase + '"';
    els.pillPhrase.textContent = '"' + prompt.phrase + '"';

    if (answered) {
      els.labelText.textContent = 'Answered';
      els.hint.textContent = 'Your reply was received.';
      els.footLabel.textContent = 'Thanks!';
      els.time.textContent = '✓';
      els.pillTime.textContent = '✓ Answered';
      els.pillPhrase.textContent = '';
      return;
    }

    els.labelText.textContent = 'Prompt from your professor';
    els.hint.textContent = 'Type this in the Meet chat:';
    els.footLabel.textContent = 'Time left';
    updateCountdown();
  }

  function updateCountdown() {
    if (!prompt || answered) return;
    const remaining = prompt.expiresAtMs - Date.now();

    if (remaining <= 0) {
      clearPrompt();
      return;
    }

    els.time.textContent = formatTime(remaining);
    els.pillTime.textContent = formatTime(remaining);
    const pct = Math.min(100, Math.max(0, (remaining / prompt.totalMs) * 100));
    els.fill.style.width = pct + '%';
  }

  function setCollapsed(value) {
    collapsed = value;
    if (els.wrap) els.wrap.classList.toggle('collapsed', collapsed);
  }

  /* ── Lifecycle ─────────────────────────────────────────── */
  function clearPrompt() {
    clearInterval(tickTimer);
    clearTimeout(hideTimer);
    tickTimer = null;
    hideTimer = null;
    prompt = null;
    answered = false;
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = null;
    els = {};
  }

  function parseMs(value) {
    const t = value ? new Date(value).getTime() : NaN;
    return Number.isFinite(t) ? t : NaN;
  }

  function showPrompt(msg) {
    const expiresAtMs = parseMs(msg.expiresAt);
    const id = (msg.issuedAt || '') + '|' + msg.phrase;
    const isNew = !prompt || prompt.id !== id;

    if (!isNew) return; /* Same prompt already showing — keep local state */

    clearPrompt();

    /* Prompts without a valid expiry still show for a safe default window. */
    const end = Number.isFinite(expiresAtMs) ? expiresAtMs : Date.now() + 60000;
    if (end <= Date.now()) return;

    const issuedMs = parseMs(msg.issuedAt);
    const total = Number.isFinite(issuedMs) && end > issuedMs ? end - issuedMs : end - Date.now();

    prompt = { phrase: msg.phrase, expiresAtMs: end, totalMs: Math.max(total, 1000), id };
    answered = !!msg.answered;
    collapsed = false;

    render();
    tickTimer = setInterval(updateCountdown, 250);

    if (answered) {
      scheduleHide();
    } else {
      playChime();
    }
  }

  function markAnswered() {
    if (!prompt || answered) return;
    answered = true;
    collapsed = false;
    render();
    playTick();
    scheduleHide();
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(clearPrompt, ANSWERED_LINGER_MS);
  }

  /* ── Message wiring ────────────────────────────────────── */
  chrome.runtime.onMessage.addListener((message) => {
    switch (message && message.type) {
      case 'ACTIVE_PROMPT':
        if (message.phrase) {
          showPrompt(message);
        } else {
          clearPrompt();
        }
        break;
      case 'PROMPT_ANSWERED':
        markAnswered();
        break;
    }
    /* No response sent; do not keep the channel open. */
  });
})();
