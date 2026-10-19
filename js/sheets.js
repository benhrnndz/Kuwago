/* ═══════════════════════════════════════════════════════════
   sheets.js — Write session reports directly to Google Sheets
   using the professor's own Google OAuth token.

   No Apps Script needed. The professor's token (captured at
   sign-in) gives us permission to create/write spreadsheets
   in their own Google Drive.
   ═══════════════════════════════════════════════════════════ */

import { getGoogleAccessToken, getCurrentUser } from './firebase.js';

const SHEETS_API   = 'https://sheets.googleapis.com/v4/spreadsheets';
const DRIVE_API    = 'https://www.googleapis.com/drive/v3/files';
const REPORTS_NAME = 'Kuwago Reports';

/* ── Helpers ──────────────────────────────────────────────── */

function _authHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type':  'application/json'
  };
}

/** Find the "Kuwago Reports" spreadsheet in the professor's Drive, or create it. */
async function _getOrCreateSpreadsheet(token) {
  /* Search for an existing file */
  const q   = encodeURIComponent(`name='${REPORTS_NAME}' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`);
  const res = await fetch(`${DRIVE_API}?q=${q}&fields=files(id,name)&pageSize=1`, {
    headers: _authHeaders(token)
  });
  if (!res.ok) throw new Error(`Drive search failed: ${res.status}`);
  const { files } = await res.json();

  if (files && files.length > 0) return files[0].id;

  /* Create a new spreadsheet */
  const create = await fetch(SHEETS_API, {
    method:  'POST',
    headers: _authHeaders(token),
    body:    JSON.stringify({ properties: { title: REPORTS_NAME } })
  });
  if (!create.ok) throw new Error(`Spreadsheet create failed: ${create.status}`);
  const sheet = await create.json();
  return sheet.spreadsheetId;
}

/** Get existing sheet tab names in a spreadsheet. */
async function _getSheetNames(token, spreadsheetId) {
  const res = await fetch(`${SHEETS_API}/${spreadsheetId}?fields=sheets.properties.title`, {
    headers: _authHeaders(token)
  });
  if (!res.ok) throw new Error(`Fetch sheet metadata failed: ${res.status}`);
  const data = await res.json();
  return (data.sheets || []).map(s => s.properties.title);
}

/** Add a new sheet tab and write the session report data into it. */
async function _writeReport(token, spreadsheetId, sheetName, summary) {
  const { students, sessionId, sectionId, startedAt, endedAt } = summary;

  /* ── Build rows ─────────────────────────────────────────── */
  const fmt = (iso) => iso ? new Date(iso).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
  const pct = (v)  => v != null ? `${Math.round(v)}%` : '—';

  const headerRows = [
    ['Kuwago Session Report'],
    [],
    ['Session ID',  sessionId || '—',   '', 'Section',   sectionId || '—'],
    ['Started',     fmt(startedAt),      '', 'Ended',     fmt(endedAt)],
    [],
    ['Student', 'Attendance', 'Focus Lapses', 'Attentiveness', 'Prompts Answered', 'Total Prompts', 'Participation']
  ];

  const dataRows = (students || []).map(s => [
    s.name             || '—',
    s.attendanceStatus || '—',
    s.focusLapses      ?? 0,
    pct(s.attentivenessPct),
    s.answered         ?? 0,
    s.issued           ?? 0,
    pct(s.participationPct)
  ]);

  const allRows = [...headerRows, ...dataRows];

  /* ── Batch update: add sheet tab + write data ───────────── */
  const batchRes = await fetch(`${SHEETS_API}/${spreadsheetId}:batchUpdate`, {
    method:  'POST',
    headers: _authHeaders(token),
    body: JSON.stringify({
      requests: [
        { addSheet: { properties: { title: sheetName } } }
      ]
    })
  });
  if (!batchRes.ok) {
    const err = await batchRes.text();
    throw new Error(`Add sheet tab failed: ${batchRes.status} — ${err.slice(0, 200)}`);
  }
  const batchData = await batchRes.json();
  const newSheetId = batchData.replies?.[0]?.addSheet?.properties?.sheetId;

  /* Write data */
  const range = `'${sheetName}'!A1`;
  const writeRes = await fetch(
    `${SHEETS_API}/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
    {
      method:  'PUT',
      headers: _authHeaders(token),
      body:    JSON.stringify({ range, majorDimension: 'ROWS', values: allRows })
    }
  );
  if (!writeRes.ok) throw new Error(`Write data failed: ${writeRes.status}`);

  /* Format: bold header row */
  await fetch(`${SHEETS_API}/${spreadsheetId}:batchUpdate`, {
    method:  'POST',
    headers: _authHeaders(token),
    body: JSON.stringify({
      requests: [
        {
          repeatCell: {
            range:  { sheetId: newSheetId, startRowIndex: 5, endRowIndex: 6 },
            cell:   { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.22, green: 0.38, blue: 0.92 } } },
            fields: 'userEnteredFormat(textFormat,backgroundColor)'
          }
        },
        {
          repeatCell: {
            range:  { sheetId: newSheetId, startRowIndex: 0, endRowIndex: 1 },
            cell:   { userEnteredFormat: { textFormat: { bold: true, fontSize: 14 } } },
            fields: 'userEnteredFormat.textFormat'
          }
        },
        { autoResizeDimensions: { dimensions: { sheetId: newSheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 7 } } }
      ]
    })
  });

  return { sheetId: newSheetId };
}

/* ── Public API ───────────────────────────────────────────── */

/**
 * Write a session summary to a new tab in the professor's
 * "Kuwago Reports" Google Spreadsheet.
 *
 * @param {Object} summary — from buildSessionSummary()
 * @returns {Promise<{ ok: boolean, sheetName: string, url: string }>}
 */
export async function exportToSheets(summary) {
  const token = getGoogleAccessToken();
  if (!token) throw new Error('Not signed in with Google — please sign out and sign in again.');

  /* Sheet tab name: "IT101A 2026-10-19" */
  const dateStr   = new Date(summary.startedAt || Date.now()).toLocaleDateString('en-CA');
  const baseName  = (summary.sectionId || 'Session').replace(/[^a-zA-Z0-9 _-]/g, '') + ' ' + dateStr;

  /* Get or create the spreadsheet */
  const spreadsheetId = await _getOrCreateSpreadsheet(token);

  /* Ensure unique tab name */
  const existing  = await _getSheetNames(token, spreadsheetId);
  let sheetName   = baseName;
  let suffix      = 1;
  while (existing.includes(sheetName)) {
    sheetName = `${baseName} (${suffix++})`;
  }

  await _writeReport(token, spreadsheetId, sheetName, summary);

  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
  return { ok: true, sheetName, url, spreadsheetId };
}
