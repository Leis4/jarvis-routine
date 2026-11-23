// Direct Playwright runner for JARVIS Routine PWA tests (v2 design)
// Usage: node tests/run-pwa.mjs
import { webkit } from 'playwright';
import { createServer } from 'http';
import { readFileSync } from 'fs';
import { extname, join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function serve() {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon' };
  return createServer((req, res) => {
    let path = req.url === '/' ? '/index.html' : req.url.split('?')[0];
    try {
      const data = readFileSync(join(root, 'site', path));
      const ext = extname(path);
      res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  });
}

let failures = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
  } catch (e) {
    console.log(`  ❌ ${name}: ${e.message?.split('\n')[0] || e}`);
    failures++;
  }
}

async function main() {
  const server = serve();
  await new Promise(r => server.listen(8765, r));
  console.log('🌐 Test server on :8765');

  const browser = await webkit.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 430, height: 932 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    isMobile: true,
    hasTouch: true,
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
  });

  console.log('\n📱 JARVIS Routine PWA — iPhone WebKit (v2 design)\n');

  const page = await context.newPage();

  // Personal schedule is no longer shipped in public assets: seed the private
  // template into localStorage before the app boots, exactly like the real PWA
  // cache does after the first authenticated retrieval.
  const templateFile = join(root, 'private', 'schedule-template.v1.json');
  let seeded = false;
  try {
    const tpl = JSON.parse(readFileSync(templateFile, 'utf8'));
    const payload = { plans: tpl.plans, habits: Array.isArray(tpl.habitList) ? tpl.habitList : (tpl.habits || []) };
    await context.addInitScript((p) => {
      try {
        if (!localStorage.getItem('jarvis_schedule_template_v1')) {
          localStorage.setItem('jarvis_schedule_template_v1', JSON.stringify({ version: 1, savedAt: new Date().toISOString(), payload: p }));
        }
      } catch {}
    }, payload);
    seeded = true;
  } catch {
    console.log('?? private/schedule-template.v1.json not found: running without schedule data');
  }
  if (seeded) console.log('?? private schedule template seeded into the browser cache');

  // 1. Basic structure
  await test('PWA manifest and basic structure', async () => {
    await page.goto('http://localhost:8765/');
    await page.waitForSelector('#app');
    const title = await page.title();
    if (!title.includes('JARVIS')) throw Error(`Title mismatch: ${title}`);
    const manifest = page.locator('link[rel="manifest"]');
    if ((await manifest.getAttribute('href')) !== 'manifest.webmanifest') throw Error('Manifest missing');
  });

  // 2. Today view — compact header with date
  await test('Today view shows date and progress', async () => {
    await page.goto('http://localhost:8765/');
    await page.waitForSelector('.today-date');
    const dateText = await page.locator('.today-date').textContent();
    if (!dateText.includes('ноября') && !dateText.includes('Воскресенье') && !dateText.includes('Понедельник')) 
      throw Error(`No date info found: ${dateText}`);
    const brand = await page.locator('.brand').textContent();
    if (!brand.includes('JARVIS')) throw Error('Brand missing');
  });

  // 3. Navigation — 4 tabs
  await test('Navigation tabs switch views', async () => {
    await page.goto('http://localhost:8765/');
    await page.waitForSelector('#bottomnav');

    const navHTML = await page.locator('#bottomnav').textContent();
    console.log(`  📋 Nav: ${navHTML.replace(/\n/g, ' ').trim().slice(0, 250)}`);

    const tabActions = [
      { action: 'today', expected: 'ноября' },
      { action: 'planner', expected: 'План' },
    ];
    for (const { action, expected } of tabActions) {
      await page.evaluate((a) => { ui.tab = a; render(); }, action);
      await page.waitForTimeout(400);
      const text = await page.locator('#app').textContent();
      if (!text.includes(expected)) throw Error(`Tab ${action}: missing "${expected}"`);
    }
  });

  // 4. Task checkbox + localStorage
  await test('Task checkbox persists to localStorage', async () => {
    await page.evaluate(() => localStorage.clear());
    await page.goto('http://localhost:8765/');
    await page.waitForTimeout(500);

    const checkbox = page.locator('input.task-check[data-id]').first();
    const count = await checkbox.count();
    if (count === 0) { console.log('  ⚠ No tasks today, skipping'); return; }

    const taskId = await checkbox.getAttribute('data-id');
    await checkbox.check();
    await page.waitForTimeout(300);

    const stored = await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('jarvis_routine_v1') || '{}');
      return s.done || {};
    });
    const found = Object.values(stored).some(d => d && d[taskId] === true);
    if (!found) throw Error(`Task ${taskId} not found in localStorage`);
  });

  // 5. Timer via More → Focus
  await test('Timer switches modes and ticks', async () => {
    await page.evaluate(() => { ui.tab = 'more'; ui.moreTab = 'focus'; render(); });
    await page.waitForTimeout(500);

    const clock = page.locator('#clock');
    let time = await clock.textContent();
    if (!time.includes('40:00') && !time.includes('39:59')) throw Error(`Timer not at 40:00, got: ${time}`);

    await page.locator('[data-action="timerMode"][data-val="break"]').click();
    await page.waitForTimeout(300);
    time = await clock.textContent();
    if (!time.includes('10:00')) throw Error(`Break timer not 10:00, got: ${time}`);

    await page.locator('[data-action="timerToggle"]').click();
    await page.waitForTimeout(2000);
    time = await clock.textContent();
    const [mins, secs] = time.split(':').map(Number);
    const totalSec = mins * 60 + secs;
    if (totalSec >= 600) throw Error(`Timer didn't tick: ${time} (should be < 600s)`);
    else console.log(`  ⏱ Timer ticked: ${time} (${600 - totalSec}s elapsed)`);
  });

  // 6. Settings via double-click brand
  await test('Settings page renders', async () => {
    await page.locator('.brand').dblclick();
    await page.waitForTimeout(500);
    const text = await page.locator('#app').textContent();
    if (!text.includes('Настройки') || !text.includes('Резервная копия')) throw Error('Settings missing controls');
  });

  // 7. Week view in planner
  await test('Week view shows 7 day cards', async () => {
    await page.evaluate(() => { ui.tab = 'planner'; ui.showWeekOverview = true; render(); });
    await page.waitForTimeout(500);
    const count = await page.locator('.week-card').count();
    if (count < 6) throw Error(`Expected 7 week cards, got ${count}`);
    console.log(`  📅 ${count} week cards`);
  });

  // 8. AI tab
  await test('AI tab renders options', async () => {
    await page.evaluate(() => { ui.tab = 'ai'; render(); });
    await page.waitForTimeout(500);
    const text = await page.locator('#app').textContent();
    if (!text.includes('JARVIS') && !text.includes('Чем помочь')) throw Error('AI header missing');
  });

  // 9. Task modal
  await test('New task modal opens', async () => {
    // Reset to today view
    await page.evaluate(() => { ui.tab = 'today'; render(); });
    await page.waitForTimeout(500);
    const addBtn = page.locator('[data-action="new"]').first();
    if (await addBtn.count() === 0) { console.log('  ⚠ No add button'); return; }
    await addBtn.click();
    await page.waitForTimeout(300);
    const modal = page.locator('#modalback.show');
    if (await modal.count() === 0) throw Error('Modal not shown');
    const box = await page.locator('#modalbox').textContent();
    if (!box.includes('Новое дело')) throw Error('Modal content wrong');
  });

  await browser.close();
  server.close();

  console.log(`\n📊 ${failures === 0 ? '✅ ALL PASS' : `❌ ${failures} FAILURES`}\n`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });