import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDashboardData } from '../js/engagement.js';

function makeState() {
  return {
    session: {
      active: true,
      sessionId: 'cls_test',
      sectionId: 'section-a',
      startedAt: '2026-10-19T10:00:00.000Z'
    },
    students: [
      { sectionId: 'section-a', name: 'Roster, Student' }
    ],
    attendance: {
      'roster-student': {
        joinTime: '2026-10-19T10:01:00.000Z',
        leaveTime: null,
        status: 'Present'
      },
      'outsider-account': {
        detectedName: 'Outsider Account',
        joinTime: '2026-10-19T10:02:00.000Z',
        leaveTime: null,
        status: 'Present'
      },
      'outsider-account-copy': {
        detectedName: 'Outsider Account',
        joinTime: '2026-10-19T10:03:00.000Z',
        leaveTime: null,
        status: 'Present'
      }
    },
    focusEvents: [],
    prompts: {},
    responses: [],
    heartbeats: {
      'outsider-account': { at: Date.now(), detectedName: 'Outsider Account' }
    }
  };
}

test('builds one unmatched row for an unknown attendance identity', () => {
  const data = buildDashboardData(makeState());
  const unmatched = data.students.filter(student => !student.matched);

  assert.equal(unmatched.length, 1);
  assert.deepEqual(unmatched[0], {
    name: 'Outsider Account',
    liveStatus: 'on_meet',
    attendanceStatus: null,
    activeAlerts: [],
    matched: false,
    action: 'Unmatched'
  });
});

test('does not classify a normalized roster identity as unmatched', () => {
  const data = buildDashboardData(makeState());

  assert.deepEqual(
    data.students.filter(student => student.matched).map(student => student.name),
    ['Roster, Student']
  );
  assert.equal(data.students.some(student => student.name === 'Roster, Student' && !student.matched), false);
});
