/* ═══════════════════════════════════════════════════════════
   toast.js — Sonner-inspired Toast Notification System
   Crafted following Emil Kowalski's micro-interaction principles:
   - Spring-like physics (cubic-bezier out-expo)
   - Tactile interactive dismiss
   - Stacked visual depth
   - Non-blocking notifications with icons
   ═══════════════════════════════════════════════════════════ */

let _container = null;
const TOAST_TIMEOUT_MS = 3800;

function ensureContainer() {
  if (_container && document.body.contains(_container)) return _container;
  
  _container = document.createElement('div');
  _container.id = 'kuwago-toast-container';
  _container.className = 'toast-container';
  _container.setAttribute('aria-live', 'polite');
  _container.setAttribute('aria-atomic', 'true');
  document.body.appendChild(_container);
  return _container;
}

const ICONS = {
  success: `<svg class="toast-icon toast-icon--success" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
    <polyline points="22 4 12 14.01 9 11.01" />
  </svg>`,
  info: `<svg class="toast-icon toast-icon--info" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="10" />
    <line x1="12" y1="16" x2="12" y2="12" />
    <line x1="12" y1="8" x2="12.01" y2="8" />
  </svg>`,
  warning: `<svg class="toast-icon toast-icon--warning" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
    <line x1="12" y1="9" x2="12" y2="13" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </svg>`,
  error: `<svg class="toast-icon toast-icon--error" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="10" />
    <line x1="15" y1="9" x2="9" y2="15" />
    <line x1="9" y1="9" x2="15" y2="15" />
  </svg>`
};

/**
 * Show a toast notification
 * @param {string} title
 * @param {string} [description]
 * @param {'success'|'info'|'warning'|'error'} [type='info']
 * @param {number} [duration=TOAST_TIMEOUT_MS]
 */
export function showToast(title, description = '', type = 'info', duration = TOAST_TIMEOUT_MS) {
  const container = ensureContainer();
  
  const toast = document.createElement('div');
  toast.className = `toast-item toast-item--${type}`;
  toast.setAttribute('role', 'status');

  const iconSvg = ICONS[type] || ICONS.info;

  toast.innerHTML = `
    <div class="toast-content">
      <div class="toast-icon-wrap">${iconSvg}</div>
      <div class="toast-text">
        <div class="toast-title">${escapeHtml(title)}</div>
        ${description ? `<div class="toast-desc">${escapeHtml(description)}</div>` : ''}
      </div>
    </div>
    <button class="toast-close" aria-label="Dismiss notification">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="18" y1="6" x2="6" y2="18"></line>
        <line x1="6" y1="6" x2="18" y2="18"></line>
      </svg>
    </button>
  `;

  let timeoutId = null;

  function dismiss() {
    if (toast.classList.contains('toast--dismissing')) return;
    toast.classList.add('toast--dismissing');
    if (timeoutId) clearTimeout(timeoutId);
    
    // Remove after exit transition completes
    setTimeout(() => {
      if (toast.parentNode) {
        toast.parentNode.removeChild(toast);
      }
    }, 180);
  }

  // Dismiss button
  const closeBtn = toast.querySelector('.toast-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dismiss();
    });
  }

  // Click toast to dismiss
  toast.addEventListener('click', () => dismiss());

  // Pause on hover
  toast.addEventListener('mouseenter', () => {
    if (timeoutId) clearTimeout(timeoutId);
  });
  toast.addEventListener('mouseleave', () => {
    if (duration > 0) {
      timeoutId = setTimeout(dismiss, 1200);
    }
  });

  // Limit stacked toasts to max 4
  const existingToasts = container.querySelectorAll('.toast-item:not(.toast--dismissing)');
  if (existingToasts.length >= 4) {
    const oldest = existingToasts[0];
    if (oldest) oldest.querySelector('.toast-close')?.click() || oldest.remove();
  }

  container.appendChild(toast);

  // Trigger enter animation on next frame
  requestAnimationFrame(() => {
    toast.classList.add('toast--visible');
  });

  if (duration > 0) {
    timeoutId = setTimeout(dismiss, duration);
  }

  return { dismiss };
}

export const toast = {
  success: (title, desc, duration) => showToast(title, desc, 'success', duration),
  info:    (title, desc, duration) => showToast(title, desc, 'info', duration),
  warning: (title, desc, duration) => showToast(title, desc, 'warning', duration),
  error:   (title, desc, duration) => showToast(title, desc, 'error', duration)
};

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

