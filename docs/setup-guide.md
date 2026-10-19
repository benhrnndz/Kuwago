# Complete Setup Guide

This guide walks you through setting up all components of **Kuwago v3.0.0** from start to finish.

**Estimated setup time:** 10–15 minutes.

---

## Prerequisites

| Component | Requirement | Purpose |
|---|---|---|
| **Node.js** | Node 18+ | Seeding database and serving dashboard locally |
| **Google Chrome** | Modern stable version | Running the extension and dashboard |
| **Firebase Project** | Blaze or Spark plan with RTDB | Real-time database and Google authentication |
| **Google Cloud Account** | Drive API & Sheets API enabled | Generating reports in professor's Google Drive |
| **Git** | Any version | Cloning repository and pushing updates |

---

## Step 1 — Clone the Repository

```bash
git clone https://github.com/lester27/Kuwago.git
cd Kuwago
```

---

## Step 2 — Configure Firebase Authentication & Realtime Database

### 1. Enable Google Sign-In
1. Navigate to the [Firebase Console](https://console.firebase.google.com/) and open your project (e.g. `kuwago-d6c14`).
2. Go to **Build → Authentication → Sign-in method**.
3. Enable **Google** as a sign-in provider and save.

### 2. Create Realtime Database
1. Go to **Build → Realtime Database** and click **Create Database**.
2. Select the **Singapore (`asia-southeast1`)** region.
3. Start in **locked mode**.
4. Switch to the **Rules** tab, paste the rules from [`firebase/database.rules.json`](../firebase/database.rules.json), and click **Publish**.

---

## Step 3 — Enable Google Cloud APIs for Reports Export

Kuwago exports formatted session summaries directly to the professor's personal Google Drive using Google Sheets API v4 and Google Drive API v3.

1. Open the [Google Cloud Console](https://console.cloud.google.com/) for your Firebase project (`kuwago-d6c14`).
2. Enable the **Google Drive API**:
   - [console.cloud.google.com/apis/library/drive.googleapis.com](https://console.cloud.google.com/apis/library/drive.googleapis.com) → Click **Enable**.
3. Enable the **Google Sheets API**:
   - [console.cloud.google.com/apis/library/sheets.googleapis.com](https://console.cloud.google.com/apis/library/sheets.googleapis.com) → Click **Enable**.

---

## Step 4 — Seed Courses and Student Rosters

Kuwago includes an automated seeding utility (`scripts/seed-rtdb.js`) to populate course sections (e.g. `BSIT 3-5`) and student rosters into Firebase RTDB:

1. In the Firebase Console, go to **Project Settings → Service Accounts**.
2. Click **Generate new private key** and download the JSON credentials.
3. Move the downloaded JSON file to `scripts/serviceAccountKey.json` (this file is ignored by Git).
4. Run the seed script:
   ```bash
   # Seed default sections and student rosters
   npm run seed

   # Or completely wipe existing RTDB data and reseed:
   npm run seed:wipe
   ```

---

## Step 5 — Run or Deploy the Professor Dashboard

### Option A: Local Development Server
Start the zero-dependency Node.js HTTP server:

```bash
npm start
# or: node serve-dashboard.js
```

Open your browser to: **`http://localhost:8080`**

*(To test the interface offline with simulated mock data, visit: `http://localhost:8080/?mock=true`)*

### Option B: Deploy to Vercel
Kuwago is configured for continuous production deployment via Vercel:
```bash
npm install -g vercel
vercel deploy --prod
```
Or view the live production deployment at `kuwago-dashboard.vercel.app`.

---

## Step 6 — Install the Student Chrome Extension

1. Open Google Chrome and visit: `chrome://extensions`
2. Toggle on **Developer mode** in the top-right corner.
3. Click **Load unpacked** (top-left).
4. Select the `chrome-extension/` directory from the repository.
5. Click the Kuwago extension icon in the Chrome toolbar. The popup should display a green **Ready** badge confirming active RTDB connectivity.

---

## Step 7 — Verification & Live Testing Walkthrough

1. **Sign In**:
   - Visit the dashboard (`http://localhost:8080` or production URL).
   - Sign in using your Google account on the login page (`login.html`).
2. **Start Class**:
   - Select your section from the dropdown (e.g. `BSIT 3-5`).
   - Click **Start Class**. The live session duration timer will begin ticking.
3. **Student Presence (Google Meet)**:
   - Join a Google Meet room at `meet.google.com` on a student browser with the extension installed.
   - On the professor's dashboard, the student immediately appears in the roster marked **On Meet tab** with a **Present** attendance badge.
4. **Focus Departure Tracking**:
   - Switch away from the Google Meet tab on the student machine.
   - Within seconds, the student's status updates to **Away from Meet tab**.
   - If away longer than 45 seconds, a focus lapse is logged and an active alert is raised.
5. **Interactive Verification Prompt**:
   - Click **Send Prompt** on the dashboard, enter a phrase (e.g. `"focus"`), and set a 60-second limit.
   - The student instantly sees the floating HUD prompt overlay banner (`overlay.js`) directly inside Google Meet.
   - When the student enters the matching phrase in Meet chat, the dashboard respondents tally updates in real time.
6. **End Class & Direct Sheets Export**:
   - Click **End Class** and confirm.
   - The dashboard calls Google Drive & Sheets APIs using your OAuth token to locate or create a spreadsheet named **"Kuwago Reports"** in your Google Drive.
   - A new tab (e.g. `Session_2026-10-19_BSIT 3-5`) is added with formatted metric cards and the full student attendance roster.
   - Click the **"Open sheet ↗"** link in the summary modal to view your report in Google Sheets!
