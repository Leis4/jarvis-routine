'use strict';
/* P0-A: a failed persist() must never look like success and must not lose state.
   Pure module (site/flex.js), no DOM. Locks:
     - applyPreview() reports ok:false when the write fails;
     - the in-memory change is rolled back to the pre-apply snapshot;
     - the failed attempt does not pollute the Undo stack;
     - earlier successful operations survive a later failed one;
     - a reload after a failed write shows the pre-apply state. */

const assert = require('assert');
const path = require('path');

const FLEX = path.join(__dirname, '..', 'site', 'flex.js');
const loadFlex = () => { delete require.cache[require.resolve(FLEX)]; return require(FLEX); };

const TODAY = '2026-11-16';
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
const omit = (day, id) => !!(global.S.dayAdjust[day] && global.S.dayAdjust[day][id] && global.S.dayAdjust[day][id].omit === true);
let API;
const FLEX_API = () => API;

function seedDays() {
  setItems({
    [TODAY]: [
      { id: 't1', name: 'Код', cat: 'Код', status: 'Гибко', start: '10:00', end: '11:00', group: 'ДЕНЬ' },
      { id: 't2', name: 'Чтение', cat: 'Код', status: 'Гибко', start: '12:00', end: '13:00', group: 'ДЕНЬ' },
    ],
    [FUTURE]: [],
  });
}

/* ── 1. persist() failure: no false success, full rollback, clean Undo ── */
resetGlobals();
global.persist = () => false;            /* the device refuses to write */
API = loadFlex();
seedDays();
flexOn(API.state());
const preDay = JSON.stringify(global.S.dayAdjust[TODAY] || {});
API.state().preview = API.previewMissed('t1', 'skip', TODAY);
const r = API.applyPreview();
assert.equal(r.ok, false, 'applyPreview must report failure when persist fails');
assert.ok(/сохран/i.test(r.reason || ''), 'failure carries a human reason');
assert.equal(omit(TODAY, 't1'), false, 'no adjustment survives a failed write');
assert.equal(JSON.stringify(global.S.dayAdjust[TODAY] || {}), preDay, 'dayAdjust is byte-identical to the pre-apply state');
assert.equal(API.state().preview, undefined, 'the stale preview is dropped after a failed apply');
assert.equal(API.undo(TODAY), false, 'a failed apply must not leave an Undo entry behind');
console.log('OK persist failure: ok:false, full rollback, Undo stack clean');

/* ── 2. success path is unchanged ── */
resetGlobals();
API = loadFlex();
seedDays();
flexOn(API.state());
API.state().preview = API.previewMissed('t1', 'skip', TODAY);
assert.equal(API.applyPreview().ok, true, 'a working write still applies');
assert.ok(omit(TODAY, 't1'), 'a working write still mutates state');
console.log('OK successful write still applies and persists');

/* ── 3. a later failure does not lose an earlier successful operation ── */
resetGlobals();
API = loadFlex();
seedDays();
flexOn(API.state());
API.state().preview = API.previewMissed('t1', 'skip', TODAY);
assert.equal(API.applyPreview().ok, true, 'first operation applied');
global.persist = () => false;            /* the second write fails */
API.state().preview = API.previewMissed('t2', 'skip', TODAY);
assert.equal(API.applyPreview().ok, false, 'second operation refused');
assert.ok(omit(TODAY, 't1'), 'the earlier valid operation survives the failed one');
assert.equal(omit(TODAY, 't2'), false, 'the failed operation left nothing behind');
assert.equal(API.undo(TODAY), true, 'Undo unwinds the earlier operation');
assert.equal(omit(TODAY, 't1'), false, 'undo restored the pre-first-operation state');
console.log('OK a failed write never rolls back an earlier valid operation');

/* ── 4. reload after a failed write shows the pre-apply state ── */
resetGlobals();
global.persist = () => false;
API = loadFlex();
seedDays();
flexOn(API.state());
API.state().preview = API.previewMissed('t1', 'skip', TODAY);
assert.equal(API.applyPreview().ok, false, 'apply refused while storage is broken');
global.persist = () => true;              /* storage recovers */
const reloaded = loadFlex();              /* fresh module instance = reload */
assert.equal(omit(TODAY, 't1'), false, 'the refused change is absent after reload');
assert.equal(reloaded.undo(TODAY), false, 'nothing to undo after a refused change');
console.log('OK reload after a failed write shows the pre-apply state');

console.log('ALL flex persist-safety checks passed');
