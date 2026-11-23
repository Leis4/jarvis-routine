#!/usr/bin/env node
/**
 * Step 2 of the privacy migration: remove the personal schedule and habits from the
 * PUBLIC site/index.html and replace them with an empty, offline-capable bootstrap.
 *
 * Safety gates (the script refuses to run when any gate fails):
 *   - private/schedule-template.v1.json must exist and contain exactly 392 blocks
 *   - the private template must match the current inline PLANS (block-by-block)
 *   - index.html must still contain the inline PLANS block (never runs twice)
 *
 * It never touches localStorage contents, user overrides, or the backend.
 *
 * Usage: node tools/privacy/strip-inline-schedule.mjs [--write]
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import crypto from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..', '..');
const write = process.argv.includes('--write');
const indexPath = path.join(root, 'site', 'index.html');
const templatePath = path.join(root, 'private', 'schedule-template.v1.json');

function die(msg) {
  console.error('ABORT:', msg);
  process.exit(1);
}

if (!fs.existsSync(templatePath)) die('private/schedule-template.v1.json missing — run extract-schedule.mjs first');
const template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));

let html = fs.readFileSync(indexPath, 'utf8');
const lines = html.split(/\r?\n/);

const plansIdx = lines.findIndex((l) => l.startsWith('const PLANS='));
const habitsIdx = lines.findIndex((l) => l.startsWith('const HABITS='));
if (plansIdx < 0) die('inline PLANS not found — migration already applied or file changed');
if (habitsIdx < 0) die('inline HABITS not found — migration already applied or file changed');

function evalConst(line, name) {
  const ctx = vm.createContext({});
  return vm.runInContext(`${line}\n;${name}`, ctx, { filename: `strip-${name}.js`, timeout: 30000 });
}
const inlinePlans = evalConst(lines[plansIdx], 'PLANS');
const inlineHabits = evalConst(lines[habitsIdx], 'HABITS');

const inlineCount = inlinePlans.flat(2).length;
if (inlineCount !== 392) die(`inline PLANS has ${inlineCount} blocks, expected 392`);
if (template.count !== 392) die(`private template has ${template.count} blocks, expected 392`);

// Byte-exact content parity between the public copy and the private backup.
const h = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
if (h(inlinePlans) !== h(template.plans)) die('private template does not match inline PLANS — re-run extraction');
if (h(inlineHabits) !== h(template.habitList)) die('private template habits do not match inline HABITS');

const PUBLIC_PLANS_STUB =
  'let PLANS=[]; /* PRIVACY: personal 392-block schedule removed from public HTML. ' +
  'Loaded at runtime from private storage by schedule-bootstrap.js (D1 or local import). */';
const SCHEDULE_STATE_LINE =
  "const SCHEDULE_STATE={status:'loading',message:''};";
const PUBLIC_HABITS_STUB =
  'let HABITS=[]; /* PRIVACY: personal habits removed from public HTML. Loaded with the private schedule template. */';
const HELPERS = [
  'function scheduleReady(){return Array.isArray(PLANS)&&PLANS.length>0}',
  'function planDay(s){const w=PLANS[parity(s)];const d=Array.isArray(w)?w[indexDay(s)]:null;return Array.isArray(d)?d:[]}',
  'function scheduleBanner(){if(SCHEDULE_STATE.status===\'ready\')return \'\';',
  ' const label=SCHEDULE_STATE.status===\'loading\'?\'Загружаю расписание…\':SCHEDULE_STATE.status===\'missing\'?\'Расписание ещё не загружено на этом устройстве\':SCHEDULE_STATE.message||\'Нет доступа к расписанию\';',
  ' return `<div class="card sched-banner" role="status"><b>${safe(label)}</b><p class="tagline">Личное расписание хранится приватно и загружается один раз. Данные на этом устройстве сохранены.</p><div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn tight" data-sched-action="fetch">Подключить сервер</button><button class="btn tight" data-sched-action="import">Импорт файла</button>${scheduleReady()?\'<button class="btn tight" data-sched-action="export">Скачать копию</button>\':\'\'}</div></div>`}',
].join('\n');

const newLines = lines.slice();
newLines[plansIdx] = `${SCHEDULE_STATE_LINE}\n${PUBLIC_PLANS_STUB}`;
newLines[habitsIdx] = `${PUBLIC_HABITS_STUB}\n${HELPERS}`;
html = newLines.join('\n');

// Old version of the code read the inline template directly; use the guarded accessor.
const beforePlansUse = 'let p=PLANS[parity(s)][indexDay(s)].map(';
if (!html.includes(beforePlansUse)) die('expected baseItemList PLANS access not found');
html = html.replace(beforePlansUse, 'let p=planDay(s).map(');

// Surface the private-storage state on every screen.
const headerOld = 'function appHeader(){return `<div class="topbar">';
if (!html.includes(headerOld)) die('appHeader not found');
html = html.replace(headerOld, 'function appHeader(){return scheduleBanner()+`<div class="topbar">');

// Load the bootstrap before the feature modules (they are also plain classic scripts).
const scriptAnchor = '<script src="smart.js?v=8"></script>';
if (!html.includes(scriptAnchor)) die('smart.js script tag not found');
html = html.replace(scriptAnchor, '<script src="schedule-bootstrap.js?v=1"></script>' + scriptAnchor);

if (!write) {
  console.log('DRY RUN — no files changed. Re-run with --write.');
  console.log('  blocks to remove :', inlineCount);
  console.log('  habits to remove :', inlineHabits.length);
  console.log('  public PLANS stub bytes:', PUBLIC_PLANS_STUB.length);
  process.exit(0);
}

fs.writeFileSync(indexPath, html);

const check = fs.readFileSync(indexPath, 'utf8');
if (check.includes('const PLANS=')) die('PLANS literal still present in index.html');
if (check.includes('"p0_0_0"')) die('task ids still present in index.html');
for (const habitName of inlineHabits.slice(0, 3).map((x) => x.name)) {
  if (check.includes(habitName)) die('habit text still present in index.html');
}
if (/Лечебный шампунь|Проверить ногти|Разбор недели/.test(check)) die('personal habit text still present');

console.log('index.html sanitized');
console.log('  removed blocks :', inlineCount);
console.log('  removed habits :', inlineHabits.length);
console.log('  new file bytes :', check.length);
console.log('  backup file    : private/schedule-template.v1.json (git-ignored)');