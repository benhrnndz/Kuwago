/* ════════════════════════════════════════════════════════════
   Code.gs — Slim Session Report Exporter (v3)

   The Kuwago dashboard has migrated to Firebase RTDB for all
   real-time operations. This script retains a single purpose:
   write a post-session summary to the "Kuwago Reports"
   Google Spreadsheet when the professor clicks "End Class".

   Only ONE endpoint is active:
     POST { action: 'exportSessionSummary', summary: { ... } }

   All other endpoints (dashboardData, logEvent, setPrompt,
   heartbeat, etc.) have been removed. Those operations now
   go directly to Firebase RTDB.
   ════════════════════════════════════════════════════════════ */

/* ── CORS headers ────────────────────────────────────────── */
var CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

/* ── Target Spreadsheet ──────────────────────────────────── */

/**
 * Name of the report spreadsheet that is created on first use.
 * The file is placed in the same Drive folder as this script's
 * parent spreadsheet.
 */
var REPORTS_SPREADSHEET_NAME = 'Kuwago Reports';

/* ════════════════════════════════════════════════════════════
   HTTP HANDLERS
   ════════════════════════════════════════════════════════════ */

/**
 * Handle CORS preflight (OPTIONS) or any unexpected GET.
 */
function doGet(e) {
  return jsonResponse({ ok: true, version: 3, message: 'Kuwago report exporter. Use POST to export.' });
}

/**
 * Handle POST requests.
 * Only action: 'exportSessionSummary' is supported.
 */
function doPost(e) {
  /* Support both JSON body and urlencoded body */
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonResponse({ error: 'Invalid JSON body' });
  }

  var action = body.action;

  if (action === 'exportSessionSummary') {
    return jsonResponse(exportSessionSummary(body.summary));
  }

  return jsonResponse({ error: 'Unknown action: ' + action });
}

/* ════════════════════════════════════════════════════════════
   EXPORT SESSION SUMMARY
   ════════════════════════════════════════════════════════════ */

/**
 * Write a session summary to a new sheet tab in the
 * "Kuwago Reports" spreadsheet.
 *
 * Summary shape sent by session.js:
 * {
 *   sessionId:  string,
 *   sectionId:  string,
 *   startedAt:  ISO string,
 *   endedAt:    ISO string,
 *   students: [{
 *     name, attendanceStatus, liveStatus,
 *     focusLapses?, attentivenessPct?, answered?, issued?, participationPct?
 *   }]
 * }
 *
 * @param {Object} summary
 * @returns {{ ok: boolean, sheetName: string } | { error: string }}
 */
function exportSessionSummary(summary) {
  if (!summary) return { error: 'Missing summary' };
  if (!summary.sessionId) return { error: 'Missing sessionId' };

  try {
    /* Get or create the Reports spreadsheet */
    var ss = getOrCreateReportsSpreadsheet();

    /* Sheet tab name: Section + date, e.g. "IT101A 2026-10-17" */
    var dateStr   = new Date(summary.startedAt || Date.now())
      .toLocaleDateString('en-CA');  /* YYYY-MM-DD */
    var sheetName = (summary.sectionId || 'Session').replace(/[^a-zA-Z0-9 _-]/g, '') + ' ' + dateStr;

    /* Ensure unique name if multiple sessions on same day */
    var allSheets    = ss.getSheets().map(function(s) { return s.getName(); });
    var uniqueName   = sheetName;
    var suffixCount  = 1;
    while (allSheets.indexOf(uniqueName) !== -1) {
      uniqueName = sheetName + ' (' + suffixCount + ')';
      suffixCount++;
    }

    /* Create the sheet */
    var sheet = ss.insertSheet(uniqueName);

    /* ── Metadata header ─────────────────────────────────── */
    sheet.getRange('A1').setValue('Kuwago Session Report');
    sheet.getRange('A1').setFontWeight('bold').setFontSize(14);

    sheet.getRange('A3').setValue('Session ID');
    sheet.getRange('B3').setValue(summary.sessionId);

    sheet.getRange('A4').setValue('Section');
    sheet.getRange('B4').setValue(summary.sectionId || '');

    sheet.getRange('A5').setValue('Started At');
    sheet.getRange('B5').setValue(summary.startedAt ? new Date(summary.startedAt) : '');
    sheet.getRange('B5').setNumberFormat('yyyy-mm-dd hh:mm:ss');

    sheet.getRange('A6').setValue('Ended At');
    sheet.getRange('B6').setValue(summary.endedAt ? new Date(summary.endedAt) : '');
    sheet.getRange('B6').setNumberFormat('yyyy-mm-dd hh:mm:ss');

    /* Duration */
    if (summary.startedAt && summary.endedAt) {
      var durationMs = new Date(summary.endedAt) - new Date(summary.startedAt);
      var mins       = Math.round(durationMs / 60000);
      sheet.getRange('A7').setValue('Duration');
      sheet.getRange('B7').setValue(mins + ' minutes');
    }

    sheet.getRange('A3:A7').setFontWeight('bold');

    /* ── Student data table ──────────────────────────────── */
    var students = summary.students || [];
    var startRow = 9;

    /* Detect available columns from the first student record */
    var hasDetailedStats = students.length > 0 && students[0].focusLapses !== undefined;

    var headers;
    if (hasDetailedStats) {
      headers = [
        'Student Name', 'Attendance', 'Focus Lapses',
        'Attentiveness %', 'Prompts Answered', 'Prompts Issued', 'Participation %'
      ];
    } else {
      headers = ['Student Name', 'Attendance'];
    }

    /* Header row */
    var headerRange = sheet.getRange(startRow, 1, 1, headers.length);
    headerRange.setValues([headers]);
    headerRange.setFontWeight('bold');
    headerRange.setBackground('#4F46E5');
    headerRange.setFontColor('#FFFFFF');

    /* Data rows */
    if (students.length > 0) {
      var rows = students.map(function(s) {
        if (hasDetailedStats) {
          return [
            s.name                  || '',
            s.attendanceStatus      || 'Absent',
            s.focusLapses           != null ? s.focusLapses        : 0,
            s.attentivenessPct      != null ? s.attentivenessPct   : 0,
            s.answered              != null ? s.answered           : 0,
            s.issued                != null ? s.issued             : 0,
            s.participationPct      != null ? s.participationPct   : 0
          ];
        } else {
          return [s.name || '', s.attendanceStatus || 'Absent'];
        }
      });

      sheet.getRange(startRow + 1, 1, rows.length, headers.length).setValues(rows);

      /* Colour-code attendance column (col 2) */
      var attCol = sheet.getRange(startRow + 1, 2, rows.length, 1);
      attCol.setValues(rows.map(function(r) { return [r[1]]; }));

      /* Auto-resize columns */
      for (var c = 1; c <= headers.length; c++) {
        sheet.autoResizeColumn(c);
      }
    }

    /* ── Summary stats at the bottom ─────────────────────── */
    var totalRow     = startRow + students.length + 2;
    var presentCount = students.filter(function(s) {
      return s.attendanceStatus === 'Present' || s.attendanceStatus === 'Late';
    }).length;

    sheet.getRange(totalRow, 1).setValue('Total Joined').setFontWeight('bold');
    sheet.getRange(totalRow, 2).setValue(presentCount + ' / ' + students.length);

    /* Freeze top rows */
    sheet.setFrozenRows(startRow);

    Logger.log('exportSessionSummary: wrote ' + students.length + ' students to ' + uniqueName);

    return {
      ok:           true,
      sheetName:    uniqueName,
      studentCount: students.length,
      url:          ss.getUrl() + '#gid=' + sheet.getSheetId()
    };

  } catch (err) {
    Logger.log('exportSessionSummary ERROR: ' + err.message);
    return { error: err.message };
  }
}

/* ════════════════════════════════════════════════════════════
   SPREADSHEET HELPER
   ════════════════════════════════════════════════════════════ */

/**
 * Get the "Kuwago Reports" spreadsheet, creating it if absent.
 * The spreadsheet is placed in the professor's My Drive root.
 * @returns {GoogleAppsScript.Spreadsheet.Spreadsheet}
 */
function getOrCreateReportsSpreadsheet() {
  var files = DriveApp.getFilesByName(REPORTS_SPREADSHEET_NAME);
  while (files.hasNext()) {
    var file = files.next();
    if (file.getMimeType() === MimeType.GOOGLE_SHEETS) {
      return SpreadsheetApp.openById(file.getId());
    }
  }

  /* Create new spreadsheet */
  var ss = SpreadsheetApp.create(REPORTS_SPREADSHEET_NAME);

  /* Remove default empty sheet */
  var defaultSheet = ss.getActiveSheet();
  ss.insertSheet('About');
  ss.deleteSheet(defaultSheet);

  /* Write a welcome message on the About sheet */
  var about = ss.getSheetByName('About');
  about.getRange('A1').setValue('Kuwago Session Reports');
  about.getRange('A1').setFontWeight('bold').setFontSize(16);
  about.getRange('A3').setValue(
    'This spreadsheet is automatically populated by the Kuwago dashboard.\n' +
    'Each session creates a new tab when the professor clicks "End Class".'
  );
  about.getRange('A3').setWrap(true);
  about.setColumnWidth(1, 500);

  Logger.log('Created new Kuwago Reports spreadsheet: ' + ss.getId());
  return ss;
}

/* ════════════════════════════════════════════════════════════
   UTILITY
   ════════════════════════════════════════════════════════════ */

/**
 * Return a JSON ContentService response with CORS headers.
 * @param {Object} data
 */
function jsonResponse(data) {
  var output = ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
  return output;
}

/* ════════════════════════════════════════════════════════════
   MANUAL TEST HELPERS
   Run from the Apps Script editor to verify behavior.
   ════════════════════════════════════════════════════════════ */

/**
 * Test: export a dummy session summary.
 * Run this from the editor (Run → testExportSummary) to verify
 * the spreadsheet is created and the sheet is populated.
 */
function testExportSummary() {
  var summary = {
    sessionId:  'cls_test_' + Date.now(),
    sectionId:  'IT101A',
    startedAt:  new Date(Date.now() - 60 * 60 * 1000).toISOString(), /* 1 hour ago */
    endedAt:    new Date().toISOString(),
    students: [
      { name: 'Dela Cruz, Juan A.',     attendanceStatus: 'Present' },
      { name: 'Santos, Maria B.',       attendanceStatus: 'Late'    },
      { name: 'Reyes, Carlos C.',       attendanceStatus: 'Absent'  },
      { name: 'Garcia, Angela D.',      attendanceStatus: 'Present' }
    ]
  };

  var result = exportSessionSummary(summary);
  Logger.log('testExportSummary result: ' + JSON.stringify(result));
}
