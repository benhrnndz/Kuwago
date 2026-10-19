# Chrome Extension Guide

The `chrome-extension/` directory contains a Manifest V3 browser extension designed to run in each student's browser during a Google Meet session, streaming live focus, attendance, and chat participation telemetry directly into the Firebase Realtime Database.

---

## Architectural Responsibilities

| Responsibility | Implementation Mechanism |
|---|---|
| **Self-Name Detection** | `content.js` inspects Google Meet's DOM participant elements with fallback selector heuristics. |
| **Tab & Window Focus Tracking** | `background.js` combines `chrome.tabs.onActivated` and `chrome.windows.onFocusChanged` with a 1.5-second debounce. |
| **Direct RTDB REST Logging** | `background.js` writes events directly to Firebase RTDB via HTTPS REST calls (`PUT`/`PATCH`/`POST`). |
| **In-Meeting Prompt HUD** | `overlay.js` renders a non-intrusive floating countdown banner directly inside the Google Meet viewport during active prompts. |
| **Pre-Session Join Tracking** | Caches arrival events if a student joins before the professor clicks **Start Class**, syncing immediately upon session start. |
| **Health Heartbeats** | Periodic 15-second beacon (`PUT /kuwago/heartbeats/{studentKey}.json`) reporting extension vitality and version. |
| **Order-Insensitive Name Matching** | Normalizes name tokens so `LastName, FirstName` aligns with `FirstName LastName` on the canonical roster. |

---

## Directory Structure

```
chrome-extension/
├── manifest.json       # MV3 permissions, host permissions, and scripts
├── content.js          # Injected into meet.google.com DOM (identity detection, chat listener)
├── overlay.js          # Injected into meet.google.com DOM (prompt HUD banner)
├── background.js       # Background service worker (heartbeats, focus, RTDB REST client)
├── popup.html          # Toolbar popup UI (royal blue brand theme with RTDB status badge)
├── popup.js            # Toolbar popup logic
└── icons/              # Extension icon assets (16x16, 48x48, 128x128)
```

---

## How Focus Tracking Works

To prevent false alarms caused by quick window clicks, Alt-Tab glances, or OS notifications, Kuwago utilizes a dual-signal debouncing algorithm:

```
[Tab Activation Event]   ──┐
                           ├─► Debounce Window (1,500ms) ─► Agreement Check ─► Dispatch Event
[Window Focus Event]     ──┘
```

1. **State Aggregation**: The background service worker listens to both `chrome.tabs.onActivated` (tab switches) and `chrome.windows.onFocusChanged` (app/window switches).
2. **Debounce Buffer**: When focus changes away from the active Google Meet tab, an event is scheduled with a 1,500ms delay.
3. **Cancellation**: If the student returns to the Meet tab within 1,500ms, the pending `focus_lost` event is cancelled and discarded.
4. **Dispatch**: If the student remains away, a `focus_lost` event is dispatched directly to the Firebase Realtime Database.

---

## In-Meeting Prompt HUD Overlay (`overlay.js`)

When the professor issues a verification prompt from the dashboard:
1. `background.js` detects the active prompt from RTDB and dispatches a message to `content.js` / `overlay.js`.
2. `overlay.js` injects a floating glassmorphic banner at the top of the Google Meet viewport displaying:
   - The required prompt phrase (e.g. `"focus"`).
   - An animated countdown timer ticking down to expiration.
   - An instruction to type the phrase in the in-meeting chat.
3. When the student types the response in Meet chat, the `MutationObserver` in `content.js` captures the text, matches the phrase, pushes the response to RTDB, and closes the overlay banner with a green checkmark confirmation.

---

## Pre-Session Join Tracking

If students arrive early in Google Meet before the professor starts the class session:
1. `background.js` detects the presence and records the join timestamp in local `chrome.storage`.
2. As soon as the professor clicks **Start Class**, the session state in RTDB switches to `active: true`.
3. The extension immediately syncs the cached join timestamp into `kuwago/classSessions/{sessionId}/attendance/{studentKey}`, ensuring students are correctly credited as `Present` rather than being penalized.

---

## Heartbeat Health Engine

To differentiate between a student who closed their tab and a student whose extension crashed or was disabled:
- Every 15 seconds, `background.js` pulses a health check to the Firebase RTDB REST endpoint:
  ```json
  PUT https://kuwago-d6c14-default-rtdb.asia-southeast1.firebasedatabase.app/kuwago/heartbeats/{studentKey}.json
  {
    "detectedName": "Juan Dela Cruz",
    "version": "2.0.0",
    "timestamp": "2026-10-19T06:00:00.000Z"
  }
  ```
- The dashboard listens to `kuwago/heartbeats` in real time. If no heartbeat has been received within the threshold (default: 45s), the student's status is marked as **Disconnected**.

---

## Permissions Rationale

| Permission | Justification |
|---|---|
| `activeTab` | Injects content scripts upon navigating to Google Meet. |
| `scripting` | Enables programmatic DOM observation on Meet tabs. |
| `tabs` | Allows background service worker to detect tab switching. |
| `notifications` | Displays optional Chrome desktop notifications for verification prompts. |
| `storage` | Persists pre-session join timestamps and local student settings. |
| `windows` | Monitors window focus transitions to track multi-monitor applications. |
| `host_permissions: https://meet.google.com/*` | Grants execution rights on all Google Meet rooms. |
| `host_permissions: https://kuwago-d6c14-default-rtdb.asia-southeast1.firebasedatabase.app/*` | Authorizes background REST API calls to Firebase RTDB without CORS restrictions. |
| `host_permissions: https://identitytoolkit.googleapis.com/*` | Enables optional Firebase client auth token refresh. |

*Note: Kuwago strictly adheres to privacy standards. The extension does not record video, microphone streams, or browse history outside `meet.google.com`.*

---

## Configuration & Installation

### 1. Database Configuration
In `background.js`, `RTDB_BASE` points to the production Firebase Realtime Database:
```javascript
const RTDB_BASE = 'https://kuwago-d6c14-default-rtdb.asia-southeast1.firebasedatabase.app';
```

### 2. Install Unpacked Extension
1. Open Google Chrome and go to `chrome://extensions`.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** (top-left).
4. Select the `chrome-extension/` directory.
5. Click the extension toolbar icon. The popup should display a green **Ready** badge.

### 3. Reloading After Code Changes
When updating `background.js`, `content.js`, or `overlay.js`:
1. Return to `chrome://extensions`.
2. Locate **Classroom Activity Monitor**.
3. Click the **↻ (Reload)** button.
4. Refresh any active Google Meet tabs.
