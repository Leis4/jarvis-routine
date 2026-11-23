/* QA capture: real browser screenshots of the local site (Chromium + WebKit).
   Usage: node tools/qa/capture.mjs [label] [--only=today,planner,ai,more]
   Seeds the PRIVATE schedule template into localStorage before boot; nothing personal
   is written into the repository (screenshots/ is gitignored). */
import { chromium, webkit } from 'playwright';
import { readFileSync, mkdirSync, existsSync } from 'fs';
import { spawn } from 'child_process';
import path from 'path';

const root = process.cwd();
const label = process.argv[2] || 'current';
const outDir = path.join(root, 'screenshots', 'qa', label);
mkdirSync(outDir, { recursive: true });

const tplFile = path.join(root, 'private', 'schedule-template.v1.json');
const tpl = existsSync(tplFile)
  ? (() => { const d = JSON.parse(readFileSync(tplFile, 'utf8')); return { plans: d.plans, habits: d.habitList || d.habits || [] }; })()
  : null;

const PORT = 8799;
const server = spawn('python', ['-m', 'http.server', String(PORT), '--directory', 'site'], { cwd: root, stdio: 'ignore' });
const stop = () => { try { server.kill(); } catch {} };
process.on('exit', stop);

async function waitServer() {
  const net = await import('net');
  for (let i = 0; i < 60; i++) {
    const ok = await new Promise((resolve) => {
      const sock = net.connect(PORT, '127.0.0.1');
      sock.once('connect', () => { sock.destroy(); resolve(true); });
      sock.once('error', () => { sock.destroy(); resolve(false); });
    });
    if (ok) return;
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('local server did not start');
}

const VIEWPORTS = [
  { name: '375x812', width: 375, height: 812 },
  { name: '390x844', width: 390, height: 844 },
  { name: '430x932', width: 430, height: 932 },
];
const THEMES = ['dark', 'light'];
const TABS = [
  { id: 'today', open: async () => {} },
  { id: 'focus', open: async (p) => { await p.evaluate(() => { const t = itemList(ui.date).filter(isCheckable).find(x => !done(ui.date, x.id)); if (t) window.JarvisFocus.openForTaskId(t.id); }); }, close: async (p) => { await p.evaluate(() => window.JarvisFocus.quit()); }, only: '390x844' },
  { id: 'planner', open: async (p) => { await p.evaluate(() => { ui.tab = 'planner'; ui.showWeekOverview = true; render(); }); } },
  { id: 'ai', open: async (p) => { await p.evaluate(() => { ui.tab = 'ai'; render(); }); } },
  { id: 'more', open: async (p) => { await p.evaluate(() => { ui.tab = 'more'; render(); }); } },
];

async function runEngine(name, engine) {
  const browser = await engine.launch();
  const consoleErrors = [];
  const notes = [];
  for (const vp of VIEWPORTS) {
    for (const theme of THEMES) {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 2, isMobile: vp.width < 500, hasTouch: vp.width < 500 });
      const page = await ctx.newPage();
      page.on('pageerror', e => consoleErrors.push(`${name} ${vp.name} ${theme}: ${e.message}`));
      page.on('console', m => { if (m.type() === 'error' && !/favicon/i.test(m.text())) consoleErrors.push(`${name} ${vp.name} ${theme}: ${m.text().slice(0, 140)}`); });
      if (tpl) {
        await page.addInitScript(t => {
          try {
            if (!localStorage.getItem('jarvis_schedule_template_v1')) localStorage.setItem('jarvis_schedule_template_v1', JSON.stringify({ version: 1, savedAt: new Date().toISOString(), payload: t }));
            localStorage.setItem('jarvis_ui_theme', 'dark');
          } catch {}
        }, tpl);
      }
      await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
      await page.waitForSelector('#app');
      // Honest note: WebKit on Windows applies the OS DPI zoom, so the *painted*
      // area is narrower than the requested layout width and the right edge gets
      // cropped in PNGs. Geometry assertions still use the real layout viewport.
      const geo = await page.evaluate(() => ({ innerW: window.innerWidth, bodyW: Math.round(document.body.getBoundingClientRect().width) }));
      if (geo.bodyW > geo.innerW + 1 && !notes.some(n => n.startsWith(name))) {
        notes.push(`${name}: painted viewport ${geo.innerW}px vs layout ${geo.bodyW}px (DPI zoom) — PNG right edge is cropped by the environment; layout itself is ${geo.bodyW}px`);
      }
      // Optional fixed clock so the "current task" hero and timeline can be reviewed at any hour.
      const at = process.argv.find(a => a.startsWith('--at='));
      if (at) {
        const [hh, mm] = at.slice(5).split(':').map(Number);
        const fixed = new Date();
        fixed.setHours(hh, mm, 0, 0);
        await page.clock.setFixedTime(fixed);
        await page.evaluate(() => render());
        await page.waitForTimeout(200);
      }
      await page.evaluate((t) => { try { localStorage.setItem('jarvis_ui_theme', t); } catch {} document.documentElement.dataset.theme = t; }, theme);
      await page.waitForTimeout(350);
      for (const tab of TABS) {
        if (tab.only && tab.only !== vp.name) continue;
        await tab.open(page);
        await page.waitForTimeout(350);
        await page.screenshot({ path: path.join(outDir, `${name}-${vp.name}-${theme}-${tab.id}.png`), fullPage: false });
        const overflow = await page.evaluate(() => {
          // Robust metric on both engines: furthest right edge of any rendered element.
          let maxRight = 0;
          for (const el of document.querySelectorAll('body *')) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.right > maxRight) maxRight = r.right;
          }
          return { maxRight: Math.round(maxRight), innerW: window.innerWidth };
        });
        if (overflow.maxRight > vp.width + 1) consoleErrors.push(`OVERFLOW ${name} ${vp.name} ${theme} ${tab.id}: right=${overflow.maxRight} > ${vp.width}`);
        if (tab.close) await tab.close(page);
      }
      await ctx.close();
    }
  }
  await browser.close();
  return { consoleErrors, notes };
}

await waitServer();
const errors = [];
const notes = [];
try { const r = await runEngine('chromium', chromium); errors.push(...r.consoleErrors); notes.push(...r.notes); } catch (e) { errors.push('chromium engine failed: ' + e.message.split('\n')[0]); }
try { const r = await runEngine('webkit', webkit); errors.push(...r.consoleErrors); notes.push(...r.notes); } catch (e) { errors.push('webkit engine failed: ' + e.message.split('\n')[0]); }
stop();
console.log(`screenshots: ${outDir}`);
if (notes.length) console.log('NOTES:\n' + notes.join('\n'));
console.log(errors.length ? 'ISSUES:\n' + errors.join('\n') : 'no console errors, no horizontal overflow');