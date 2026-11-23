/* Privacy migration acceptance tests (no network, no paid calls).
 *
 * Proves the two promises of PRIVACY_MIGRATION_PLAN.md:
 *   1. no personal schedule/habit data is served from public assets any more;
 *   2. an existing installation upgrades without losing user state, keeps working
 *      offline, and an empty/malformed/older template can never overwrite real data.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const siteDir = path.join(root, 'site');
const templatePath = path.join(root, 'private', 'schedule-template.v1.json');

const PERSONAL_MARKERS = ['p0_0_', 'p0_6_', '"id":"p', "id:'p"];

const TEXT_EXT = new Set(['.html', '.js', '.css', '.json', '.webmanifest', '.txt', '.md', '.svg']);

function publicAssets(dir = siteDir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) publicAssets(full, acc);
    else if (TEXT_EXT.has(path.extname(entry.name).toLowerCase())) acc.push(full);
  }
  return acc;
}

/* ── 1. public assets contain no personal schedule ───────────────────────────── */
test('public assets carry no personal schedule or habit content', () => {
  const files = publicAssets();
  assert.ok(files.length > 0);
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const marker of PERSONAL_MARKERS) {
      assert.equal(text.includes(marker), false, `personal marker ${JSON.stringify(marker)} found in ${path.relative(root, file)}`);
    }
  }
});

test('no private schedule block name or habit text leaks into public assets', () => {
  assert.ok(privateTemplate, 'private/schedule-template.v1.json is required — run node tools/privacy/extract-schedule.mjs');
  const texts = publicAssets().map((file) => ({ file, text: fs.readFileSync(file, 'utf8') }));
  const distinctive = [...new Set(privateTemplate.plans.flat(2).map((x) => x.name))].filter((n) => n.length >= 30);
  assert.ok(distinctive.length > 50, 'expected many distinctive block names');
  for (const { file, text } of texts) {
    for (const name of distinctive) {
      assert.equal(text.includes(name), false, `personal block name leaked into ${path.relative(root, file)}`);
    }
    for (const habit of privateTemplate.habitList) {
      // The hair-care day picker is a generic product feature, not schedule data.
      if (habit.id === 'shampoo') continue;
      if (habit.name.length >= 12) assert.equal(text.includes(habit.name), false, `habit name leaked into ${path.relative(root, file)}`);
      assert.equal(text.includes(habit.sub), false, `habit description leaked into ${path.relative(root, file)}`);
    }
  }
});

test('legacy public template dump is gone', () => {
  assert.equal(fs.existsSync(path.join(siteDir, 'plans_const.txt')), false, 'site/plans_const.txt must not be published');
});

test('index.html ships an empty schedule stub and loads the bootstrap', () => {
  const html = fs.readFileSync(path.join(siteDir, 'index.html'), 'utf8');
  assert.equal(/const\s+PLANS\s*=\s*\[\[/.test(html), false, 'inline PLANS literal still present');
  assert.match(html, /let PLANS=\[\]/);
  assert.match(html, /let HABITS=\[\]/);
  assert.match(html, /<script src="schedule-bootstrap\.js\?v=1"><\/script>/);
  assert.match(html, /function planDay\(s\)/);
  const smartIdx = html.search(/smart\.js\?v=\d+/);
  assert.ok(smartIdx > -1 && html.indexOf('schedule-bootstrap.js') < smartIdx, 'bootstrap must load before feature modules');
  assert.ok(html.length < 120000, `index.html unexpectedly large (${html.length} bytes)`);
});

test('service worker serves the bootstrap and drops the old cache', () => {
  const sw = fs.readFileSync(path.join(siteDir, 'service-worker.js'), 'utf8');
  assert.match(sw, /schedule-bootstrap\.js/);
  const cache = sw.match(/const CACHE='([^']+)'/)?.[1] || '';
  assert.ok(cache > 'jarvis-routine-v40', `cache version must be bumped past v40, got ${cache}`);
});

/* ── 2. the private template still holds every original block ────────────────── */
const privateTemplate = fs.existsSync(templatePath)
  ? JSON.parse(fs.readFileSync(templatePath, 'utf8'))
  : null;

test('private template keeps all 392 blocks and 13 habits', () => {
  assert.ok(privateTemplate, 'private/schedule-template.v1.json is required — run node tools/privacy/extract-schedule.mjs');
  const count = privateTemplate.plans.flat(2).length;
  assert.equal(count, 392);
  assert.equal(privateTemplate.plans.length, 2, 'two week parities');
  for (const week of privateTemplate.plans) assert.equal(week.length, 7);
  const ids = new Set(privateTemplate.plans.flat(2).map((x) => x.id));
  assert.equal(ids.size, 392, 'block ids must stay unique');
  assert.equal(privateTemplate.habitList.length, 13);
});

test('a timestamped private backup exists outside the public site', () => {
  const dir = path.join(root, 'backups');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith('schedule-template.v1.') && f.endsWith('.json')) : [];
  assert.ok(files.length > 0, 'no private backup copy found in backups/');
  const digest = crypto.createHash('sha256').update(fs.readFileSync(templatePath, 'utf8')).digest('hex');
  const matching = files.some((f) => {
    const shaFile = path.join(dir, f + '.sha256');
    if (fs.existsSync(shaFile)) return fs.readFileSync(shaFile, 'utf8').startsWith(digest);
    return crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f), 'utf8')).digest('hex') === digest;
  });
  assert.ok(matching, 'private backup does not match the current template');
});

/* ── shared VM harness ──────────────────────────────────────────────────────── */
const INLINE = fs.readFileSync(path.join(siteDir, 'index.html'), 'utf8').match(/<script>([\s\S]*?)<\/script>/i)[1];
const BOOTSTRAP = fs.readFileSync(path.join(siteDir, 'schedule-bootstrap.js'), 'utf8');

class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : ['2026-11-15T15:05:00Z'])); }
  static now() { return +new Date('2026-11-15T15:05:00Z'); }
}

function makeHarness({ storage = new Map(), fetchImpl } = {}) {
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, {
      id, innerHTML: '', textContent: '', dataset: {},
      classList: { add() {}, remove() {}, contains() { return false; } },
      style: {}, append() {}, appendChild() {}, remove() {}, setAttribute() {},
      addEventListener() {}, click() {}, scrollIntoView() {}, querySelector() { return null; }, children: [], files: null,
    });
    return nodes.get(id);
  };
  const listeners = { click: [], submit: [], change: [], input: [] };
  const document = {
    body: node('body'),
    visibilityState: 'visible',
    documentElement: { dataset: {} },
    querySelector: node,
    getElementById: (id) => node('#' + id),
    createElement: () => node('input-' + Math.random()),
    addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
  };
  const localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  };
  const sandbox = {
    Date: FixedDate, document, localStorage, console,
    navigator: {}, location: { protocol: 'http:', origin: 'https://jarvis-routine.demo.workers.dev' },
    JSON, Math, Array, Object, Number, String, Boolean, Set, Map, RegExp, Promise, Intl, Error, TypeError,
    parseInt, parseFloat, isNaN, URL, URLSearchParams, Blob, AbortController, crypto: crypto.webcrypto,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
    confirm: () => true, alert() {}, fetch: fetchImpl || (() => { throw Error('network unavailable'); }),
  };
  sandbox.window = sandbox;
  sandbox.window.addEventListener = () => {};
  sandbox.window.scrollTo = () => {};
  const context = vm.createContext(sandbox);
  const run = (code, name = 'harness.js') => vm.runInContext(code, context, { filename: name, timeout: 15000 });
  run(INLINE, 'index-inline.js');
  run(BOOTSTRAP, 'schedule-bootstrap.js');
  return { run, storage, sandbox, node, listeners, context };
}

const flush = async (times = 6) => { for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r)); };

function seedTemplate(storage, version = 1) {
  storage.set('jarvis_schedule_template_v1', JSON.stringify({
    version, savedAt: '2026-11-14T10:00:00.000Z',
    payload: { plans: privateTemplate.plans, habits: privateTemplate.habitList },
  }));
}

function seedUserState(storage) {
  const state = {
    done: { '2026-11-09': { p0_0_0: true, p0_0_1: true } },
    habits: { '2026-11-09': { wake: true } },
    overrides: { p0_0_2: { name: 'Личная правка пользователя' } },
    extras: [{ id: 'x_user1', name: 'Моё личное дело', start: '19:00', end: '19:30', cat: 'Личное', status: 'Обязательно', note: '', fromDate: '2026-11-09', repeat: 'daily' }],
    logs: {}, anchor: { monday: '2026-11-09', parity: 0 }, shave: null, wakeTimes: {},
  };
  storage.set('jarvis_routine_v1', JSON.stringify(state));
  return state;
}

function serverTemplate(version) {
  return { version, payload: { plans: privateTemplate.plans, habits: privateTemplate.habitList }, updatedAt: '2026-11-15T00:00:00.000Z' };
}

function okFetch(body) {
  return async () => ({ ok: true, status: 200, json: async () => body });
}

/* ── 3. offline behaviour ───────────────────────────────────────────────────── */
test('cached template keeps the app fully usable offline', async () => {
  const storage = new Map();
  seedTemplate(storage);
  const userState = seedUserState(storage);
  const h = makeHarness({ storage });
  await flush();
  assert.equal(h.run('PLANS.flat(2).length'), 392, 'cached template must load without network');
  assert.equal(h.run('HABITS.length'), 13);
  assert.equal(h.run('SCHEDULE_STATE.status'), 'ready');
  assert.equal(storage.get('jarvis_routine_v1'), JSON.stringify(userState), 'user state must be byte-identical');
  assert.equal(h.run("done('2026-11-09','p0_0_0')"), true, 'completion marks survive');
  assert.ok(h.run("itemList('2026-11-09').some(t=>t.name==='Личная правка пользователя')"), 'user override survives');
  assert.ok(h.run("itemList('2026-11-09').some(t=>t.name==='Моё личное дело')"), 'user extra survives');
});

test('first launch without cache and without server shows no schedule but keeps data', async () => {
  const storage = new Map();
  const userState = seedUserState(storage);
  const h = makeHarness({ storage });
  await flush();
  assert.equal(h.run('PLANS.length'), 0);
  assert.equal(h.run('SCHEDULE_STATE.status'), 'missing');
  assert.equal(h.run('scheduleReady()'), false);
  assert.equal(h.run('todayView()').includes('data-sched-action="import"'), true, 'banner offers a safe import path');
  assert.equal(storage.get('jarvis_routine_v1'), JSON.stringify(userState));
  assert.equal(storage.has('jarvis_schedule_template_v1'), false, 'nothing may be cached from an empty state');
});

/* ── 4. upgrade of an already installed PWA ─────────────────────────────────── */
test('existing installation upgrades: template from D1, marks and edits preserved', async () => {
  const storage = new Map();
  const userState = seedUserState(storage); // old install: state only, no template cache
  storage.set('jarvis_routine_ai_v3', JSON.stringify({ url: 'https://api.example.workers.dev', token: 'x'.repeat(30), sync: true }));
  const calls = [];
  const h = makeHarness({
    storage,
    fetchImpl: async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200, json: async () => serverTemplate(1) }; },
  });
  await flush();
  assert.ok(calls.length >= 1, 'upgrade must retrieve the private template once');
  assert.match(calls[0].url, /\/api\/schedule-template$/);
  assert.match(calls[0].opts.headers.Authorization, /^Bearer /);
  assert.equal(h.run('PLANS.flat(2).length'), 392);
  assert.equal(h.run('SCHEDULE_STATE.status'), 'ready');
  assert.equal(h.run("done('2026-11-09','p0_0_0')"), true);
  assert.equal(h.run("done('2026-11-09','p0_0_1')"), true);
  assert.equal(h.run("habitDone('2026-11-09','wake')"), true);
  assert.equal(h.run("itemList('2026-11-09').some(t=>t.name==='Личная правка пользователя')"), true);
  assert.equal(h.run("itemList('2026-11-09').some(t=>t.name==='Моё личное дело')"), true);
  assert.equal(h.run("parity('2026-11-16')"), 1, 'manual anchor parity is respected');
  assert.ok(storage.has('jarvis_schedule_template_v1'), 'template cached for offline use after upgrade');
  const saved = JSON.parse(storage.get('jarvis_routine_v1'));
  assert.deepEqual(saved.done, userState.done);
  assert.deepEqual(saved.extras, userState.extras);
  assert.deepEqual(saved.overrides, userState.overrides);
  assert.deepEqual(saved.anchor, userState.anchor);
});

/* ── 5. empty / hostile / stale templates can never destroy data ────────────── */
test('empty remote template is rejected and the cached schedule survives', async () => {
  const storage = new Map();
  seedTemplate(storage, 3);
  const before = storage.get('jarvis_schedule_template_v1');
  storage.set('jarvis_routine_ai_v3', JSON.stringify({ url: 'https://api.example.workers.dev', token: 'y'.repeat(30) }));
  const h = makeHarness({
    storage,
    fetchImpl: okFetch({ version: 4, payload: { plans: [[[]]], habits: [] } }),
  });
  await flush();
  assert.equal(h.run('PLANS.flat(2).length'), 392, 'empty template must not replace real tasks');
  assert.equal(storage.get('jarvis_schedule_template_v1'), before, 'cache must stay untouched');
});

test('older server template never downgrades a newer local one', async () => {
  const storage = new Map();
  seedTemplate(storage, 9);
  const before = storage.get('jarvis_schedule_template_v1');
  storage.set('jarvis_routine_ai_v3', JSON.stringify({ url: 'https://api.example.workers.dev', token: 'z'.repeat(30) }));
  const h = makeHarness({ storage, fetchImpl: okFetch(serverTemplate(2)) });
  await flush();
  assert.equal(h.run('PLANS.flat(2).length'), 392);
  assert.equal(storage.get('jarvis_schedule_template_v1'), before);
});

test('newer server template upgrades while keeping user marks', async () => {
  const storage = new Map();
  seedTemplate(storage, 1);
  seedUserState(storage);
  storage.set('jarvis_routine_ai_v3', JSON.stringify({ url: 'https://api.example.workers.dev', token: 'w'.repeat(30) }));
  const h = makeHarness({ storage, fetchImpl: okFetch(serverTemplate(2)) });
  await flush();
  assert.equal(JSON.parse(storage.get('jarvis_schedule_template_v1')).version, 2);
  assert.equal(h.run("done('2026-11-09','p0_0_0')"), true);
});

/* ── 6. backend keeps the template private ─────────────────────────────────── */
async function workerWithDB() {
  const src = fs.readFileSync(path.join(root, 'backend', 'src', 'worker.js'), 'utf8')
    .replace(/^import \{ buildPushPayload \}.*;\s*/m, 'const buildPushPayload=async()=>({});\n');
  const dir = mkdtempSync(path.join(tmpdir(), 'privacy-worker-'));
  writeFileSync(path.join(dir, 'worker.mjs'), src);
  const { default: worker } = await import('file://' + path.join(dir, 'worker.mjs'));
  const state = { row: null };
  const env = {
    APP_ACCESS_TOKEN: 'a'.repeat(32),
    ALLOWED_ORIGIN: 'https://jarvis-routine.demo.workers.dev',
    DB: {
      prepare(sql) {
        const first = async () => (/FROM\s+schedule_template/i.test(sql) ? state.row : null);
        const run = async (args) => {
          if (/INSERT OR IGNORE INTO schedule_template/i.test(sql)) {
            if (state.row) return { meta: { changes: 0 } };
            state.row = { version: 1, payload: args[0], updated_at: args[1] };
            return { meta: { changes: 1 } };
          }
          if (/UPDATE schedule_template/i.test(sql)) {
            const [payload, stamp, expected] = args;
            if (!state.row || Number(state.row.version) !== Number(expected)) return { meta: { changes: 0 } };
            state.row = { version: Number(expected) + 1, payload, updated_at: stamp };
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 1 } };
        };
        return {
          bind(...args) {
            return { run: () => run(args), first: () => first(), all: async () => ({ results: [] }) };
          },
          first: () => first(),
          run: () => run([]),
          all: async () => ({ results: [] }),
        };
      },
      batch: async () => [],
    },
  };
  return { worker, env, state };
}

const BASE = 'https://jarvis-routine-api.demo.workers.dev';

test('unauthenticated requests cannot read the private schedule', async () => {
  const { worker, env, state } = await workerWithDB();
  state.row = { version: 1, payload: JSON.stringify({ plans: privateTemplate.plans, habits: privateTemplate.habitList }), updated_at: 'now' };
  const anonymous = await worker.fetch(new Request(BASE + '/api/schedule-template'), env);
  assert.equal(anonymous.status, 401);
  const body = await anonymous.text();
  assert.equal(body.includes('p0_0_0'), false, 'no schedule data may leak with a 401');

  const wrongToken = await worker.fetch(new Request(BASE + '/api/schedule-template', { headers: { Authorization: 'Bearer ' + 'b'.repeat(32) } }), env);
  assert.equal(wrongToken.status, 401);

  const wrongOrigin = await worker.fetch(new Request(BASE + '/api/schedule-template', {
    headers: { Origin: 'https://evil.example', Authorization: 'Bearer ' + env.APP_ACCESS_TOKEN },
  }), env);
  assert.equal(wrongOrigin.status, 403);
});

test('empty database returns 404, not an empty schedule', async () => {
  const { worker, env } = await workerWithDB();
  const res = await worker.fetch(new Request(BASE + '/api/schedule-template', { headers: { Authorization: 'Bearer ' + env.APP_ACCESS_TOKEN } }), env);
  assert.equal(res.status, 404);
});

test('worker refuses to store an empty or malformed template', async () => {
  const { worker, env } = await workerWithDB();
  const post = (payload, expectedVersion = 0) => worker.fetch(new Request(BASE + '/api/schedule-template', {
    method: 'POST',
    headers: { Origin: env.ALLOWED_ORIGIN, Authorization: 'Bearer ' + env.APP_ACCESS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload, expectedVersion }),
  }), env);

  assert.equal((await post({ plans: [], habits: [] })).status, 400);
  assert.equal((await post({ plans: [[[]]], habits: [] })).status, 400);
  assert.equal((await post({ plans: [[[{ id: 'a', start: '99:99', end: '10:00', name: 'x' }]]], habits: [] })).status, 400);
  assert.equal((await post({ plans: [[[{ id: 'a', start: '09:00', end: '10:00', name: '' }]]], habits: [] })).status, 400);
  assert.equal((await post({ plans: privateTemplate.plans, habits: privateTemplate.habitList })).status, 200);
});

test('authorized client reads back exactly the stored template, versioned CAS', async () => {
  const { worker, env } = await workerWithDB();
  const headers = { Origin: env.ALLOWED_ORIGIN, Authorization: 'Bearer ' + env.APP_ACCESS_TOKEN, 'Content-Type': 'application/json' };
  const first = await worker.fetch(new Request(BASE + '/api/schedule-template', {
    method: 'POST', headers, body: JSON.stringify({ payload: { plans: privateTemplate.plans, habits: privateTemplate.habitList }, expectedVersion: 0 }),
  }), env);
  assert.equal(first.status, 200);
  assert.equal((await first.json()).version, 1);

  const read = await worker.fetch(new Request(BASE + '/api/schedule-template', { headers }), env);
  assert.equal(read.status, 200);
  const data = await read.json();
  assert.equal(data.payload.plans.flat(2).length, 392);
  assert.equal(data.payload.habits.length, 13);

  const stale = await worker.fetch(new Request(BASE + '/api/schedule-template', {
    method: 'POST', headers, body: JSON.stringify({ payload: { plans: privateTemplate.plans, habits: privateTemplate.habitList }, expectedVersion: 0 }),
  }), env);
  assert.equal(stale.status, 409, 'second writer with a stale version must be rejected');
});