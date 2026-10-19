# Changelog

All notable changes to **Kuwago** will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project uses [Semantic Versioning](https://semver.org/).

---

## [3.0.0] — 2026-10-19

### Added

#### Firebase Realtime Database (RTDB) Integration
- **Real-Time WebSocket Sync**: Replaced 5-second polling architecture with continuous Firebase Realtime Database listeners (`store.js`), reducing latency to under 500ms and eliminating polling strain.
- **Direct REST Extension Logging**: Chrome extension communicates directly with RTDB via HTTPS REST API (`kuwago/classSessions/...`) without third-party proxy layers.
- **Client-Side Analytics Engine (`engagement.js`)**: Real-time focus lapse calculation, sustained unfocus detection, and participation evaluation computed client-side from reactive RTDB snapshots.
- **Database Seeding (`scripts/seed-rtdb.js`)**: Added Node.js seeding utility using `firebase-admin` to populate courses (`BSIT 3-5`) and full student rosters with support for `--wipe`.
- **RTDB Security Rules (`firebase/database.rules.json`)**: Configured database read/write permissions scoped to course sessions, heartbeats, and aliases.

#### Authentication & Access Control
- **Google Sign-In Gateway (`login.html` & `js/login.js`)**: Dedicated authentication portal requiring professors to sign in with their Google account before accessing the dashboard.
- **Client Auth Guard (`js/app.js`)**: Automatic redirection to `login.html` for unauthenticated visitors, preserving session continuity on login.
- **OAuth Scope Authorization**: Captures and persists OAuth access tokens with `https://www.googleapis.com/auth/drive.file` and `https://www.googleapis.com/auth/spreadsheets` scopes for direct Drive/Sheets export.
- **Profile & Logout Bar**: Displays signed-in professor name and avatar in the dashboard topbar with an instant sign-out control.

#### Direct Google Sheets & Google Drive API Export (`js/sheets.js`)
- **Direct OAuth API Exporter**: Bypasses Google Apps Script execution quotas and proxy timeouts by writing session reports directly to Google Sheets API v4 and Google Drive API v3.
- **Automated "Kuwago Reports" Workbook**: Automatically locates or creates a central "Kuwago Reports" spreadsheet in the professor's own Google Drive.
- **Formatted Session Tabs**: Adds structured `Session_YYYY-MM-DD_SectionID` tabs containing session metadata, metric summary cards, and full student attendance/focus rosters.
- **Clickable Report Links**: End-of-class summary dialog provides instant direct links (`Open sheet ↗`) to view the newly compiled report in Google Sheets.

#### Chrome Extension Upgrades & In-Meeting HUD
- **In-Meeting Prompt Overlay (`overlay.js`)**: Floating visual banner injected directly into the Google Meet window when the professor issues a verification prompt, displaying the prompt phrase and countdown timer.
- **Pre-Session Join Tracking**: Students joining the Meet call before the professor clicks "Start Class" have their join events staged and synced seamlessly when the session activates.
- **Order-Insensitive Name Matching**: Normalizes student names to correctly match canonical rosters regardless of format (`LastName, FirstName` vs `FirstName LastName`).
- **Brand Redesign & Setup Badge**: Extension popup updated with royal blue theme and a real-time RTDB connection status badge.

#### Hosting & Deployment
- **Vercel Deployment (`vercel.json`)**: Configured for continuous deployment on Vercel at `kuwago-dashboard.vercel.app` with clean URLs and security headers.
- **Full-Viewport Dashboard**: Modernized layout from a constrained floating card into a full-height, responsive control center.

### Changed
- **Data Layer Architecture**: `js/api.js` rewritten to write directly to RTDB via `store.js` helpers while preserving full offline sandbox capabilities (`?mock=true`).
- **Token Capture Fix**: Updated Firebase Auth token extraction to use compat SDK `result.credential.accessToken` instead of modular `credentialFromResult`.

### Removed
- **Apps Script Polling Loop**: Deprecated 5-second `dashboardData` polling interval and legacy Apps Script backend proxy endpoints.
- **Dead Proxy Endpoints**: Removed legacy `api/export.js` Vercel function in favor of direct client-side Google API requests.

---

## [2.0.0] — 2026-09-11

### Added

#### Class Session Lifecycle Management
- **Course Selection**: Dropdown populated dynamically via `getCourses` endpoint based on the `Courses` spreadsheet tab (`SectionID`, `CourseName`, `SectionName`).
- **Session Lifecycle Control**: Integrated `Start Class` and `End Class` workflow (`session.js`), enforcing single active session at any given time.
- **Real-Time Duration Timer**: Elapsed time ticker tracking active class length with live updates.
- **Automated Session Report Generation**: When a class ends, `handleEndSession` compiles and creates a permanent, consolidated `Session_YYYY-MM-DD_SectionID` sheet tab in Google Sheets recording final attendance, focus lapse statistics, and participation.
- **Session Summary Dialog**: Modal displayed to the professor upon ending class showing aggregate attendance (present/late/absent counts), average focus lapses, and overall participation rate.

#### Priority Roster & Student Detail Drilldown
- **Priority Roster Row**: Redesigned glanceable student row displaying solely critical information: Student Name, Live Status (`On Meet tab`, `Away from Meet tab`, `Not joined`), Attendance Badge (`Present`, `Late`, `Absent`, `Excused`), and dynamic Active Alert indicator.
- **Interactive Student Detail Modal**: Lazy-loaded drilldown (`studentDetail` endpoint) providing:
  - Header with real-time status and Meet presence indicator
  - Session join and leave timestamps
  - Attendance breakdown with full historical audit log of professor overrides
  - Detailed Focus Lapse log: count, cumulative seconds away, and individual timestamped lapse durations
  - Participation breakdown: answered vs. issued prompts, submitted answers, and match validation
  - Extension Health report: connection status, extension version, last heartbeat timestamp, and raw detected display name
  - Identity matching status with direct shortcut to bind unmatched names

#### Attendance Engine & Professor Overrides (`attendance.js`)
- **Automated Attendance Categorization**: Automatically computes `Present`, `Late` (based on configurable grace period), or `Absent` based on student arrival times relative to session start.
- **Manual Attendance Overrides**: Professor can modify attendance status for any student via an override dialog, specifying new status and reason (e.g., excused note, technical difficulty), recorded in both memory and the database.
- **Alias & Identity Resolution**: Unmatched Meet display names can be bound to official roster students (`resolveMatch` endpoint), automatically resolving identity mismatches and cleaning up temporary ghost rows.

#### Extension Health & Heartbeat Engine
- **Dedicated Heartbeats Table**: Latest-only `Heartbeats` sheet tracking the last known ping for each student.
- **Heartbeat Service Worker**: Extension periodically pulses health signals (`POST ?action=heartbeat`) containing the detected name and extension version.
- **Disconnection Detection**: Flags students as `disconnected` if no heartbeat has been received within the configured threshold, alerting the professor without false alarms.

#### Developer & Deployment Utilities
- **One-Click Sheet Setup (`setupSheets`)**: Added utility function in `SheetHelpers.gs` that automatically creates all 7 required sheets with exact headers and formatting in one click.
- **Comprehensive Mock Engine**: Expanded `mock.js` to simulate the full v2.0.0 lifecycle, including course fetching, starting/ending sessions, attendance overrides, alias resolution, and student detail queries.

### Changed
- **Metric Evolution**: Completely removed ambiguous `attentivenessPct` across the frontend and backend. Replaced with actionable **Focus Lapses** (count of sustained departures + cumulative away time) that aligns directly with alert thresholds.
- **Roster Query Scoping**: Student roster lookups are now strictly scoped to the active session's `SectionID` instead of dumping the entire school roster.
- **Optimized Polling Payload**: Stripped heavy historical metrics from the 5-second `dashboardData` polling loop; detailed lapse logs and response histories are now fetched on demand via `studentDetail`.

### Fixed
- **API Guard in Chrome Extension**: Fixed an inverted equality check in `background.js` `apiGet` that was causing extension API calls to be skipped.
- **Session End Hoisting Error**: Resolved a temporal dead zone `ReferenceError` in `mock.js` for attendance overrides that prevented session summaries from rendering.
- **Unanswered Prompt False Positives**: Ensured active prompts only generate missed-prompt alerts after their expiration window has lapsed.
- **Ghost Row Removal**: Automated pruning of ghost session rows once an unmatched student is linked to their canonical roster identity.

---

## [1.0.0] — 2026-09-10

### Added

#### Professor Dashboard (frontend)
- Single-page dashboard served locally via `node serve-dashboard.js`
- Live roster table with per-student status (`Focused`, `Unfocused`, `Not Joined`)
- Attentiveness % and participation rate columns, updated on every poll
- Unmatched entries section for students whose Meet display names don't match the roster
- Active prompt card showing phrase, countdown timer, and live response tally (`X / Y responded`)
- Chat prompt modal — professor can set a phrase + duration and push it to the class
- Session status bar with last-updated timestamp and poll-failure indicator
- Filter bar (All / Focused / Unfocused / Not Joined / Unmatched)
- Column sort (Name, Status, Attentiveness, Participation, Last Activity, Join Time)
- Mock mode (`?mock=true`) for local development without a live backend
- Respondents modal showing who has responded to the active prompt
- Polling every 5 seconds with graceful last-known-good fallback on failures

#### Chrome Extension (`chrome-extension/`)
- Manifest V3 Chrome extension targeting `meet.google.com`
- Content script: detects the student's own Meet display name from the DOM
- Content script: `MutationObserver`-based chat capture, forwarded to `submitChat`
- Background service worker: tab focus/blur tracking via `chrome.tabs.onActivated` + `chrome.windows.onFocusChanged`
- Background service worker: join/leave lifecycle events
- Background service worker: debounced focus-lost/regained to suppress sub-second flickers
- Background service worker: polls `currentPrompt` every ~5–10 s

#### Google Apps Script Backend (`apps-script/`)
- `doGet` / `doPost` router with action-based dispatch
- `dashboardData` endpoint: returns full aggregated roster state
- `currentPrompt` endpoint: returns the active prompt (for extension polling)
- `logEvent` endpoint: records join, leave, focus-lost, focus-regained events
- `submitChat` endpoint: matches raw chat text against the active prompt
- `setPrompt` endpoint: sets a new expected phrase with a configurable duration
- Engagement calculations (attentiveness %, participation rate) computed fresh on every read — nothing cached
- Google Sheets schema: `Students`, `Sessions`, `FocusEvents`, `ChatPrompts`, `ChatResponses`
- Name normalization: case-insensitive, whitespace-collapsed matching against roster

#### Documentation
- `README.md` — overview, architecture diagram, quick-start guide
- `CHANGELOG.md` — this file
- `docs/architecture.md` — full system architecture with Mermaid sequence diagram
- `docs/setup-guide.md` — step-by-step setup for all three components
- `docs/api-reference.md` — all endpoint shapes and field definitions
- `docs/chrome-extension.md` — extension internals and install instructions
- `docs/apps-script.md` — Apps Script deployment and sheet setup

---

_Versions prior to 1.0.0 were internal development iterations._
