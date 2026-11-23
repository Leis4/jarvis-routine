#!/usr/bin/env node
/**
 * One-command release gate for JARVIS Routine v41 (privacy migration).
 *
 * Runs every deterministic, offline check. No paid API calls, no deployments.
 * Playwright/WebKit suites are listed at the end as a separate step.
 *
 * Usage: node tools/privacy/release-check.mjs
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');

const NODE_TESTS = [
  'tests/privacy-migration.mjs',
  'tests/test-worker.mjs',
  'tests/site-syntax.mjs',
  'tests/api-integration.mjs',
  'tests/action-schema-safety.mjs',
  'tests/forensic-integrity.mjs',
  'tests/focus-timebox.mjs',
];
const PLAIN_TESTS = [
  'tests/calendar34-vm.cjs',
  'tests/ui32-regression.cjs',
  'tests/replan-vm-safety.cjs',
  'tests/midnight-replan.cjs',
  'tests/recur-parse.cjs',
  'tests/flex-policy.cjs',
  'tests/study-heatmap.cjs',
  'tests/v43-integration.cjs',
  'tests/smoke-ui.cjs',
];
const SCRIPTS = ['tests/_verify.mjs', 'tests/_check_release.mjs'];

let failed = 0;
function run(label, args) {
  const res = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
  const ok = res.status === 0;
  if (!ok) failed++;
  const tail = (res.stdout || '').trim().split(/\r?\n/).filter((l) => /pass|fail|PASS|FAIL|OK |Error|Assertion/i.test(l)).slice(-3).join(' | ');
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${tail ? ' :: ' + tail : ''}`);
  if (!ok) console.log((res.stdout || '') + (res.stderr || ''));
}

for (const file of NODE_TESTS) run(file, ['--test', file]);
for (const file of PLAIN_TESTS) run(file, [file]);
for (const file of SCRIPTS) run(file, [file]);

console.log(failed ? `\n${failed} check(s) failed` : '\nAll release checks passed');
console.log('\nBrowser suites (optional, local):');
console.log('  node tests/replan-offline-e2e.mjs        # offline AI replanning on WebKit');
console.log('  node tests/run-pwa.mjs                   # PWA smoke on iPhone WebKit');
console.log('  npx playwright test --config=playwright.config.js');
process.exit(failed ? 1 : 0);