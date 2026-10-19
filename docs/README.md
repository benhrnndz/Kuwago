# Kuwago Documentation Portal

Welcome to the comprehensive technical documentation for **Kuwago v3.0.0** — real-time classroom engagement, attendance tracking, and focus telemetry for Google Meet.

---

## Core Documentation Guides

| Guide | Description | Target Audience |
|---|---|---|
| 📐 **[System Architecture](architecture.md)** | Full architectural overview, component breakdowns, Mermaid sequence flows, Firebase Realtime Database structures, and direct Sheets export flows. | Architects & Developers |
| 🚀 **[Setup Guide](setup-guide.md)** | Step-by-step walkthrough for configuring Firebase (Auth, RTDB), enabling Google Cloud APIs, database seeding, Chrome Extension, and Vercel/local deployment. | Professors & System Admins |
| 📡 **[API Reference](api-reference.md)** | Exhaustive specifications for RTDB data schemas, client-side mutations, mock simulation engine, and legacy Apps Script reference. | Frontend & Backend Engineers |
| 📊 **[Google Sheets & Apps Script Reference](apps-script.md)** | Reference documentation covering the Sheets report schema, column layouts, and historical Apps Script exporter mechanics. | Backend Developers |
| 🧩 **[Chrome Extension](chrome-extension.md)** | Deep dive into Manifest V3 event debouncing, DOM name scraping, in-meeting prompt HUD (`overlay.js`), pre-join tracking, and the 15-second heartbeat loop. | Client Engineers |

---

## Specifications & Design History

For original requirements and Phase 2 addenda, explore the [`spec/`](../spec/) directory:
- [`spec/frontend-spec-addendum.md`](../spec/frontend-spec-addendum.md) — Priority Roster UX design & Student Detail modal specifications.
- [`spec/backend-spec-addendum.md`](../spec/backend-spec-addendum.md) — Class session control, `Courses` sheet, and per-session consolidated exports.
- [`spec/frontend-dashboard-restructure.md`](../spec/frontend-dashboard-restructure.md) — Focus Lapses metric transition specification.
- [`spec/backend-dashboard-restructure.md`](../spec/backend-dashboard-restructure.md) — Trimmed `dashboardData` and `studentDetail` data contracts.
