'use strict';
/* Flexible schedule policy — Undo correctness regression (pure module, no DOM).
   Reproduces and locks the fix for: Undo bound to the wrong day.

   Defect (before fix): applyPreview() stored the reversible snapshot under the
   day of the operated task (pv.s). A "missed" preview can target YESTERDAY
   (missedList lists s and s-1), so the snapshot landed under yesterday's key
   while the panel/handler looked it up under the CURRENT UI day. Result:
   no Undo button and no restore for yesterday's operation. A second apply on
   the same day also overwrote the previous snapshot.

   Fix: Undo is an operation-scoped stack, independent of the UI day. */

const assert = require('assert');
const path = require('path');

const FLEX = path.join(__dirname, '..', 'site', 'flex.js');
const loadFlex = () => { delete require.cache[require.resolve(FLEX)]; return require(FLEX); };

const TODAY = '2026-11-16';
const YESTERDAY = '2026-11-15';
const FUTURE = '2026-11-17';

function resetGlobals() {
  global.S = { done: {}, dayAdjust: {}, extras: [], flex: null };
  global.ui = { date: TODAY };
  global.__items = {};
  global.done = (d, id) => !!global.S.done[`${d}::${id}`];
  global.isRequired = t => t && t.status === 'Обязательно';
  global.timeGroup = t => (t && t.group) || '';
  global.indexDay = () => 0;
  global.clock = hm => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm == null ? '' : hm)); return m ? (+m[1]) * 60 + (+m[2]) : NaN; };
  global.niceTime = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  global.minutesHM = global.clock;
  global.persist = () => true;
  global.render = () => {};
  global.itemList = day => (global.__items[day] || []).map(t => ({ ...t }));
  global.jarvisTaskConflict = null;
}
const setItems = map => { global.__items = map; };
const flexOn = st => { st.mode = 'on'; return st; };
const omit = (day, id) => global.S.dayAdjust[day] && global.S.dayAdjust[day][id] && global.S.dayAdjust[day][id].omit === true;
const undoOffered = day => /data-flex="undo"/.test(FLEX_API()._panelHTML(day));
let API;
const FLEX_API = () => API;

/* ── day fixtures: flexible tasks on today, yesterday and a free future day ── */
function seedDays() {
  setItems({
    [TODAY]: [
      { id: 't1', name: 'Код', cat: 'Код', status: 'Гибко', start: '10:00', end: '11:00', group: 'ДЕНЬ' },
      { id: 't2', name: 'Чтение', cat: 'Код', status: 'Гибко', start: '12:00', end: '13:00', group: 'ДЕНЬ' },
    ],
    [YESTERDAY]: [
      { id: 'y1', name: 'Английский', cat: 'Код', status: 'Гибко', start: '10:00', end: '11:00', group: 'ДЕНЬ' },
    ],
    [FUTURE]: [],
  });
}

/* ── 1. REPRO: operation for YESTERDAY while the UI shows TODAY ── */
resetGlobals();
API = loadFlex();
seedDays();
flexOn(API.state());
API.state().preview = API.previewMissed('y1', 'skip', YESTERDAY);
assert.equal(API.applyPreview().ok, true, 'apply must succeed');
assert.ok(omit(YESTERDAY, 'y1'), 'operation applied to yesterday');

assert.ok(undoOffered(TODAY),
  'REPRO FAIL: Undo must be offered for the applied operation even though the UI day is today');
assert.equal(API.undo(TODAY), true,
  'REPRO FAIL: Undo must restore the last operation regardless of the current UI day');
assert.ok(!omit(YESTERDAY, 'y1'), 'yesterday adjustment is gone after undo');
console.log('OK undo targets the operated day (yesterday) while the UI shows today');

/* ── 2. Two sequential applies on the same day: undo unwinds them in order ── */
resetGlobals();
API = loadFlex();
seedDays();
flexOn(API.state());
API.state().preview = API.previewMissed('t1', 'skip', TODAY);
assert.equal(API.applyPreview().ok, true);
API.state().preview = API.previewMissed('t2', 'shorten', TODAY);
assert.equal(API.applyPreview().ok, true);
assert.ok(omit(TODAY, 't1') && omit(TODAY, 't2'), 'both operations applied');

assert.equal(API.undo(TODAY), true, 'first undo unwinds the most recent apply');
assert.ok(omit(TODAY, 't1'), 'the earlier operation must survive the first undo');
assert.ok(!omit(TODAY, 't2'), 'only the latest operation is unwound');

assert.equal(API.undo(TODAY), true, 'second undo unwinds the earlier apply');
assert.ok(!omit(TODAY, 't1') && !omit(TODAY, 't2'), 'both operations unwound, nothing left');

assert.equal(API.undo(TODAY), false, 'repeated undo past the stack is a clean no-op');
console.log('OK two sequential applies unwind in order; repeated undo is safe');

/* ── 3. Cross-day carry-over is reversible and never duplicated ── */
resetGlobals();
API = loadFlex();
seedDays();
flexOn(API.state());
global.jarvisTaskConflict = { freeSlot: (d, id, a, b) => ({ start: a, end: b }) };
API.state().preview = API.previewMissed('y1', 'reschedule', YESTERDAY);
assert.equal(API.applyPreview().ok, true);
const carried = global.S.extras.filter(x => x.carryOf === 'y1');
assert.equal(carried.length, 1, 'one carry-over extra created');
assert.ok(API.carryoverTargets(YESTERDAY, 3).includes(carried[0].fromDate), 'carry-over lands within the policy window');

/* repeating the same carry-over primitive must stay idempotent */
const t = { id: 'y1', name: 'Английский', cat: 'Код', start: '10:00', end: '11:00' };
API.placeCarryover(t, TODAY, API.policy());
API.placeCarryover(t, TODAY, API.policy());
assert.equal(global.S.extras.filter(x => x.carryOf === 'y1').length, 1, 'no duplicate carry-over');

assert.equal(API.undo(TODAY), true, 'undo reverses the carry-over');
assert.equal(global.S.extras.filter(x => x.carryOf === 'y1').length, 0, 'carry-over extra removed on undo');
console.log('OK cross-day carry-over is reversible and deduplicated');

/* ── 4. Undo survives a reload (state persisted in S) ── */
resetGlobals();
API = loadFlex();
seedDays();
flexOn(API.state());
API.state().preview = API.previewMissed('y1', 'skip', YESTERDAY);
assert.equal(API.applyPreview().ok, true);
const reloaded = loadFlex();               /* fresh module instance = reload */
assert.equal(reloaded.undo(TODAY), true, 'undo must survive a reload');
assert.ok(!omit(YESTERDAY, 'y1'), 'reloaded undo restored the pre-operation state');
console.log('OK undo survives a reload');

/* ── 5. Undo never loses completion marks ── */
resetGlobals();
API = loadFlex();
seedDays();
flexOn(API.state());
global.S.done[`${TODAY}::t1`] = true;
API.state().preview = API.previewMissed('t2', 'skip', TODAY);
assert.equal(API.applyPreview().ok, true);
assert.equal(API.undo(TODAY), true);
assert.equal(global.S.done[`${TODAY}::t1`], true, 'completion marks are preserved across undo');
console.log('OK completion marks survive apply+undo');

/* ── 6. Energy mode is part of the reversible operation ── */
resetGlobals();
API = loadFlex();
seedDays();
flexOn(API.state());
API.state().preview = API.previewEnergy(1, TODAY);
assert.equal(API.applyPreview().ok, true);
assert.equal(API.state().energy, 'low', 'energy mode applied');
assert.equal(API.undo(TODAY), true);
assert.notEqual(API.state().energy, 'low', 'energy mode restored on undo');
console.log('OK energy mode is restored on undo');

console.log('ALL flex-undo checks passed');
