// JARVIS Routine — offline replanning E2E (no server, no AITunnel, no cost).
// Reproduces the reported scenario:
//   "Я сегодня проснулся поздно. Перестрой остаток дня,
//    сохрани обязательные дела и перенеси необязательные."
// and verifies: short human answer, no raw JSON, real schedule changes,
// persisted result, working undo, protected events untouched.
// Usage: node tests/replan-offline-e2e.mjs
import { webkit } from 'playwright';
import { createServer } from 'http';
import { readFileSync } from 'fs';
import { extname, join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8798;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon' };

const server = createServer((req, res) => {
  const p = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  try {
    const data = readFileSync(join(root, 'site', p));
    res.writeHead(200, { 'Content-Type': types[extname(p)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('Not found'); }
});
await new Promise(r => server.listen(PORT, r));

const MESSAGE = 'Я сегодня проснулся поздно. Перестрой остаток дня, сохрани обязательные дела и перенеси необязательные.';
let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  OK   ${name}`);
  else { console.log(`  FAIL ${name}${extra ? ' - ' + extra : ''}`); failures++; }
};

const browser = await webkit.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 430, height: 932 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  isMobile: true, hasTouch: true, locale: 'ru-RU', timezoneId: 'Europe/Moscow',
});
const page = await context.newPage();

// The personal schedule is no longer shipped in public assets; seed the private
// template so offline replanning runs against the real 392-block schedule.
try {
  const tpl = JSON.parse(readFileSync(join(root, 'private', 'schedule-template.v1.json'), 'utf8'));
  const payload = { plans: tpl.plans, habits: Array.isArray(tpl.habitList) ? tpl.habitList : (tpl.habits || []) };
  await context.addInitScript((p) => {
    try {
      if (!localStorage.getItem('jarvis_schedule_template_v1')) {
        localStorage.setItem('jarvis_schedule_template_v1', JSON.stringify({ version: 1, savedAt: new Date().toISOString(), payload: p }));
      }
    } catch {}
  }, payload);
} catch {
  console.log('  ?? private/schedule-template.v1.json missing: run node tools/privacy/extract-schedule.mjs');
}

let apiCalls = 0;
await page.route('**/api/**', route => { apiCalls++; route.abort(); });
page.on('pageerror', e => console.log('PAGEERROR', (e.stack || e.message || String(e)).slice(0, 500)));

try {
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector('#app', { state: 'attached', timeout: 20000 });
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector('#app', { state: 'attached', timeout: 20000 });
  await page.waitForFunction(() => typeof window.smartReplan === 'function' && typeof window.sendChat === 'function');

  console.log('\nReplan E2E - iPhone WebKit, offline\n');

  // 1. Planner API reachable from the AI layer (this is what was broken).
  const globals = await page.evaluate(() => ({
    buildSmartPlan: typeof window.buildSmartPlan,
    smartReplan: typeof window.smartReplan,
    revertPlan: typeof window.revertPlan,
    sendChat: typeof window.sendChat,
  }));
  check('planner API exposed globally', Object.values(globals).every(v => v === 'function'), JSON.stringify(globals));

  // 2. Late wake-up: user got up at 10:30 instead of the default.
  const before = await page.evaluate(() => {
    const date = today();
    S.wakeTimes[date] = '10:30';
    persist();
    return {
      date,
      protectedTasks: itemList(date).filter(t => window.plannerIsFixed(t, date)).map(t => [t.id, t.start, t.end]),
      requiredTasks: itemList(date).filter(t => t.status === 'Обязательно').map(t => ({ id:t.id, name:t.name })),
      taskNames: itemList(date).map(t => t.name),
    };
  });
  check('schedule snapshot taken', before.taskNames.length > 0, `${before.taskNames.length} tasks`);
  check('protected events present', before.protectedTasks.length > 0, `${before.protectedTasks.length} locked`);

  // 3. Send the exact reported request through the real UI form (AI tab).
  await page.evaluate(() => { ui.tab = 'ai'; render(); });
  await page.fill('#aiPrompt', MESSAGE);
  await page.evaluate(() => document.querySelector('#aiChatForm').requestSubmit());
  await page.waitForFunction(() => window.aiState.history.some(m => String(m.model || '').includes('план обновлён')), null, { timeout: 20000 });

  const result = await page.evaluate(({ date }) => {
    const stored = JSON.parse(localStorage.getItem('jarvis_routine_v1') || '{}');
    return {
      connected: window.aiState.connected,
      history: window.aiState.history.map(m => ({ model: m.model, content: m.content })),
      status: window.aiState.status,
      appText: document.querySelector('#app').textContent,
      dayAdjust: stored.dayAdjust?.[date] || null,
      persistUndo: JSON.stringify(stored.planUndo?.[date] || null),
      pending: stored.pending?.[date] || null,
      extrasNames: (stored.extras || []).map(t => t.name),
      todayNames: itemList(date).map(t => t.name),
      protectedAfter: itemList(date).filter(t => window.plannerIsFixed(t, date)).map(t => [t.id, t.start, t.end]),
      plannedIds: Object.keys(stored.dayAdjust?.[date] || {}),
    };
  }, { date: before.date });

  // 4. No server, no API cost.
  check('replan worked without any API call', apiCalls === 0 && result.connected === false, `apiCalls=${apiCalls}, connected=${result.connected}`);

  // 5. Human answer, no raw JSON and no internal reasoning.
  const answer = result.history.filter(m => String(m.model || '').includes('план обновлён')).map(m => m.content).join('\n');
  check('short human answer produced', answer.length > 0 && answer.length < 700, `${answer.length} chars`);
  check('no raw JSON in the answer', !/\{"answer"/.test(answer) && !/\{"action"/.test(answer));
  check('no truncated JSON in the UI', !/\{"answer"/.test(result.appText) && !/finish_reason/.test(result.appText));
  check('reasoning never shown to the user', !/рассужд|reasoning_content/i.test(result.appText));
  console.log(`       answer: ${answer.replace(/\s+/g, ' ').slice(0, 220)}`);

  // 6. Real proposed/applied changes saved locally.
  check('changes persisted to localStorage', result.dayAdjust !== null && result.plannedIds.length > 0, `planned=${result.plannedIds.length}`);
  check('undo snapshot stored', result.persistUndo !== 'null' && result.persistUndo !== null);

  // 7. Protected events untouched.
  check('protected events unchanged', JSON.stringify(result.protectedAfter) === JSON.stringify(before.protectedTasks),
    `before=${JSON.stringify(before.protectedTasks)} after=${JSON.stringify(result.protectedAfter)}`);
  check('no protected event inside dayAdjust', result.plannedIds.every(id => !before.protectedTasks.some(p => p[0] === id)));

  // 8. Required tasks are kept somewhere (today, deferred list, or another day).
  const missing = before.requiredTasks.filter(t =>
    !result.todayNames.includes(t.name) && !result.extrasNames.includes(t.name) &&
    !(result.pending || []).some(p => p.id === t.id) &&
    !result.dayAdjust?.[t.id]?.omit);
  check('required tasks either planned, deferred or explicitly skipped', missing.length === 0, `missing=${missing.map(t=>t.name).join(', ')}`);
  check('no required tasks falsely marked completed', await page.evaluate(d => Object.values(S.done[d]||{}).every(v => v !== true),before.date));

  // 9. Undo restores the previous schedule.
  const afterUndo = await page.evaluate(({ date }) => {
    window.revertPlan(date);
    const stored = JSON.parse(localStorage.getItem('jarvis_routine_v1') || '{}');
    return {
      dayAdjust: JSON.stringify(stored.dayAdjust?.[date] || {}),
      protectedNow: itemList(date).filter(t => window.plannerIsFixed(t, date)).map(t => [t.id, t.start, t.end]),
    };
  }, { date: before.date });
  check('undo clears the replan', afterUndo.dayAdjust === '{}', afterUndo.dayAdjust);
  check('protected events safe after undo', JSON.stringify(afterUndo.protectedNow) === JSON.stringify(before.protectedTasks));
} catch (e) {
  console.log('  FATAL: ' + (e.message || e));
  failures++;
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'}\n`);
process.exit(failures > 0 ? 1 : 0);
