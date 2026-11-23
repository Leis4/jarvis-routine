#!/usr/bin/env node
/**
 * Step 1 of the privacy migration: export the personal schedule template that is
 * currently inlined in the PUBLIC site/index.html into a private, git-ignored file.
 *
 * Outputs:
 *   private/schedule-template.v1.json      (canonical private source of truth)
 *   backups/schedule-template.v1.<ts>.json (immutable timestamped backup)
 *
 * The script prints only aggregate counters, never personal block titles.
 *
 * Usage: node tools/privacy/extract-schedule.mjs [--from <file-with-const-lines>]
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..', '..');
const args = process.argv.slice(2);
const fromIdx = args.indexOf('--from');
const source = fromIdx >= 0 ? path.resolve(args[fromIdx + 1]) : path.join(root, 'site', 'index.html');

const raw = fs.readFileSync(source, 'utf8');

function constLine(name) {
  const line = raw.split(/\r?\n/).find((l) => l.startsWith(`const ${name}=`));
  if (!line) throw new Error(`const ${name}= not found in ${source}`);
  return line;
}
function evalConst(name) {
  const ctx = vm.createContext({});
  return vm.runInContext(`${constLine(name)}\n;${name}`, ctx, { filename: `extract-${name}.js`, timeout: 30000 });
}

const plans = evalConst('PLANS');
const habits = evalConst('HABITS');

// ---- validation (fail loudly, never emit a partial template) ----
function fail(msg) {
  console.error('EXTRACT FAILED:', msg);
  process.exit(1);
}
if (!Array.isArray(plans) || plans.length !== 2) fail('PLANS must be an array of 2 week parities');
if (!Array.isArray(habits)) fail('HABITS must be an array');

const ids = new Set();
let total = 0;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
for (const [p, week] of plans.entries()) {
  if (!Array.isArray(week) || week.length !== 7) fail(`PLANS[${p}] must contain 7 days`);
  for (const [d, day] of week.entries()) {
    if (!Array.isArray(day)) fail(`PLANS[${p}][${d}] must be an array`);
    for (const item of day) {
      if (!item || typeof item !== 'object') fail(`invalid item in PLANS[${p}][${d}]`);
      if (typeof item.id !== 'string' || !item.id) fail(`item without id in PLANS[${p}][${d}]`);
      if (ids.has(item.id)) fail(`duplicate id ${item.id}`);
      ids.add(item.id);
      if (!TIME.test(item.start) || !TIME.test(item.end)) fail(`invalid time in ${item.id}`);
      if (typeof item.name !== 'string' || !item.name.trim()) fail(`empty name in ${item.id}`);
      total++;
    }
  }
}
if (total !== 392) fail(`expected 392 blocks, found ${total}`);
for (const h of habits) {
  if (!h || typeof h.id !== 'string' || typeof h.name !== 'string' || !Array.isArray(h.days)) fail('invalid habit entry');
}

let gitHead = 'unknown';
try {
  gitHead = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
} catch {}

const payload = {
  schema: 'jarvis-schedule-template',
  version: 1,
  count: total,
  habits: habits.length,
  generatedAt: new Date().toISOString(),
  source: path.relative(root, source).replace(/\\/g, '/'),
  sourceHead: gitHead,
  plans,
  habitList: habits,
};
const json = JSON.stringify(payload);
const digest = crypto.createHash('sha256').update(json).digest('hex');

const privatePath = path.join(root, 'private', 'schedule-template.v1.json');
const backupDir = path.join(root, 'backups');
fs.mkdirSync(path.dirname(privatePath), { recursive: true });
fs.mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = path.join(backupDir, `schedule-template.v1.${stamp}.json`);

// Never clobber a newer/equal private template silently: keep every extraction as a backup.
if (fs.existsSync(privatePath)) {
  const prev = fs.readFileSync(privatePath, 'utf8');
  const prevHash = crypto.createHash('sha256').update(prev).digest('hex');
  if (prevHash !== digest) {
    fs.writeFileSync(path.join(backupDir, `schedule-template.v1.prev-${stamp}.json`), prev);
  }
}
fs.writeFileSync(privatePath, json);
fs.writeFileSync(backupPath, json);
fs.writeFileSync(`${backupPath}.sha256`, `${digest}  schedule-template.v1.json\n`);

console.log('schedule template exported');
console.log('  blocks :', total);
console.log('  habits :', habits.length);
console.log('  bytes  :', json.length);
console.log('  sha256 :', digest);
console.log('  file   :', path.relative(root, privatePath));
console.log('  backup :', path.relative(root, backupPath));
console.log('  gitignored:', (() => {
  try {
    execFileSync('git', ['check-ignore', '-q', path.relative(root, privatePath).replace(/\\/g, '/')], { cwd: root });
    return 'yes';
  } catch {
    return 'NO — add private/ to .gitignore before committing';
  }
})());