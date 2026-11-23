'use strict';
/* P0-B: cloud restore must not silently drop newer local data.
   Pure model (window.JarvisCloudRestore in site/ai.js), loaded in a VM with no
   network. Locks buildCloudRestore(): defaults are always present, cloud values
   win where the cloud provides them, and any newer local-only key (goals,
   customHabits, flex, dayAdjust, events, focus*, shampooDays, reminders,
   pending, planUndo) is reported as "missing" so the caller can warn the user. */

process.env.TZ = 'Europe/Moscow';
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const root = require('path').resolve(__dirname, '..');
const original = fs.readFileSync(root + '/site/index.html', 'utf8');
const script = original.match(/<script>([\s\S]*?)<\/script>/i)?.[1];
assert(script, 'inline script missing');

class ClockDate extends Date { constructor(...a) { super(...(a.length ? a : ['2026-11-16T15:05:00Z'])); } static now() { return +new Date('2026-11-16T15:05:00Z'); } }
const db = new Map();
const elements = new Map();
function elem(id) { if (!elements.has(id)) elements.set(id, { id, innerHTML: '', textContent: '', scrollTop: 0, scrollHeight: 500, classList: { add() {}, remove() {}, contains() { return false; } }, append() {}, remove() {}, setAttribute() {}, addEventListener() {}, querySelector() { return null; } }); return elements.get(id); }
const listeners = {};
const document = { querySelector: s => elem(s), addEventListener(t, fn) { (listeners[t] ??= []).push(fn); }, createElement: () => elem(Math.random().toString()), body: elem('body') };
const sandbox = { Date: ClockDate, document, window: null, navigator: {}, location: { protocol: 'file:', origin: 'null' }, console, JSON, Math, Array, Object, Number, String, Boolean, Set, Map, RegExp, Promise, Intl, Error, TypeError, parseInt, parseFloat, isNaN, crypto: require('crypto').webcrypto, AbortController, localStorage: { getItem: k => db.get(k) ?? null, setItem: (k, v) => db.set(k, String(v)), removeItem: k => db.delete(k) }, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, confirm: () => true, fetch() { throw Error('network forbidden'); }, URL, URLSearchParams };
sandbox.window = sandbox; sandbox.window.addEventListener = () => {};
const ctx = vm.createContext(sandbox);
const run = (src, name) => vm.runInContext(src, ctx, { filename: name || 'test', timeout: 15000 });

run(script, 'index_inline.js');
run(fs.readFileSync(root + '/site/smart.js', 'utf8'), 'smart.js');
run(fs.readFileSync(root + '/site/ai.js', 'utf8'), 'ai.js');

assert.equal(run("typeof window.JarvisCloudRestore?.buildCloudRestore"), 'function', 'buildCloudRestore must be exposed');

const build = (local, cloud) => JSON.parse(run(`JSON.stringify(window.JarvisCloudRestore.buildCloudRestore(${JSON.stringify(local)},${JSON.stringify(cloud)}))`));

/* ── 1. An older cloud copy that omits newer feature keys ── */
const local = {
  done: { '2026-11-16::t1': true }, habits: { '2026-11-16::hairwash': true }, extras: [{ id: 'x_local' }],
  goals: { '2026-11-16': [{ id: 'g1', text: 'Код' }] }, customHabits: [{ id: 'h1', name: 'Полить цветы' }],
  flex: { mode: 'on', policy: { exam: { date: '2026-11-24' } } }, events: [{ id: 'e1', type: 'complete' }],
  dayAdjust: { '2026-11-16': { t1: { omit: true } } }, focusSessions: [{ id: 'f1' }], reminders: { enabled: true },
};
const cloud = { done: { '2026-11-15::z': true }, habits: {}, extras: [] };
const r1 = build(local, cloud);
for (const k of ['goals', 'customHabits', 'flex', 'events', 'dayAdjust', 'focusSessions', 'reminders']) {
  assert.ok(r1.missing.includes(k), `newer local key not protected: ${k}`);
}
assert.deepEqual(r1.candidate.done, { '2026-11-15::z': true }, 'cloud-provided values win');
for (const k of ['habits', 'overrides', 'extras', 'logs', 'anchor', 'shave', 'wakeTimes']) {
  assert.ok(k in r1.candidate, `default key missing from candidate: ${k}`);
}
assert.equal(r1.candidate.anchor, null, 'anchor default is null');
console.log('OK older cloud copy: newer local keys reported, defaults filled, cloud wins where present');

/* ── 2. A fully compatible snapshot: nothing to warn about ── */
const full = { done: {}, habits: {}, extras: [], goals: { '2026-11-16': [{ id: 'g1' }] }, customHabits: [{ id: 'h1' }], flex: { mode: 'on' }, events: [], dayAdjust: {}, focusSessions: [], reminders: {} };
const r2 = build(full, full);
assert.deepEqual(r2.missing, [], 'a complete snapshot flags nothing');
console.log('OK compatible snapshot: no local-only keys reported');

/* ── 3. Empty local data never raises a false alarm ── */
const r3 = build({ done: {}, habits: {}, extras: [], goals: {}, customHabits: [], flex: {} }, { done: {}, habits: {}, extras: [] });
assert.deepEqual(r3.missing, [], 'empty local containers are not "newer data"');
console.log('OK empty local containers produce no false positives');

/* ── 4. A malformed cloud payload is normalised, never crashes ── */
const r4 = build({ done: {}, goals: { d: [{ id: 'g' }] } }, null);
assert.ok(r4.candidate.done && r4.candidate.logs, 'defaults applied for a null cloud state');
assert.ok(r4.missing.includes('goals'), 'local goals still protected against a null cloud state');
console.log('OK null/malformed cloud state is normalised, local data still protected');

/* ── 5. Same top-level key, DIFFERENT nested data is a conflict, not silence ── */
const localH = { done: { '2026-11-16::t1': true }, habits: { '2026-11-16::hw': true }, extras: [], goals: { '2026-11-16': [{ id: 'g1' }] }, customHabits: [{ id: 'h1' }], flex: { mode: 'on' } };
const cloudH = { done: { '2026-11-15::old': true }, habits: {}, extras: [] };
const r5 = build(localH, cloudH);
assert.ok(r5.conflicts.includes('habits'), 'stale nested habits are flagged as a conflict');
assert.ok(r5.conflicts.includes('done'), 'stale nested done is flagged as a conflict');
assert.equal(r5.missing.includes('habits'), false, 'a key present in the cloud is a conflict, not "missing"');
assert.ok(r5.missing.includes('goals'), 'an absent key is still reported as missing');
assert.deepEqual(r5.conflicts.includes('flex'), false, 'a key absent from the cloud is not double-counted as a conflict');
console.log('OK same-key nested conflict: stale cloud nested data is flagged, never silently applied');

/* ── 5. Integration: the real async restoreCloud() against a mocked /api/snapshot ── */
(async () => {
  assert.equal(run('typeof window.restoreCloud'), 'function', 'restoreCloud must be exposed for tests');

  const getS = () => JSON.parse(run('JSON.stringify(S)'));
  const setS = v => run('S = ' + JSON.stringify(v));
  const cfg = k => run('window.aiState.' + k);

  run("window.aiState.url='https://example.test';window.aiState.token='x'.repeat(30)");
  run('globalThis.__realPersist = persist');   /* keep the real writer to restore later */
  run('globalThis.__realRender = render; render = function(){};');   /* no schedule data in this harness */

  let cloudPayload = null;
  const confirmQueue = [];
  sandbox.confirm = () => (confirmQueue.length ? confirmQueue.shift() : false);
  sandbox.fetch = async () => ({ ok: true, status: 200, json: async () => cloudPayload });

  const localState = {
    done: { '2026-11-16::t1': true }, habits: { '2026-11-16::hairwash': true }, extras: [], logs: {}, anchor: null, shave: null, wakeTimes: {},
    goals: { '2026-11-16': [{ id: 'g1', text: 'Код' }] }, customHabits: [{ id: 'h1', name: 'Полить цветы' }], flex: { mode: 'on' },
  };

  /* 5a. Older cloud copy that omits newer keys: cloud wins, local extras survive, backup written */
  db.clear(); setS(localState);
  cloudPayload = { state: { done: { '2026-11-15::z': true }, habits: {}, extras: [], logs: {}, anchor: null, shave: null, wakeTimes: {} }, version: 7 };
  confirmQueue.length = 0; confirmQueue.push(true, true, true);   /* proceed, keep local-only keys, accept conflicts */
  await run('window.restoreCloud()');
  const s1 = getS();
  assert.deepEqual(s1.done, { '2026-11-15::z': true }, 'cloud-provided values win');
  assert.deepEqual(s1.goals, localState.goals, 'newer local goals preserved');
  assert.deepEqual(s1.customHabits, localState.customHabits, 'custom habits preserved');
  assert.deepEqual(s1.flex, localState.flex, 'flex policy preserved');
  assert.equal(cfg('cloudVersion'), 7, 'cloud version recorded');
  const backup = JSON.parse(db.get('jarvis_routine_before_restore_v1'));
  assert.deepEqual(backup.goals, localState.goals, 'pre-restore backup holds the local state');
  const stored = JSON.parse(db.get('jarvis_routine_v1'));
  assert.deepEqual(stored.done, { '2026-11-15::z': true }, 'the restored state is durably stored (survives reload)');
  assert.deepEqual(stored.goals, localState.goals, 'preserved local keys are durably stored too');
  console.log('OK integration: cloud wins, local goals/customHabits/flex preserved, backup + durable write');

  /* 5b. A failed write rolls back and reports honestly */
  db.clear(); setS(localState);
  run('persist = function(){ return false; }');
  cloudPayload = { state: { done: { '2026-11-15::z': true }, habits: {}, extras: [] }, version: 8 };
  confirmQueue.length = 0; confirmQueue.push(true, true, true);
  await run('window.restoreCloud()');
  const s2 = getS();
  assert.deepEqual(s2.done, localState.done, 'a failed write keeps the local marks');
  assert.deepEqual(s2.goals, localState.goals, 'a failed write keeps local goals');
  assert.ok(/отмен/i.test(String(cfg('status'))), 'the failure is reported honestly');
  assert.ok(db.has('jarvis_routine_before_restore_v1'), 'the backup exists even when the write fails');
  run('persist = globalThis.__realPersist');
  console.log('OK integration: a failed write rolls back and reports honestly');

  /* 5c. A malformed cloud snapshot is rejected before touching anything */
  db.clear(); setS(localState);
  cloudPayload = { state: { habits: {} }, version: 9 };         /* no done object -> invalid */
  confirmQueue.length = 0; confirmQueue.push(true);
  await run('window.restoreCloud()');
  assert.deepEqual(getS().done, localState.done, 'an invalid snapshot leaves local state untouched');
  assert.ok(!db.has('jarvis_routine_before_restore_v1'), 'no backup is written for a rejected snapshot');
  console.log('OK integration: a malformed cloud snapshot is rejected without touching local data');

  /* 5d. User declines the overwrite warning: nothing changes, no backup is left behind */
  db.clear(); setS(localState);
  cloudPayload = { state: { done: { '2026-11-15::z': true }, habits: {}, extras: [] }, version: 10 };
  confirmQueue.length = 0; confirmQueue.push(true, true, false);   /* proceed, keep missing keys, DECLINE the overwrite */
  await run('window.restoreCloud()');
  assert.deepEqual(getS().done, localState.done, 'declining the overwrite warning leaves local marks intact');
  assert.ok(!db.has('jarvis_routine_before_restore_v1'), 'nothing was overwritten, so nothing needs recovery');
  console.log('OK integration: declining the overwrite warning changes nothing');

  console.log('ALL cloud restore-safety checks passed');
})().catch(e => { console.error('FAIL', (e && e.stack) || e); process.exit(1); });
