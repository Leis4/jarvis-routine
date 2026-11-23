'use strict';
/* Shared loader for the PRIVATE schedule template used by local regression tests.
 *
 * The personal 392-block schedule no longer exists in public assets, so tests that
 * need real tasks load it from `private/schedule-template.v1.json` (git-ignored).
 * Nothing in this helper writes the template into the repository.
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const file = path.join(root, 'private', 'schedule-template.v1.json');

function load() {
  if (!fs.existsSync(file)) return null;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!data || !Array.isArray(data.plans)) throw new Error('private schedule template is malformed');
  return {
    plans: data.plans,
    habits: Array.isArray(data.habitList) ? data.habitList : (Array.isArray(data.habits) ? data.habits : []),
    count: typeof data.count === 'number' ? data.count : data.plans.flat(2).length,
    version: data.version || 1,
  };
}

/** Installs PLANS/HABITS into an already-created VM context and marks the schedule ready. */
function install(run) {
  const tpl = load();
  if (!tpl) throw new Error(`private schedule template missing: ${path.relative(root, file)} — run "node tools/privacy/extract-schedule.mjs"`);
  run(
    `PLANS=${JSON.stringify(tpl.plans)};HABITS=${JSON.stringify(tpl.habits)};` +
      `SCHEDULE_STATE.status='ready';SCHEDULE_STATE.message='';`,
    'private-template.js'
  );
  return tpl;
}

module.exports = { load, install, file, root };