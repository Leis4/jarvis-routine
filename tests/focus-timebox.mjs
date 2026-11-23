// Focus Mode / timeboxing logic (site/focus-core.js).
// These tests target real failure modes of a phone timer:
//  - the PWA is suspended and the 1s interval stops firing (time must come from timestamps),
//  - a session is restored after reload in the middle of a run,
//  - timeboxing must never propose a slot that overlaps a fixed event.
import { createRequire } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const Core = require('../site/focus-core.js');

const MIN = 60000;
const base = 1_700_000_000_000; // fixed epoch, no wall-clock dependency

function session(over = {}) {
  return Core.normalize({ id: 'f1', taskId: 'p0_0_0', date: '2026-11-15', title: 'Матанализ', plannedMin: 25, createdAt: base, ...over }, base);
}

test('timer counts real elapsed time, not interval ticks', () => {
  let s = Core.start(session(), base);
  // 10 minutes pass while the app is in the background: no ticks at all.
  assert.equal(Math.round(Core.elapsedMs(s, base + 10 * MIN) / MIN), 10);
  assert.equal(Math.round(Core.remainingMs(s, base + 10 * MIN) / MIN), 15);
});

test('pause freezes elapsed time and resume does not double count', () => {
  let s = Core.start(session(), base);
  s = Core.pause(s, base + 5 * MIN);          // 5 min worked
  assert.equal(Core.elapsedMs(s, base + 60 * MIN), 5 * MIN); // frozen while paused
  s = Core.resume(s, base + 60 * MIN);
  assert.equal(Math.round(Core.elapsedMs(s, base + 65 * MIN) / MIN), 10);
  const fin = Core.finish(s, base + 65 * MIN);
  assert.equal(fin.running, false);
  assert.equal(Math.round(fin.actualMs / MIN), 10);
});

test('session restored after reload keeps accumulated time', () => {
  let s = Core.start(session(), base);
  const stored = JSON.parse(JSON.stringify(s)); // what localStorage holds
  const restored = Core.normalize(stored, base + 3 * MIN);
  assert.equal(Math.round(Core.elapsedMs(restored, base + 3 * MIN) / MIN), 3);
  // A stale clock in the future must not produce negative elapsed time.
  assert.equal(Core.elapsedMs(Core.normalize({ ...stored, startedAt: base + 9 * MIN }, base), base), 0);
});

test('overtime is reported as elapsed, never as negative remaining', () => {
  const s = Core.start(session({ plannedMin: 25 }), base);
  assert.equal(Core.remainingMs(s, base + 40 * MIN), 0);
  assert.equal(Math.round(Core.elapsedMs(s, base + 40 * MIN) / MIN), 40);
});

test('formatClock renders mm:ss and h:mm:ss', () => {
  assert.equal(Core.formatClock(0), '00:00');
  assert.equal(Core.formatClock(65_000), '01:05');
  assert.equal(Core.formatClock(3_725_000), '1:02:05');
});

test('freeWindows never overlaps a fixed event', () => {
  const busy = [
    { start: '09:00', end: '10:30' },
    { start: '19:00', end: '21:30' }, // protected evening event from the mission scenario
  ];
  const wins = Core.freeWindows(busy, { minutes: 50, from: '08:00', until: '23:30', buffer: 5, step: 5, limit: 6 });
  assert.ok(wins.length > 0, 'expected free slots');
  for (const w of wins) {
    for (const b of busy) {
      assert.ok(!Core.overlap({ start: w.startMin, end: w.endMin }, { start: Core.parseHM(b.start), end: Core.parseHM(b.end) }),
        `${w.start}-${w.end} overlaps ${b.start}-${b.end}`);
    }
  }
});

test('freeWindows respects buffers around fixed events', () => {
  const busy = [{ start: '12:00', end: '13:00' }];
  const wins = Core.freeWindows(busy, { minutes: 25, from: '11:00', until: '14:00', buffer: 10, step: 5, limit: 4 });
  for (const w of wins) {
    assert.ok(w.endMin <= Core.parseHM('12:00') || w.startMin >= Core.parseHM('13:10'),
      `${w.start}-${w.end} ignores the 10 min buffer`);
  }
});

test('freeWindows returns nothing when the day is full', () => {
  const busy = [{ start: '04:00', end: '23:30' }];
  assert.deepEqual(Core.freeWindows(busy, { minutes: 25, from: '04:00', until: '23:30', limit: 3 }), []);
});

test('freeWindows ignores malformed busy rows instead of crashing', () => {
  const busy = [{ start: 'abc', end: '10:00' }, null, { start: '10:00', end: '09:00' }, { start: '11:00', end: '12:00' }];
  const wins = Core.freeWindows(busy, { minutes: 30, from: '09:00', until: '14:00', limit: 3 });
  assert.ok(wins.length > 0);
  for (const w of wins) assert.ok(w.endMin <= Core.parseHM('11:00') || w.startMin >= Core.parseHM('12:00'));
});

test('currentAndNext picks the live item and the following one', () => {
  const rows = [
    { id: 'a', start: '09:00', end: '10:30' },
    { id: 'b', start: '10:40', end: '12:00' },
    { id: 'c', start: '19:00', end: '21:30' },
  ];
  const at = (hm) => Core.parseHM(hm);
  assert.equal(Core.currentAndNext(rows, at('10:00')).current.id, 'a');
  assert.equal(Core.currentAndNext(rows, at('10:00')).next.id, 'b');
  assert.equal(Core.currentAndNext(rows, at('10:30')).current, null, 'end is exclusive');
  assert.equal(Core.currentAndNext(rows, at('10:30')).next.id, 'b');
  assert.equal(Core.currentAndNext(rows, at('23:00')).next, null);
});

test('summarize aggregates actual focus time per day', () => {
  const log = [
    { date: '2026-11-15', actualMs: 25 * MIN },
    { date: '2026-11-15', actualMs: 50 * MIN },
    { date: '2026-11-16', actualMs: 90 * MIN },
  ];
  const sum = Core.summarize(log);
  assert.equal(sum.sessions, 3);
  assert.equal(sum.byDate['2026-11-15'], 75 * MIN);
  assert.equal(sum.totalMs, 165 * MIN);
});

test('normalize clamps hostile session payloads', () => {
  const s = Core.normalize({ plannedMin: 99999, accMs: -500, running: 'yes', title: null }, base);
  assert.equal(s.plannedMin, 600);
  assert.equal(s.accMs, 0);
  assert.equal(s.running, true);
  assert.equal(s.title, 'Фокус');
  assert.equal(Core.normalize(null), null);
});