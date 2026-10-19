import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDashboardData } from '../js/engagement.js';

test('keeps unknown session identities out of roster counts and in unmatched data', () => {
  const now = Date.now();
  const data = buildDashboardData({
    session: {
      active: true,
      sessionId: 'cls_flow',
      sectionId: 'section-a',
      startedAt: new Date(now - 60_000).toISOString()
    },
    students: [
      { sectionId: 'section-a', name: 'Roster, Student' },
      { sectionId: 'section-b', name: 'Other, Section' }
    ],
    attendance: {
      roster_student: {
        joinTime: new Date(now - 30_000).toISOString(),
        leaveTime: null,
        status: 'Present'
      },
      outsider_account: {
        detectedName: 'Outsider Account',
        joinTime: new Date(now - 20_000).toISOString(),
        leaveTime: null,
        status: 'Present'
      }
    },
    focusEvents: [
      { student: 'roster_student', type: 'regained', at: now - 10_000 },
      { student: 'outsider_account', type: 'regained', at: now - 10_000 }
    ],
    prompts: {},
    responses: [],
    heartbeats: {
      roster_student: { at: now },
      outsider_account: { at: now }
    }
  });

  const rosterRows = data.students.filter(student => student.matched);
  const unmatchedRows = data.students.filter(student => !student.matched);

  assert.deepEqual(rosterRows.map(student => student.name), ['Roster, Student']);
  assert.deepEqual(unmatchedRows.map(student => student.name), ['Outsider Account']);
  assert.equal(unmatchedRows.length, 1);
  assert.equal(unmatchedRows[0].action, 'Unmatched');
  assert.equal(unmatchedRows[0].liveStatus, 'on_meet');
  assert.equal(rosterRows.length, 1);
  assert.equal(rosterRows.filter(student => student.liveStatus !== 'not_joined').length, 1);
});

test('does not retain unmatched entries when there is no active session', () => {
  const data = buildDashboardData({
    session: { active: false },
    students: [{ sectionId: 'section-a', name: 'Roster, Student' }],
    attendance: {
      outsider_account: {
        detectedName: 'Outsider Account',
        joinTime: new Date().toISOString(),
        leaveTime: null,
        status: 'Present'
      }
    },
    focusEvents: [],
    prompts: {},
    responses: [],
    heartbeats: {}
  });

  assert.equal(data.students.some(student => !student.matched), false);
});
