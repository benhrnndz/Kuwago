# System Architecture

## Overview

**Kuwago v3.0.0** is a distributed classroom engagement and attendance monitoring system for Google Meet. It operates across four decoupled layers:

| Layer | Host Environment | Core Responsibility |
|---|---|---|
| **Chrome Extension** | Student Chrome Browser (Manifest V3) | Captures tab/window focus, Meet display name, chat responses, presents in-meeting HUD overlay (`overlay.js`), buffers pre-session joins, and sends periodic health heartbeats. Logs telemetry directly to RTDB via REST. |
| **Realtime Database** | Firebase Realtime Database (`asia-southeast1`) | Central live database powering sub-second WebSocket reactive sync to the dashboard and receiving REST telemetry from student extensions. |
| **Authentication & Export Engine** | Firebase Auth & Google Cloud REST APIs | Authenticates professors via Google OAuth with Drive & Sheets scopes (`drive.file`, `spreadsheets`). Directly creates and formats reports in the professor's Google Drive ("Kuwago Reports") without intermediary serverless proxies. |
| **Professor Dashboard** | Vercel Platform / Local Node.js | Full-viewport Vanilla ES Modules SPA displaying the live Priority Roster, prompt dispatcher, session controls, and student drill-down modals. |

---

## Data Flow & Lifecycle

### Complete Session Lifecycle Sequence

```mermaid
sequenceDiagram
    autonumber
    actor Prof as Professor (Dashboard)
    participant Auth as Firebase Auth (Google)
    participant RTDB as Firebase Realtime Database
    actor Stud as Student Browser (Meet Ext)
    participant Drive as Google Drive & Sheets API

    Note over Prof,Auth: Phase 1 — Authentication & Authorization
    Prof->>Auth: Google Sign-In with Popup (Scopes: drive.file, spreadsheets)
    Auth-->>Prof: User credentials + OAuth access token (stored in sessionStorage)

    Note over Prof,RTDB: Phase 2 — Real-Time Connection & Session Activation
    Prof->>RTDB: Attach WebSocket listeners (courses, students, heartbeats, active session)
    RTDB-->>Prof: Initial data snapshot (sections e.g. BSIT 3-5, rosters)
    Prof->>RTDB: Write kuwago/classSessions/{sessionId} { active: true, sectionId, startedAt }
    RTDB-->>Prof: Session activated; start local duration ticker

    Note over Stud,RTDB: Phase 3 — Student Telemetry & Extension Beacons
    Stud->>RTDB: POST kuwago/heartbeats/{studentKey} (every 15s)
    Stud->>RTDB: PUT kuwago/classSessions/{sessionId}/attendance/{studentKey} { joinedAt }
    
    loop Real-Time Telemetry (Sub-Second WebSocket Push)
        RTDB-->>Prof: Instant push on attendance or heartbeat changes
        
        opt Focus Departure
            Stud->>RTDB: POST kuwago/classSessions/{sessionId}/focusEvents { type: "lost" }
            RTDB-->>Prof: Real-time alert raised on dashboard (sustained unfocus)
        end

        opt Student Detail Drill-down
            Prof->>Prof: Compute drill-down detail instantly from local RTDB store snapshot
        end
    end

    Note over Prof,Stud: Phase 4 — Interactive Verification Prompt
    Prof->>RTDB: Write kuwago/classSessions/{sessionId}/prompts/{promptId} { phrase, expiresAt }
    RTDB-->>Stud: Extension detects active prompt via RTDB listener/poll
    Stud->>Stud: Injects in-meeting HUD overlay banner (overlay.js) with countdown
    Stud->>RTDB: POST response upon detecting student chat matching phrase
    RTDB-->>Prof: Instant real-time increment on respondents tally

    Note over Prof,Drive: Phase 5 — Class Termination & Direct Sheets Export
    Prof->>RTDB: Update session { active: false, endedAt }
    Prof->>Drive: Search or Create "Kuwago Reports" spreadsheet (Drive API v3)
    Drive-->>Prof: Return Spreadsheet ID
    Prof->>Drive: Add formatted tab Session_YYYY-MM-DD_SectionID (Sheets API v4)
    Drive-->>Prof: Success response with sheet URL
    Prof-->>Prof: Display End Class Summary Modal with direct "Open sheet ↗" link
```

---

## Component Architecture

### 1. Professor Dashboard (`index.html`, `login.html`, `js/`, `css/`)

A client-side Single Page Application engineered with zero third-party framework dependencies.

- **`login.html` & `js/login.js`**: Google OAuth login gateway. Handles popup sign-in, persists the Google OAuth access token into `sessionStorage`, and redirects to the dashboard.
- **`js/app.js`**: Application bootstrapper. Implements auth guard, attaches store listeners, binds navigation controls, and routes sorting/filtering.
- **`js/firebase.js`**: Firebase Web SDK initialization, Auth state tracking, RTDB reference builders, name sanitization, and access token TTL manager.
- **`js/store.js`**: Real-time state coordinator. Establishes RTDB subscriptions (`onValue`) for active session, attendance, focus events, prompts, and heartbeats, keeping in-memory state fresh.
- **`js/sheets.js`**: Direct Google Drive v3 and Google Sheets v4 API exporter. Creates the "Kuwago Reports" spreadsheet in the professor's own Google Drive, writes session metadata cards, and formats the student roster.
- **`js/session.js`**: Controls class lifecycle. Manages course selection, triggers session start/end, runs the live session duration timer, and opens the session summary report.
- **`js/engagement.js`**: Client-side analytics engine. Computes focus lapse counts, cumulative away duration, active alerts, and student detail summaries directly from store snapshots.
- **`js/attendance.js`**: Handles manual professor attendance overrides (`overrideAttendance`) and alias binding (`resolveMatch`) for students whose Meet display names do not match the roster.
- **`js/render.js`**: Ultra-fast DOM renderer. Paints the Priority Roster, student alert indicators, attendance status badges, active prompt counters, and renders the lazy-loaded Student Detail modal.
- **`js/prompt.js` & `js/respondents.js`**: Prompt issuance modal, countdown timer ticker, and live respondents checklist.
- **`js/mock.js`**: Offline sandbox engine. Enabled via `?mock=true`, simulating every backend endpoint, telemetry jitter, and edge cases without external connections.

### 2. Chrome Extension (`chrome-extension/`)

A Manifest V3 extension operating strictly within student browser sessions on `meet.google.com`.

- **`manifest.json`**: Configured with `activeTab`, `scripting`, `tabs`, and `host_permissions` for Google Meet, Firebase RTDB, and Google Identity.
- **`content.js`**:
  - Automatically identifies the student's own display name from Google Meet's participant tile DOM using multi-tiered CSS selector fallbacks.
  - Monitors the in-meeting chat box using a `MutationObserver` to capture outgoing text and verify prompt compliance.
- **`overlay.js`**:
  - Injects a sleek in-meeting floating prompt banner into Google Meet when a verification prompt is active, displaying the required phrase and countdown.
- **`background.js`**:
  - Combines `chrome.tabs.onActivated` and `chrome.windows.onFocusChanged` with a 1,500ms debounce buffer to reliably distinguish brief window flicks from genuine sustained departures.
  - Fires heartbeat pulses every 15 seconds directly to the Firebase RTDB REST API.
  - Records student join events even before the professor hits "Start Class", syncing immediately upon session start.
  - Automatically detects when a student closes or navigates away from the Google Meet tab to log leave timestamps.
- **`popup.html` / `popup.js`**:
  - Extension status window styled in royal blue with an instant RTDB readiness badge.

---

## Firebase Realtime Database Schema

Data is organized under the root `kuwago/` namespace:

```
kuwago/
├── courses/
│   └── {sectionId}/                  # e.g. "BSIT 3-5"
│       ├── courseName: string        # e.g. "System Integration and Architecture"
│       └── sectionName: string       # e.g. "BSIT 3-5"
├── students/
│   └── {sectionId}/
│       └── {studentKey}/             # Sanitized student name key
│           ├── name: string          # Full canonical name
│           └── sectionId: string
├── aliases/
│   └── {aliasKey}/                   # Sanitized detected Meet name
│       ├── canonical: string         # Mapped roster name (or null)
│       └── dismissed: boolean
├── heartbeats/
│   └── {studentKey}/                 # Latest heartbeat per student
│       ├── detectedName: string
│       ├── version: string
│       └── timestamp: ISO string
└── classSessions/
    └── {sessionId}/                  # e.g. "session_1729318800000"
        ├── active: boolean
        ├── sectionId: string
        ├── startedAt: ISO string
        ├── endedAt: ISO string
        ├── attendance/
        │   └── {studentKey}/
        │       ├── name: string
        │       ├── joinedAt: ISO string
        │       ├── leftAt: ISO string
        │       ├── matched: boolean
        │       └── override/         # Manual professor adjustment
        │           ├── status: string
        │           ├── reason: string
        │           └── at: ISO string
        ├── focusEvents/
        │   └── {eventId}/
        │       ├── studentName: string
        │       ├── type: "lost" | "regained"
        │       └── timestamp: ISO string
        └── prompts/
            └── {promptId}/
                ├── phrase: string
                ├── issuedAt: ISO string
                ├── expiresAt: ISO string
                ├── active: boolean
                └── responses/
                    └── {studentKey}/
                        ├── text: string
                        └── timestamp: ISO string
```

---

## Google Sheets "Kuwago Reports" Export Format

When a session concludes, the dashboard writes directly to the professor's **"Kuwago Reports"** spreadsheet in Google Drive via Sheets API v4. Each session generates a distinct tab formatted as `Session_YYYY-MM-DD_SectionID`:

### 1. Summary Cards (Header Block)
- **Session Metadata**: Section ID, Date, Start Time, End Time, Total Duration.
- **Attendance Counts**: Present, Late, Absent, Excused, Total Enrolled.
- **Engagement Metrics**: Average Focus Lapses, Average Time Away, Class Participation Rate.

### 2. Student Roster Table
| Column | Description |
|---|---|
| **Student Name** | Canonical roster name |
| **Attendance Status** | `Present`, `Late`, `Absent`, or `Excused` |
| **Focus Lapses** | Number of sustained departures (> 45s away) |
| **Attentiveness** | Evaluated focus percentage during class |
| **Prompts Answered** | Fraction of verification prompts completed (e.g. `2 / 2`) |
| **Participation %** | Calculated participation score |

---

## Analytics & Behavioral Models

### 1. Focus Lapses vs. Percentage Scores
- **Definition**: A focus lapse is recorded only when a student remains unfocused from Google Meet for longer than the sustained unfocus alert threshold (default: 45 seconds).
- **Transient Filtering**: Brief tab switches (< 1.5s) are suppressed at the extension layer. Short glances (< 45s) do not trigger lapse increments.
- **Presentation**: Displayed as a count alongside cumulative away duration (e.g. `2 lapses · 3m 40s away`). Clean students show `No focus lapses`.

### 2. Attendance Classification Engine
Attendance status is calculated automatically based on arrival relative to session start:
- **`Present`**: Joined within the configured grace period (default: 15 minutes).
- **`Late`**: Joined after the grace period has elapsed.
- **`Absent`**: No join event detected during the class session.
- **`Excused`**: Assigned via manual professor override with an audit reason.
