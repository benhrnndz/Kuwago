# Kuwago 🦉

> **Real-time student engagement, attendance, and focus telemetry for Google Meet classrooms.**  
> Powered by Firebase Realtime Database and direct Google Sheets / Drive API integration.

Kuwago provides professors with a live, glanceable control center during online classes. It tracks who is present, who is actively paying attention to the Google Meet tab, and who responds to real-time verification prompts — updating instantly across WebSockets with sub-second latency, zero polling lag, and zero manual page refreshes.

---

## What Kuwago Does

| Capability | How It Works |
|---|---|
| **Class Session Lifecycle** | Professor selects an enrolled section (e.g. `BSIT 3-5`), clicks **Start Class**, and monitors a live session duration timer. Ending the class compiles an automated per-session Google Sheet report. |
| **Instant Real-Time Telemetry** | Powered by Firebase Realtime Database (RTDB). Changes in student focus, tab activity, chat responses, or attendance reflect on the professor's dashboard in real time. |
| **Google Sign-In & Auth Guard** | Professors sign in securely using Google OAuth (`login.html`). Protects student telemetry and enables direct export authority into the professor's own Google Drive. |
| **Priority Roster** | A clean, high-priority list displaying each student's name, live status (`On Meet tab`, `Away from Meet tab`, `Not joined`), attendance badge (`Present`, `Late`, `Absent`, `Excused`), and active alert indicators. |
| **Student Detail Drill-Down** | Clicking any student opens an in-depth modal showing session timestamps, attendance history & overrides, focus lapse breakdown, participation log, and extension health. |
| **Actionable Focus Lapses** | Replaces arbitrary percentages with concrete data: tracks how many times a student left the Meet tab longer than the threshold and the exact cumulative time spent away. |
| **Automated Attendance Engine** | Categorizes attendance automatically into `Present`, `Late`, or `Absent` based on arrival times and configurable grace periods. Professors can manually override status with an audit reason. |
| **Real-Time Verification Prompts** | Professor broadcasts a prompt phrase with an expiration countdown. Students receive an in-meeting HUD overlay banner, and responses in Meet chat are validated and tallied in real time. |
| **Direct Google Sheets Export** | Eliminates intermediary scripts. Upon ending a class, the dashboard creates or updates a consolidated **"Kuwago Reports"** spreadsheet directly in the professor's Google Drive with styled session tabs and summary cards. |
| **Extension Health & Pre-Join Sync** | Student extension records presence even before the professor hits "Start Class", syncing immediately upon session start. Continuous health heartbeats detect disconnected students or inactive extensions. |
| **Unmatched Identity Resolution** | Automatically reconciles students whose Google Meet display names differ from the official roster (handling inverted names, nicknames, and formatting differences) with an in-dashboard binding tool. |

---

## Architecture Overview

```
┌────────────────────────────────────────────────────────────────────────┐
│                 Student Browser (Chrome Extension MV3)                 │
│  ┌──────────────────────────────┐    ┌──────────────────────────────┐  │
│  │ content.js & overlay.js      │    │ background.js                │  │
│  │ - Meet display name detection│    │ - Window / tab focus tracker │  │
│  │ - In-meeting prompt overlay  │    │ - Debounced focus departures │  │
│  │ - Chat observer & submitter  │    │ - Heartbeat beacon (15s)     │  │
│  └──────────────┬───────────────┘    └──────────────┬───────────────┘  │
└─────────────────┼───────────────────────────────────┼──────────────────┘
                  │ HTTPS REST (PUT / PATCH)          │
                  ▼                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│                  Firebase Realtime Database (RTDB)                     │
│               kuwago-d6c14-default-rtdb (asia-southeast1)              │
│  ┌──────────────┬──────────────┬──────────────┬─────────────────────┐  │
│  │ courses      │ students     │ heartbeats   │ aliases             │  │
│  ├──────────────┼──────────────┼──────────────┼─────────────────────┤  │
│  │ classSessions/{sessionId}   │ - prompts    │ - active session    │  │
│  │ - attendance │ - focusEvents│ - chatLogs   │ - summary metadata  │  │
│  └──────────────┴──────────────┴──────────────┴─────────────────────┘  │
└─────────────────────────────────┬──────────────────────────────────────┘
                                  │ Real-time WebSocket Listeners
                                  ▼
┌────────────────────────────────────────────────────────────────────────┐
│                   Professor Dashboard Web Application                  │
│                    (Hosted on Vercel / Local Node)                     │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ login.html + index.html (Vanilla ES Modules, Zero Build Bundler) │  │
│  │ - firebase.js   : Firebase SDK init, Auth guard, Google Sign-In  │  │
│  │ - store.js      : RTDB state manager & real-time reactive sync   │  │
│  │ - session.js    : Class lifecycle, course selector, timer        │  │
│  │ - sheets.js     : Direct Google Drive v3 & Sheets v4 API export  │  │
│  │ - attendance.js : Overrides, alias resolution & audit logging    │  │
│  │ - render.js     : Priority roster, student detail modals         │  │
│  │ - prompt.js     : Live chat prompt dispatch & respondents        │  │
│  │ - mock.js       : Comprehensive offline sandbox (?mock=true)     │  │
│  └──────────────────────────────┬───────────────────────────────────┘  │
└─────────────────────────────────┼──────────────────────────────────────┘
                                  │ Direct Google OAuth (Bearer Token)
                                  ▼
┌────────────────────────────────────────────────────────────────────────┐
│                Professor's Google Drive & Google Sheets                │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ "Kuwago Reports" Spreadsheet                                     │  │
│  │ - Tab per session: Session_YYYY-MM-DD_SectionID                  │  │
│  │ - Session metadata, aggregate metric cards, full student roster  │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────┘
```

---

## Project Structure

```
Kuwago/
├── index.html                    # Professor Dashboard SPA (protected route)
├── login.html                    # Google Sign-In login portal
├── vercel.json                   # Vercel deployment configuration
├── serve-dashboard.js            # Node.js local dev server (zero dependencies)
├── package.json                  # Project manifest (v3.0.0, scripts & dependencies)
├── css/
│   ├── tokens.css                # Color variables, typography, and spacing tokens
│   ├── layout.css                # Full-viewport layout, responsive containers, session bar
│   ├── components.css            # Priority roster rows, modals, badges, alerts, topbar
│   ├── states.css                # Connection banners, empty states, loading indicators
│   └── login.css                 # Login portal styles with royal blue aesthetic
├── js/
│   ├── app.js                    # Application entry point, auth guard, store binding
│   ├── login.js                  # Google Sign-In authentication handler & token storage
│   ├── firebase.js               # Firebase app init, Auth, RTDB refs & token management
│   ├── store.js                  # Real-time RTDB listener coordinator and state store
│   ├── api.js                    # Data operations layer (RTDB writes, mock fallbacks)
│   ├── sheets.js                 # Direct Google Drive v3 & Google Sheets v4 API exporter
│   ├── session.js                # Class lifecycle controls (start/end, course selector, timer)
│   ├── engagement.js             # Client-side focus lapse analytics & student detail math
│   ├── attendance.js             # Attendance overrides and alias binding handlers
│   ├── render.js                 # DOM rendering: Priority Roster, Detail Modal, Prompts
│   ├── prompt.js                 # Chat prompt dialog and active prompt countdown
│   ├── respondents.js            # Respondents breakdown dialog
│   └── mock.js                   # Comprehensive offline mock data engine (?mock=true)
├── firebase/
│   └── database.rules.json       # RTDB security rules (scoped reads/writes)
├── scripts/
│   └── seed-rtdb.js              # Database seed script for courses and student rosters
├── chrome-extension/             # Student-side Chrome Extension (Manifest V3)
│   ├── manifest.json             # Extension permissions & content script definitions
│   ├── background.js             # Service worker (focus tracking, heartbeats, RTDB sync)
│   ├── content.js                # Google Meet DOM name detector & chat listener
│   ├── overlay.js                # In-meeting HUD prompt banner injected into Google Meet
│   ├── popup.html / popup.js     # Extension toolbar status popup with RTDB setup badge
│   └── icons/                    # Extension visual brand assets
├── docs/                         # Comprehensive Documentation
│   ├── README.md                 # Documentation portal
│   ├── architecture.md           # Deep architectural specification and sequence flows
│   ├── setup-guide.md            # Complete step-by-step setup guide
│   ├── api-reference.md          # Full API contract reference for RTDB and mock endpoints
│   ├── apps-script.md            # Reference documentation on legacy Apps Script export
│   └── chrome-extension.md       # Extension mechanics, installation, and permissions
├── spec/                         # Specifications & Addenda
└── CHANGELOG.md                  # Release notes and version history
```

---

## Quick Start Guide

### Prerequisites
- **Node.js** (v18+) for local development and database seeding
- **Google Chrome** (for student extension and professor dashboard)
- A **Google Account** with access to Firebase Console and Google Cloud Console

---

### 1. Firebase Project Setup

1. Open the [Firebase Console](https://console.firebase.google.com/) and create or select your project (e.g. `kuwago-d6c14`).
2. **Authentication**:
   - Enable **Google** as a Sign-In provider under **Build → Authentication → Sign-in method**.
3. **Realtime Database**:
   - Create a Realtime Database in the **Singapore (`asia-southeast1`)** region.
   - Under **Rules**, apply the rules defined in [`firebase/database.rules.json`](firebase/database.rules.json).
4. **Google Cloud APIs (for Reports Export)**:
   In the linked Google Cloud project, enable:
   - [Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com)
   - [Google Sheets API](https://console.cloud.google.com/apis/library/sheets.googleapis.com)

---

### 2. Seed Courses and Student Rosters

To populate initial sections (e.g. `BSIT 3-5`) and student rosters into your Firebase Realtime Database:

1. Obtain a Firebase service account private key from **Project Settings → Service Accounts → Generate new private key**.
2. Save it as `scripts/serviceAccountKey.json` (this file is ignored by Git).
3. Run the seed script:
   ```bash
   # Seed default courses and rosters
   npm run seed

   # Or wipe and reseed cleanly:
   npm run seed:wipe
   ```

---

### 3. Run the Dashboard

#### Option A: Run Locally
Start the zero-dependency Node.js dev server:

```bash
npm start
# or: node serve-dashboard.js
```

Open `http://localhost:8080` in Chrome.

> **Offline Mock Mode**: To test the complete dashboard UI without connecting to Firebase, visit:  
> `http://localhost:8080/?mock=true`

#### Option B: Deploy to Vercel
The project is configured for instant Vercel deployment:
```bash
vercel deploy --prod
```
Or view the live production deployment at `kuwago-dashboard.vercel.app`.

---

### 4. Install the Chrome Extension (Students)

1. Open Chrome and navigate to `chrome://extensions`.
2. Enable **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked** and select the `chrome-extension/` directory.
4. Verify the extension popup by clicking the Kuwago icon in the toolbar. It should display a green **Ready** badge for RTDB connectivity.
5. When students join a Google Meet room at `meet.google.com`, the extension activates automatically, detects their name, and streams focus/participation telemetry.

---

### 5. Exporting Session Reports

When the professor ends a class session:
1. The dashboard prompts with a **Session Summary Modal**.
2. Using the professor's Google OAuth token, Kuwago automatically locates or creates a spreadsheet named **"Kuwago Reports"** in the professor's Google Drive.
3. A dedicated tab (e.g. `Session_2026-10-19_BSIT 3-5`) is added with styled headers, session metrics, and full student attendance and focus logs.
4. A direct link (**"Open sheet ↗"**) is displayed right inside the modal.

---

## Documentation Index

For in-depth guides, visit the [`docs/`](docs/) directory:

- 📐 **[System Architecture](docs/architecture.md)** — Architectural design, WebSocket telemetry, security rules, and sequence flows.
- 🚀 **[Setup Guide](docs/setup-guide.md)** — Complete, step-by-step deployment walkthrough from scratch.
- 📡 **[API Reference](docs/api-reference.md)** — Data structures, RTDB schemas, and mock engine contracts.
- 🧩 **[Chrome Extension](docs/chrome-extension.md)** — Focus detection algorithm, in-meeting overlay, and permissions.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines, coding standards, and workflow practices.

---

## License

Private / Unlicensed — All rights reserved.
