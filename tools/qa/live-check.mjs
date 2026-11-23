/* Live UX check of the deployed PWA in real browsers (Chromium + WebKit).
   Does NOT seed any schedule: it verifies the shipped shell, the four tabs and the
   service worker exactly as a fresh visitor gets them. No personal data is uploaded.
   Usage: node tools/qa/live-check.mjs [baseUrl] */
import { chromium, webkit } from 'playwright';
import { mkdirSync } from 'fs';
import path from 'path';

const BASE = (process.argv[2] || 'https://jarvis-routine.demo.workers.dev').replace(/\/$/, '');
const outDir = path.join(process.cwd(), 'screenshots', 'qa', 'v42-live');
mkdirSync(outDir, { recursive: true });

const TABS = ['today', 'planner', 'ai', 'more'];
let failed = 0;
function check(label, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' :: ' + detail : ''}`);
}

async function run(name, engine) {
  const browser = await engine.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon/i.test(m.text())) errors.push(m.text().slice(0, 160)); });

  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  await page.waitForSelector('#app', { timeout: 15000 });
  await page.waitForTimeout(700);

  check(`[${name}] app shell boots`, await page.locator('#app').isVisible());
  check(`[${name}] no runtime errors`, errors.length === 0, errors.join(' | '));
  check(`[${name}] premium.css is applied`, await page.evaluate(() => [...document.styleSheets].some(s => (s.href || '').includes('premium.css'))));
  check(`[${name}] four primary tabs`, (await page.locator('#bottomnav .navbutton').count()) === 4);

  for (const tab of TABS) {
    await page.evaluate((tk) => { window.ui.tab = tk; render(); }, tab);
    await page.waitForTimeout(250);
    const visible = await page.locator('#app').isVisible();
    const text = (await page.locator('#app').innerText()).trim();
    check(`[${name}] ${tab} tab renders content`, visible && text.length > 20, `${text.length} chars`);
    if (tab === 'today' || tab === 'ai') {
      await page.screenshot({ path: path.join(outDir, `${name}-390x844-${tab}.png`) });
    }
  }

  const overflow = await page.evaluate(() => {
    let maxRight = 0;
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > maxRight) maxRight = r.right;
    }
    return { maxRight: Math.round(maxRight), layout: Math.round(document.body.getBoundingClientRect().width) };
  });
  check(`[${name}] no horizontal overflow`, overflow.maxRight <= overflow.layout + 1, `right=${overflow.maxRight} layout=${overflow.layout}`);

  const sw = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return { supported: false };
    const regs = await navigator.serviceWorker.getRegistrations();
    const res = await fetch('/service-worker.js').then(r => r.text()).catch(() => '');
    return { supported: true, count: regs.length, v42: /jarvis-routine-v42/.test(res) };
  });
  check(`[${name}] service worker registers`, sw.supported && sw.count > 0, JSON.stringify(sw));
  check(`[${name}] service worker ships v42 cache`, sw.v42 === true);

  const fresh = await page.evaluate(() => !localStorage.getItem('jarvis_schedule_template_v1'));
  check(`[${name}] fresh visitor sees no seeded private template`, fresh);

  await browser.close();
}

try { await run('chromium', chromium); } catch (e) { failed++; console.log('FAIL  chromium engine :: ' + e.message.split('\n')[0]); }
try { await run('webkit', webkit); } catch (e) { failed++; console.log('FAIL  webkit engine :: ' + e.message.split('\n')[0]); }

console.log(failed ? `\n${failed} live check(s) failed` : '\nALL LIVE CHECKS PASSED');
process.exit(failed ? 1 : 0);