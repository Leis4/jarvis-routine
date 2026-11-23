'use strict';
/* Recurrence + Russian quick-add parser regression (pure modules, no DOM). */
const assert = require('assert');
const path = require('path');
const R = require(path.join(__dirname, '..', 'site', 'recur.js'));
const P = require(path.join(__dirname, '..', 'site', 'parse-ru.js'));

const TODAY = '2026-11-16'; // Monday, even (чётная) week under the 9 Nov 2026 anchor
const ctx = { today: TODAY, nowMinutes: 14 * 60 };

/* ── university parity anchor ─────────────────────────────────────── */
assert.equal(R.indexDay('2026-11-16'), 0, 'Monday must be day 0');
assert.equal(R.parityOf('2026-11-09'), 0, '9 Nov 2026 is the odd (нечётная) week');
assert.equal(R.parityOf('2026-11-16'), 1, '16 Nov 2026 is the even (чётная) week');
assert.equal(R.parityOf('2026-11-23'), 0, 'parity alternates weekly');
assert.equal(R.mondayOf('2026-11-22'), '2026-11-16');
console.log('OK parity anchor matches the university cycle');

/* ── legacy repeat values keep their exact old meaning ────────────── */
const base = { fromDate: '2026-11-02', repeat: 'once' };
assert.ok(R.occursOn(base, '2026-11-02'));
assert.ok(!R.occursOn(base, '2026-11-03'));
assert.ok(R.occursOn({ ...base, repeat: 'daily' }, '2026-12-25'));
assert.ok(R.occursOn({ ...base, repeat: 'weekly' }, '2026-11-09'));
assert.ok(!R.occursOn({ ...base, repeat: 'weekly' }, '2026-11-10'));
assert.ok(R.occursOn({ ...base, repeat: 'biweekly' }, '2026-11-16'));
assert.ok(!R.occursOn({ ...base, repeat: 'biweekly' }, '2026-11-09'));
assert.ok(R.occursOn({ ...base, repeat: 'every3', intervalDays: 3 }, '2026-11-08'));
assert.ok(!R.occursOn({ ...base, repeat: 'every3', intervalDays: 3 }, '2026-11-09'));
assert.ok(R.occursOn({ ...base, repeat: 'weekdays', repeatDays: [0, 2] }, '2026-11-18'));
assert.ok(!R.occursOn({ ...base, repeat: 'weekdays', repeatDays: [0, 2] }, '2026-11-17'));
console.log('OK daily/weekly/biweekly/once/everyN/weekdays keep legacy semantics');

/* ── new rules: parity, end date, exceptions, pause ──────────────── */
const oddTues = { fromDate: '2026-11-03', repeat: 'parity', parity: 0, repeatDays: [1] };
assert.equal(R.parityOf('2026-11-10'), 0, '10 Nov 2026 is in the odd week');
assert.ok(R.occursOn(oddTues, '2026-11-10'), 'Tuesday of the odd week occurs');
assert.ok(!R.occursOn(oddTues, '2026-11-17'), 'Tuesday of the even week must not occur');
assert.ok(!R.occursOn(oddTues, '2026-11-11'), 'only the selected weekday');
assert.ok(!R.occursOn({ ...oddTues, repeatUntil: '2026-11-10' }, '2026-11-24'), 'repeatUntil ends the series');
assert.ok(!R.occursOn({ ...oddTues, exceptions: ['2026-11-10'] }, '2026-11-10'), 'exceptions skip a single occurrence');
assert.ok(!R.occursOn({ ...oddTues, paused: true }, '2026-11-10'), 'paused series has no occurrences');
assert.equal(R.validate({ repeat: 'parity', parity: 0, repeatDays: [] }), 'Выбери хотя бы один день недели');
assert.equal(R.validate({ repeat: 'everyN', intervalDays: 200, repeatDays: [] }), 'Интервал должен быть от 1 до 90 дней');
assert.equal(R.validate({ repeat: 'daily' }), null);
console.log('OK parity/until/exceptions/paused and validation behave');

/* ── bounded expansion, never materialised ──────────────────────── */
const dates = R.nextDates({ fromDate: TODAY, repeat: 'weekly', repeatDays: [0] }, TODAY, 3);
assert.deepEqual(dates, ['2026-11-16', '2026-11-23', '2026-11-30']);
assert.equal(R.nextDates({ fromDate: TODAY, repeat: 'daily' }, TODAY, 60).length, 60, 'daily expansion is capped at the requested count');
assert.ok(R.nextDates({ fromDate: TODAY, repeat: 'weekly' }, TODAY, 60).length <= 60, 'weekly expansion stays bounded by the horizon');
assert.equal(R.occurrencesInRange({ fromDate: TODAY, repeat: 'daily' }, TODAY, '2026-11-20').length, 5);
console.log('OK nextDates is bounded and deterministic');

/* ── Russian quick-add parser ───────────────────────────────────── */
const cases = [
  ['Завтра в 17', r => r.date === '2026-11-17' && r.time === '17:00' && r.confident],
  ['Python завтра 18:00 на 45 минут', r => r.title === 'Python' && r.date === '2026-11-17' && r.time === '18:00' && r.durationMin === 45],
  ['через три дня', r => r.date === '2026-11-19'],
  ['на следующей неделе', r => r.date === '2026-11-23'],
  ['послезавтра утром', r => r.date === '2026-11-18' && r.time === '09:00'],
  ['в конце ноября', r => r.date === '2026-11-30'],
  ['в пятницу после пар', r => r.date === '2026-11-20' && r.after && r.after.kind === 'classes'],
  ['после тренировки', r => r.after && r.after.kind === 'gym'],
  ['перенеси на 20 минут', r => r.relative && r.relative.minutes === 20],
  ['каждый вторник', r => r.repeat && r.repeat.repeat === 'weekly' && r.repeat.repeatDays[0] === 1],
  ['каждую нечётную неделю', r => r.repeat && r.repeat.repeat === 'parity' && r.repeat.parity === 0],
  ['17 ноября', r => r.date === '2026-11-17'],
  ['16.11', r => r.date === '2026-11-16' && r.time === null],
  ['Разобрать теорию вероятностей на 90 минут', r => r.durationMin === 90 && /теорию/i.test(r.title)],
  ['просто список покупок', r => !r.confident && r.title === 'просто список покупок'],
];
for (const [text, check] of cases) {
  const r = P.parse(text, ctx);
  assert.ok(check(r), `parse(${JSON.stringify(text)}) -> ${JSON.stringify(r)}`);
}
console.log('OK Russian phrases parse deterministically (' + cases.length + ' cases)');

/* ── schedule-dependent resolution of «после пар» ────────────────── */
const items = [
  { name: 'Лекция', cat: 'Университет', start: '10:00', end: '11:30' },
  { name: 'Практика', cat: 'Университет', start: '12:00', end: '13:30' },
  { name: 'Зал', cat: 'Спорт', start: '19:00', end: '20:30' },
];
const afterClasses = P.resolveAfter(P.parse('завтра после пар на 60 минут', ctx), items, { buffer: 10 });
assert.equal(afterClasses.start, '13:40', 'starts after the last class plus buffer');
assert.equal(afterClasses.end, '14:40', 'keeps the requested 60 minutes');
const afterGym = P.resolveAfter(P.parse('после тренировки', ctx), items, { buffer: 15 });
assert.equal(afterGym.start, '20:45');
assert.equal(P.resolveAfter(P.parse('после обеда', ctx), items), null, 'no lunch in the schedule -> no invented time');
console.log('OK «после пар» resolves against the real schedule, never invents a slot');

console.log('ALL recurrence + parser checks passed');
