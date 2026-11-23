/* Playwright helper (CommonJS so the .spec.js files can require it).
   Seeds the PRIVATE schedule template into localStorage before the app boots, so
   browser tests exercise real data without the repository shipping personal content.
   Skipped automatically when private/ is absent. */
const { readFileSync, existsSync } = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const file = path.join(root, 'private', 'schedule-template.v1.json');
let cached;

function privateTemplate() {
  if (cached !== undefined) return cached;
  if (!existsSync(file)) { cached = false; return cached; }
  const data = JSON.parse(readFileSync(file, 'utf8'));
  cached = { plans: data.plans, habits: Array.isArray(data.habitList) ? data.habitList : (data.habits || []) };
  return cached;
}

async function seedScheduleTemplate(page) {
  const template = privateTemplate();
  if (!template) return false;
  await page.addInitScript((tpl) => {
    try {
      if (!localStorage.getItem('jarvis_schedule_template_v1')) {
        localStorage.setItem('jarvis_schedule_template_v1', JSON.stringify({ version: 1, savedAt: new Date().toISOString(), payload: tpl }));
      }
    } catch {}
  }, template);
  return true;
}

/* The private template is a fully packed day (no free windows), so tests that need to
   create a task must explicitly free the day first instead of hunting for a gap.
   Only local state is touched: blocks of `date` are marked deleted and AI extras dropped. */
async function freeDayForTests(page, date) {
  await page.evaluate((d) => {
    if (typeof S === 'undefined' || typeof render !== 'function') return;
    S.overrides = S.overrides || {};
    const blocks = typeof planDay === 'function' ? planDay(d) : [];
    for (const t of blocks) S.overrides[t.id] = { ...(S.overrides[t.id] || {}), deleted: true };
    S.extras = (S.extras || []).filter((t) => !/^x_ai_/.test(String(t.id)));
    if (typeof persist === 'function') persist();
    render();
  }, date);
}

module.exports = { seedScheduleTemplate, privateTemplate, freeDayForTests };