#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════
   scripts/seed-rtdb.js — One-time RTDB seeder

   Reads roster data from the Apps Script endpoint (existing
   Google Sheet) and writes it to Firebase RTDB under
   kuwago/courses/{sectionId}/students/{sanitizedName}

   Usage:
     node scripts/seed-rtdb.js

   Prerequisites:
     npm install firebase-admin
     Place your Firebase service account JSON at:
       scripts/serviceAccountKey.json
     (Download from Firebase Console → Project Settings → Service Accounts)

   To update the roster later, just re-run this script.
   Existing student records are merged (not wiped).
   ════════════════════════════════════════════════════════════ */

'use strict';

const fs = require('fs');
const path = require('path');

/* ── Firebase Admin SDK ─────────────────────────────────── */
let admin;
try {
  admin = require('firebase-admin');
} catch (e) {
  console.error('[seed] firebase-admin not installed. Run: npm install firebase-admin');
  process.exit(1);
}

const SERVICE_ACCOUNT_PATH = path.join(__dirname, 'serviceAccountKey.json');

if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
  console.error(`
[seed] Service account key not found at:
  ${SERVICE_ACCOUNT_PATH}

Download it from Firebase Console:
  Project Settings → Service Accounts → Generate new private key

Then save it as scripts/serviceAccountKey.json and re-run.
`);
  process.exit(1);
}

const serviceAccount = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_PATH, 'utf8'));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://kuwago-d6c14-default-rtdb.asia-southeast1.firebasedatabase.app'
});

const db = admin.database();

/* ── Key Sanitizer (must match firebase.js) ─────────────── */
function sanitizeName(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

/* ── Roster Data ─────────────────────────────────────────── */

/**
 * Define your courses and students here.
 * Each section has a unique sectionId, a courseName, sectionName,
 * and an array of student full names.
 *
 * To update: edit this array and re-run the script.
 * Run `node scripts/seed-rtdb.js --wipe` to clear old data first.
 */
const COURSES = [
  {
    sectionId: 'BSIT 3-5',
    courseName: 'INTE 301',
    sectionName: 'BSIT 3-5',
    students: [
      'A Jose, Justin Gabriel',
      'Abenoja, Ching Mae',
      'Arcebuche, Mao Miguel',
      'Bajada, Michael Habakkuk M.',
      'Ballester, Eliana Maxine',
      'Beros, Jose Myrson',
      'Biando, Sofia Ela',
      'Bugal, Sheine Grace E.',
      'Cardona Miguel Jeron',
      'Celindro Aaron Creed P.',
      'Cledera, Aliezza Angelique P.',
      'Coloma Kevin',
      'Conguis, Francis Philip',
      'Cruz, Genesis Lance V.',
      'Cruz, Kurt Anthony T.',
      'Dela Rama, Antonio Miguel',
      'Estrella, John Michael R.',
      'Euls Matrix Dollesin',
      'Flores, Hannah Lauren A.',
      'Francisco, John Eiyen D.',
      'Galdo, Monico L.',
      'Garcia, Patrick Gabriel R.',
      'Gasis, Janeah Marie M.',
      'Gorgonio, Arvin Rovic R.',
      'Hernandez, Harold Benedict',
      'Ian Paulo Gilera',
      'Ilagan, Tristan Patrick E.',
      'Lin, Swee Genesis',
      'Maguillo Ivan Josh R.',
      'Mallari, Erica',
      'Masmela, Savannah Tricia L.',
      'Mendoza, Daniella J.',
      'Miave James Frederick',
      'Montemayor, Carl Denver H.',
      'Murillo, Jan Manuel',
      'Oriñada Joshua D.',
      'Osorio, Jeseiah Marie Y.',
      'Pacleb, Jerome Carlo G.',
      'Panguelo, Clarence Brent F.',
      'Panganiban, Lester',
      'Patawaran, Omner James C.',
      'Perez, Chezter Anthony I.',
      'Policarpio, Dallin Russell O.',
      'Pradez, James Paul M.',
      'Prestosa, Angel Jamil P.',
      'ramales charis shane',
      'Reboldera, Joshua Samuel A.',
      'Reyes, Danly',
      'Reyes, Rojan Aizel F.',
      'Sajuela, Renz Kerby',
      'Saulo Ethan Xander V.',
      'Tamayo, Francis John M.',
      'Tan, Albrecht Jhon',
      'Villegas Kezia'
      /* Paste your roster here — one name per line */
      /* Example format: 'Last Name, First Name M.' */
    ]
  }

  /* Add more sections as needed:
  {
    sectionId:   'it201_b',
    courseName:  'IT 201',
    sectionName: 'Section B',
    students: [ ... ]
  },
  */
];

/* ── Seed Logic ──────────────────────────────────────────── */

async function seedCourses() {
  const args = process.argv.slice(2);
  const wipe = args.includes('--wipe');

  if (wipe) {
    console.log('[seed] Wiping existing kuwago/courses data...');
    await db.ref('kuwago/courses').remove();
    console.log('[seed] Wiped.');
  }

  let totalStudents = 0;

  for (const course of COURSES) {
    const { sectionId, courseName, sectionName, students } = course;

    if (!sectionId) { console.warn('[seed] Skipping course with no sectionId'); continue; }

    console.log(`\n[seed] Seeding ${courseName} — ${sectionName} (${sectionId})`);
    console.log(`[seed]   ${students.length} students`);

    /* Write course metadata */
    await db.ref(`kuwago/courses/${sectionId}`).update({ courseName, sectionName });

    /* Write each student */
    const studentUpdates = {};
    for (const name of students) {
      if (!name || !name.trim()) continue;
      const key = sanitizeName(name.trim());
      studentUpdates[key] = { name: name.trim(), aliases: [] };
    }

    if (Object.keys(studentUpdates).length > 0) {
      await db.ref(`kuwago/courses/${sectionId}/students`).update(studentUpdates);
    }

    totalStudents += students.length;
    console.log(`[seed]   ✓ Wrote ${Object.keys(studentUpdates).length} students`);
  }

  console.log(`\n[seed] Done. ${COURSES.length} course(s), ${totalStudents} student(s) seeded.`);
  console.log('[seed] Open your Firebase console to verify:');
  console.log('  https://console.firebase.google.com/project/kuwago-d6c14/database');
}

/* ── Fetch roster from Apps Script (optional migration path) ── */

/**
 * If you want to automatically pull the roster from the
 * existing Google Sheet instead of manually editing COURSES above,
 * call this function with your Apps Script endpoint URL and section ID.
 *
 * This is commented out — uncomment and configure if needed.
 */
async function fetchRosterFromAppsScript(appsScriptUrl, sectionId) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const url = `${appsScriptUrl}?action=getCourses`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

/* ── Entry Point ─────────────────────────────────────────── */

seedCourses()
  .then(() => process.exit(0))
  .catch((err) => { console.error('[seed] Fatal error:', err); process.exit(1); });
