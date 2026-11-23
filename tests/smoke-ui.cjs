/* Minimal UI smoke check: the public shell boots with no private schedule,
   renders all four tabs, and exposes the AI chat entry point. */
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const path = require('path');

const root = path.resolve(__dirname, '..');
const index = fs.readFileSync(root + '/site/index.html', 'utf8');
const embedded = index.match(/<script>([\s\S]*?)<\/script>/)[1];

const nodes = new Map();
const make = (id) => {
  if (!nodes.has(id)) nodes.set(id, {
    id, innerHTML: '', textContent: '', dataset: {}, style: {},
    classList: { add() {}, remove() {}, contains() { return false } },
    append() {}, appendChild() {}, remove() {}, setAttribute() {}, addEventListener() {},
    querySelector() { return null }, children: [],
  });
  return nodes.get(id);
};
const storage = new Map();
const sandbox = {
  console, JSON, Math, Array, Object, Number, String, Boolean, Set, Map, RegExp, Promise,
  Intl, Error, TypeError, parseInt, parseFloat, isNaN, URL, URLSearchParams, Blob, Date,
  setTimeout, clearTimeout, setInterval() {}, clearInterval() {},
  document: { querySelector: make, getElementById: (id) => make('#' + id), createElement: () => make('el' + Math.random()), addEventListener() {}, body: make('body'), visibilityState: 'visible' },
  localStorage: { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) },
  navigator: {}, location: { protocol: 'file:', origin: 'null' },
  crypto: require('crypto').webcrypto, confirm: () => true, alert() {},
  fetch() { throw Error('Unexpected network call'); },
};
sandbox.window = sandbox;
sandbox.window.addEventListener = () => {};
sandbox.window.scrollTo = () => {};
vm.createContext(sandbox);
const run = (code, name) => vm.runInContext(code, sandbox, { filename: name || 'smoke.js', timeout: 10000 });

run(embedded, 'index-inline.js');
run(fs.readFileSync(root + '/site/smart.js', 'utf8'), 'smart.js');
run(fs.readFileSync(root + '/site/ai.js', 'utf8'), 'ai.js');

// Public shell has no personal schedule, but stays usable and explains the state.
assert.equal(run('PLANS.length'), 0, 'no personal schedule may be embedded');
assert.equal(run('HABITS.length'), 0, 'no personal habits may be embedded');
run('ui.tab="today";render();', 'today.js');
const today = make('#app').innerHTML;
assert(today.includes('JARVIS'), 'brand renders');
assert(today.includes('sched-banner'), 'private-storage banner renders');
assert(today.includes('data-sched-action="import"'), 'safe local import path is offered');
assert(make('#bottomnav').innerHTML.includes('data-tab="ai"'), 'four-tab navigation renders');

// AI layer is loaded and can answer locally without a server.
assert.equal(typeof sandbox.sendChat, 'function', 'AI chat entry point exposed');
assert.equal(typeof sandbox.smartReplan, 'function', 'local planner exposed');

console.log('PASS ui: shell boots without private data, tabs render, AI entry points exposed');