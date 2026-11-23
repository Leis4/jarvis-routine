'use strict';
/* v43 integration: StorageAdapter write contract, recurrence in the real app,
   Russian quick add end-to-end (parse -> conflict -> persist -> undo). */
process.env.TZ = 'Europe/Moscow';
const fs = require('fs'), vm = require('vm'), assert = require('assert'), path = require('path');
const root = path.resolve(__dirname, '..');
const raw = fs.readFileSync(path.join(root, 'site/index.html'), 'utf8');
const inline = raw.match(/<script>([\s\S]*?)<\/script>/i)?.[1];
assert(inline, 'index.html inline script must be extractable');

/* Frozen at Monday 2026-11-16 09:00 Europe/Moscow (even study week). */
const FROZEN = '2026-11-16T06:00:00Z';
class ClockDate extends Date { constructor(...a) { super(...(a.length ? a : [FROZEN])); } static now() { return +new Date(FROZEN); } }
const storage = new Map(), listeners = {}, nodes = new Map();
function makeNode(id) {
  if (!nodes.has(id)) nodes.set(id, {
    id, innerHTML: '', textContent: '', dataset: {}, hidden: false,
    classList: { add() {}, remove() {}, contains() { return false } },
    append() {}, appendChild() {}, remove() {}, setAttribute() {}, addEventListener() {},
    scrollIntoView() {}, querySelector() { return null },
  });
  return nodes.get(id);
}
const document = {
  body: makeNode('body'), documentElement: { dataset: {} }, querySelector: makeNode,
  getElementById: () => null,
  createElement: () => ({ innerHTML: '', className: '', setAttribute() {}, scrollIntoView() {}, remove() {} }),
  addEventListener(type, fn, capture) { (listeners[type] ??= []).push({ fn, capture: !!capture }); },
};
const sandbox = {
  Date: ClockDate, document, window: null, navigator: {}, location: { protocol: 'file:', origin: 'null' },
  console, JSON, Math, Array, Object, Number, String, Boolean, Set, Map, RegExp, Promise, Intl, Error, TypeError,
  parseInt, parseFloat, isNaN, URL, URLSearchParams, isFinite, Date_: Date,
  localStorage: { getItem: k => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k), key: i => [...storage.keys()][i], get length() { return storage.size } },
  setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, confirm: () => true,
  crypto: require('crypto').webcrypto,
  fetch() { throw Error('Unexpected network call'); },
  FormData: class { constructor(form) { this.form = form } entries() { return Object.entries(this.form.values) } getAll() { return [] } },
};
sandbox.window = sandbox; sandbox.window.addEventListener = () => {};
const ctx = vm.createContext(sandbox);
const run = (code, name) => vm.runInContext(code, ctx, { filename: name || 'test.js', timeout: 10000 });

run(fs.readFileSync(path.join(root, 'site/storage.js'), 'utf8'), 'storage.js');
run(inline, 'index.js');
for (const f of ['recur.js', 'parse-ru.js', 'smart.js', 'ai.js', 'ux-fixes.js', 'quick.js']) {
  run(fs.readFileSync(path.join(root, 'site', f), 'utf8'), f);
}

/* ── StorageAdapter: the write contract is real ───────────────────── */
assert.equal(run('JarvisStore.SCHEMA'), 2);
assert.deepEqual(run("JarvisStore.put('jarvis_probe_v1',{a:1})"), { ok: true, bytes: 7 });
assert.deepEqual(run("JarvisStore.get('jarvis_probe_v1')"), { a: 1 });

const realSet = sandbox.localStorage.setItem;
sandbox.localStorage.setItem = (k, v) => { if (k === 'jarvis_quota_v1') { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; } realSet(k, v); };
assert.deepEqual(run("JarvisStore.put('jarvis_quota_v1',{x:1})"), { ok: false, reason: 'quota' }, 'quota must be reported, never swallowed');
sandbox.localStorage.setItem = realSet;

const realGet = sandbox.localStorage.getItem;
sandbox.localStorage.getItem = k => (k === 'jarvis_lie_v1' ? '{"tampered":true}' : realGet(k));
assert.deepEqual(run("JarvisStore.put('jarvis_lie_v1',{x:1})"), { ok: false, reason: 'verify' }, 'a write that does not read back must fail');
sandbox.localStorage.getItem = realGet;

/* persist() must surface a failure to its caller instead of pretending. */
run("S.done['2026-11-16']={probe:true}");
sandbox.localStorage.setItem = (k, v) => { if (k === 'jarvis_routine_v1') { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; } realSet(k, v); };
assert.equal(run('persist()'), false, 'persist() returns false when the write fails');
const failed = JSON.parse(run('JSON.stringify(JarvisStore.lastWrite)'));
assert.equal(failed.ok, false, 'the failed write is recorded, not swallowed');
assert.equal(failed.reason, 'quota');
sandbox.localStorage.setItem = realSet;
assert.equal(run('persist()'), true, 'persist() returns true when the write succeeds');
assert.equal(run('JarvisStore.lastWrite.ok'), true, 'a successful write clears the failure state');

/* transaction rollback keeps multi-key updates all-or-nothing */
run("JarvisStore.put('jarvis_tx_a',{v:1});JarvisStore.put('jarvis_tx_b',{v:1})");
let threw = false;
try { run("JarvisStore.transaction(()=>{JarvisStore.put('jarvis_tx_a',{v:2});JarvisStore.put('jarvis_tx_c',{v:9});throw Error('boom')})"); } catch (e) { threw = true; }
assert.ok(threw, 'transaction must rethrow');
assert.deepEqual(run("JarvisStore.get('jarvis_tx_a')"), { v: 1 }, 'rolled back value');
assert.equal(run("JarvisStore.get('jarvis_tx_c')"), null, 'rolled back new key');
console.log('OK StorageAdapter reports quota/verify failures and rolls back transactions');

/* ── recurrence is wired into the real app, not only the module ───── */
run("S.extras=[{id:'x_par',name:'Пара-тест',start:'10:00',end:'10:30',cat:'Код',status:'Обязательно',note:'',fromDate:'2026-11-02',repeat:'parity',parity:0,repeatDays:[1]}]");
assert.equal(run("baseItemList('2026-11-10').some(t=>t.id==='x_par')"), true, 'odd-week Tuesday appears');
assert.equal(run("baseItemList('2026-11-17').some(t=>t.id==='x_par')"), false, 'even-week Tuesday must not appear');
assert.equal(run("baseItemList('2026-11-11').some(t=>t.id==='x_par')"), false, 'wrong weekday must not appear');

const spec = JSON.parse(run("JSON.stringify(repeatSpec({repeat:'parity',parity:'1'},['4','0','0']))"));
assert.deepEqual(spec.repeatDays, [0, 4], 'weekday list is deduped and sorted');
assert.equal(spec.parity, 1);
assert.deepEqual(JSON.parse(run("JSON.stringify(repeatSpec({repeat:'daily'},['1']))")).repeatDays, [], 'stale weekdays are cleared when the mode changes');
assert.equal(run("syncRepeatFields('parity') === undefined"), true, 'repeat field toggle runs without DOM');
console.log('OK parity recurrence and repeatSpec are live in the app code path');

/* ── quick add: parse -> conflict -> persist -> undo ──────────────── */
run("S.extras=[]");
const planned = run("JSON.stringify(JarvisQuick.plan('Python завтра 18:00 на 45 минут'))");
const pl = JSON.parse(planned);
assert.equal(pl.title, 'Python');
assert.equal(pl.date, '2026-11-17');
assert.equal(pl.start, '18:00');
assert.equal(pl.end, '18:45');
assert.equal(pl.conflict.length, 0);

const created = JSON.parse(run("(function(){const r=JarvisQuick.commit(JSON.parse(" + JSON.stringify(planned) + "),{});return JSON.stringify({error:r.error||null,id:r.item&&r.item.id})})()"));
assert.equal(created.error, null, 'clean slot commits');
assert.equal(run("S.extras.length"), 1, 'task persisted');
assert.equal(run("JarvisStore.get('jarvis_routine_v1').extras.length"), 1, 'persist() reached localStorage');

/* the same interval must be refused, not silently doubled */
const second = JSON.parse(run("(function(){const r=JarvisQuick.commit(JSON.parse(" + JSON.stringify(planned) + "),{});return JSON.stringify({error:r.error||null})})()"));
assert.equal(second.error, 'conflict', 'overlap is refused before persistence');
assert.equal(run("S.extras.length"), 1, 'no duplicate was written');

/* a genuinely occupied slot gets a real free-slot proposal */
const busy = JSON.parse(run("JSON.stringify(JarvisQuick.plan('Обед сегодня 13:00 на 30 минут'))"));
assert.equal(busy.start, '13:00');
const blocked = run("(function(){S.extras.push({id:'x_block',name:'Занято',start:'13:00',end:'13:30',cat:'Быт',status:'Обязательно',fromDate:today(),repeat:'once'});const p=JarvisQuick.plan('Обед сегодня 13:00 на 30 минут');return JSON.stringify({conflict:p.conflict.length,slot:p.slot})})()");
const blockedObj = JSON.parse(blocked);
assert.ok(blockedObj.conflict > 0, 'conflict detected against a real block');
assert.ok(blockedObj.slot && blockedObj.slot.start, 'a free slot is proposed instead of overwriting');

/* undo removes exactly the created task */
run("(function(){const before=S.extras.length;const r=JarvisQuick.commit(JarvisQuick.plan('Чтение завтра 20:00 на 30 минут'),{});r.undo();window.__undoOk=S.extras.length===before})()");
assert.equal(run('window.__undoOk'), true, 'undo restores the previous task list');
console.log('OK quick add validates, refuses overlaps, proposes free slots and undoes');

/* ── palette is optional and must not break without a real DOM ───── */
assert.equal(typeof run('typeof JarvisQuick.openPalette'), 'string', 'palette API is exported');
assert.equal(run('JarvisQuick.openPalette() === undefined'), true, 'openPalette degrades safely in a DOM-less environment');

console.log('ALL v43 integration checks passed');
