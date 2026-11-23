'use strict';
/* Flexible schedule policy (jarvis-flexible-schedule-policy-v1) regression.
   Pure module: no DOM. The personal policy file lives in private/ and is
   skipped automatically when absent. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const F = require(path.join(__dirname, '..', 'site', 'flex.js'));
const R = require(path.join(__dirname, '..', 'site', 'recur.js'));

const PRIVATE = path.join(__dirname, '..', 'private', 'jarvis-flexible-schedule-v1.json');
const hasPrivate = fs.existsSync(PRIVATE);

/* ── defaults are always usable, with or without the private file ── */
assert.equal(F.DEFAULT_POLICY.schema, 'jarvis-flexible-schedule-policy-v1');
assert.equal(F.DEFAULT_POLICY.carryoverDays, 3);
assert.deepEqual(F.DEFAULT_POLICY.missedTaskChoices, ['reschedule', 'shorten', 'skip']);
assert.deepEqual(F.DEFAULT_POLICY.protected, ['mandatoryClasses', 'sleep', 'confirmedDeadlines']);
assert.equal(F.DEFAULT_POLICY.progressMetric, 'percent_required_tasks_completed');
assert.equal(F.DEFAULT_POLICY.weekMinutes.target, 720);
assert.equal(F.DEFAULT_POLICY.focusUnitMinutes, 40);
assert.equal(F.DEFAULT_POLICY.minimumBlockMinutes, 25);
assert.deepEqual(F.DEFAULT_POLICY.gym.weekdays, [], 'no personal gym days ship in site/');
assert.deepEqual(F.DEFAULT_POLICY.family.weekdays, [], 'no personal family days ship in site/');
assert.equal(F.DEFAULT_POLICY.exam.date, null, 'the personal exam never ships in site/');
console.log('OK generic default policy is complete, app-indexed and free of personal values');

/* ── late bands: 10 min must not cascade, 2 h must replan the future ── */
assert.equal(F.lateBand(0).action, 'compress_optional_buffers');
assert.equal(F.lateBand(10).action, 'compress_optional_buffers');
assert.equal(F.lateBand(15).action, 'compress_optional_buffers');
assert.equal(F.lateBand(16).action, 'preview_confirm');
assert.equal(F.lateBand(45).action, 'preview_confirm');
assert.equal(F.lateBand(120).action, 'replan_future_confirm');
assert.equal(F.lateBand(1440).action, 'replan_future_confirm');
console.log('OK late 10 min compresses buffers, 30 min previews, 2 h replans the future');

/* ── energy modes ── */
assert.equal(F.energyKey(1), 'low');
assert.equal(F.energyKey(2), 'low');
assert.equal(F.energyKey(3), 'normal');
assert.equal(F.energyKey(4), 'high');
assert.equal(F.energyKey(5), 'high');
const low = F.energyPlan(F.DEFAULT_POLICY, 'low');
assert.equal(low.focusMinutes, 25);
assert.equal(low.maxFocusBlocks, 1);
assert.equal(low.skipOptionalReading, true);
assert.equal(F.energyPlan(F.DEFAULT_POLICY, 'normal').focusMinutes, 40);
assert.equal(F.energyPlan(F.DEFAULT_POLICY, 'high').maxExtraBlocks, 1);
console.log('OK low energy = 1×25 min, normal = 40, high = +1 block');

/* ── carry-over is bounded to the next 3 days ── */
assert.deepEqual(F.carryoverTargets('2026-11-16', 3), ['2026-11-17', '2026-11-18', '2026-11-19']);
assert.deepEqual(F.carryoverTargets('2026-11-30', 3), ['2026-12-01', '2026-12-02', '2026-12-03'], 'month rollover');
assert.equal(F.carryoverTargets('2026-11-16', 5).length, 5, 'limit follows the policy value');
console.log('OK missed flexible tasks carry over at most 3 days (no duplicates by key)');

/* ── progress metric: required only ── */
assert.deepEqual(F.requiredPercent([{ required: true, done: true }, { required: true, done: false }, { required: false, done: false }]), { percent: 50, done: 1, total: 2 });
assert.deepEqual(F.requiredPercent([]), { percent: 100, done: 0, total: 0 });
console.log('OK progress counts REQUIRED tasks only, optional/routine excluded');

/* ── university parity: 16 Nov is even, 24 Nov is odd ── */
assert.equal(R.parityOf('2026-11-16'), 1, '16 Nov 2026 = чётная week');
assert.equal(R.parityOf('2026-11-24'), 0, '24 Nov 2026 = нечётная week');
console.log('OK two-week parity anchors hold (even Mon 16.11 / odd Tue 24.11)');

/* ── exam window comes from the imported policy, never from public defaults ── */
assert.equal(F.examActive(F.DEFAULT_POLICY, '2026-11-17'), false, 'no exam is assumed before the user imports a policy');
const examPolicy = F.normalizePolicy({ schema: F.SCHEMA, studyAndCareer: { exam: { subject: 'X', date: '2026-11-24', preparationBetween: '2026-11-16..2026-11-23' } } });
assert.equal(F.examActive(examPolicy, '2026-11-17'), true);
assert.equal(F.examActive(examPolicy, '2026-11-24'), true);
assert.equal(F.examActive(examPolicy, '2026-11-25'), false);
assert.equal(F.examActive(examPolicy, '2026-11-15'), false);
console.log('OK exam priority window follows the imported policy, nothing invented outside it');

/* ── validation refuses junk and accepts the real policy ── */
assert.equal(F.validatePolicy(null).ok, false);
assert.equal(F.validatePolicy({ schema: 'something-else' }).ok, false);
assert.equal(F.validatePolicy({ schema: F.SCHEMA, qaGates: { privateTemplateOriginalBlocks: 100 } }).ok, false, 'a policy expecting the wrong block count is rejected');
assert.equal(F.validatePolicy({ schema: F.SCHEMA, qaGates: { privateTemplateOriginalBlocks: 392 }, planner: { ifRunningLateByMinutes: [1, 2] } }).ok, false, 'incomplete late rule is rejected');

if (hasPrivate) {
  const raw = JSON.parse(fs.readFileSync(PRIVATE, 'utf8'));
  const v = F.validatePolicy(raw);
  assert.equal(v.ok, true, 'real policy must validate: ' + v.errors.join('; '));
  const p = F.normalizePolicy(raw);
  assert.equal(p.schema, F.SCHEMA);
  assert.equal(p.exam.date, '2026-11-24');
  assert.equal(p.exam.subject, 'Теория вероятностей');
  assert.equal(p.exam.preparationFrom, '2026-11-16');
  assert.equal(p.exam.preparationTo, '2026-11-23');
  assert.equal(p.carryoverDays, 3);
  assert.equal(p.weekMinutes.target, 720);
  assert.equal(p.focusUnitMinutes, 40);
  assert.equal(p.morning.minMinutes, 45);
  assert.equal(p.morning.maxMinutes, 60);
  assert.equal(p.sleep.weekdayBedtime, '23:30');
  assert.equal(p.sleep.weekdayWake, '07:25');
  assert.equal(p.sleep.weekendBedtime, '00:00');
  assert.equal(p.sleep.minMinutes, 450);
  assert.deepEqual(p.gym.weekdays, [1, 3, 5], 'exercise.preferredWeekdays 2,4,6 -> 0-indexed 1,3,5');
  assert.deepEqual(p.family.weekdays, [3, 4, 5, 6], 'family.recurrenceWeekdays 4,5,6,7 -> 3,4,5,6');
  assert.equal(p.family.start, '19:00');
  assert.equal(p.family.end, '21:30');
  assert.equal(p.late.length, 3);
  assert.equal(F.lateBand(10, p).action, 'compress_optional_buffers');
  assert.equal(F.lateBand(30, p).action, 'preview_confirm');
  assert.equal(F.lateBand(90, p).action, 'replan_future_confirm');
  assert.ok(p.mandatorySubjects.some(s => /вероят/i.test(s)), 'mandatory subjects come from the questionnaire');
  assert.equal(F.validatePolicy(F.normalizePolicy(raw)).ok, true, 'normalised policy stays valid (idempotent)');
  console.log('OK the real 91-answer policy normalises into the app policy');
} else {
  console.log('SKIP private policy file (not present on this machine)');
}

console.log('ALL flexible-policy checks passed');
