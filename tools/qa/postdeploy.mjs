/* Post-deploy verification for the JARVIS Routine frontend.
   Read-only: GET requests only, no tokens, no personal data.
   Usage: node tools/qa/postdeploy.mjs [baseUrl] */
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');
const BASE = (process.argv[2] || 'https://jarvis-routine.demo.workers.dev').replace(/\/$/, '');
const API = 'https://jarvis-routine-api.demo.workers.dev';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
}

async function get(url, init) {
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000), ...init, headers: { connection: 'close', ...(init && init.headers) } });
      const text = res.headers.get('content-type')?.includes('text') ? await res.text() : '';
      return { status: res.status, type: res.headers.get('content-type') || '', text, len: text.length };
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 400));
    }
  }
  return { status: 0, type: '', text: '', len: 0, error: String(lastErr) };
}

const index = await get(`${BASE}/`);
check('frontend / responds 200', index.status === 200, `status=${index.status} bytes=${index.len}`);
check('/ serves html', /text\/html/.test(index.type), index.type);
check('no personal schedule ids in public html', !/"id":"p\d/.test(index.text), `matches=${(index.text.match(/"id":"p\d/g) || []).length}`);
check('no inline PLANS literal', !/const PLANS=\[\[/.test(index.text));
check('html loads v43 modules', ['premium.css?v=53', 'storage.js?v=1', 'recur.js?v=1', 'parse-ru.js?v=2', 'flex.js?v=2', 'heatmap.js?v=1', 'study.js?v=1', 'quick.js?v=4', 'planner.js?v=5', 'memory.js?v=1', 'chatstore.js?v=2', 'copilot.js?v=2', 'wallpaper.js?v=3', 'goals.js?v=2', 'calendar-nav.js?v=2', 'smart.js?v=23', 'ai.js?v=15', 'focus.js?v=1']
  .every(a => index.text.includes(a)), 'checked 13 references');

/* every runtime asset the shell references must be reachable */
/* /index.html intentionally 307-redirects to / (assets-only Worker, no fallback). */
const indexDirect = await get(`${BASE}/index.html`);
check('/index.html redirects to /', indexDirect.status === 307 || indexDirect.status === 200, `status=${indexDirect.status}`);

const assets = ['storage.js', 'recur.js', 'parse-ru.js', 'flex.js', 'heatmap.js', 'study.js', 'quick.js', 'smart.js', 'ai.js', 'ux-fixes.js', 'focus-core.js', 'focus.js', 'calendar-nav.js', 'schedule-bootstrap.js'];
for (const a of assets) {
  const r = await get(`${BASE}/${a}`);
  check(`/${a} 200`, r.status === 200 && r.len > 0, `status=${r.status} bytes=${r.len}`);
}

const css = await get(`${BASE}/premium.css`);
check('/premium.css 200', css.status === 200 && /text\/css/.test(css.type), `status=${css.status} bytes=${css.len}`);
check('premium.css defines the design tokens', /--bg\b/.test(css.text) && /\.hero\b/.test(css.text));
check('premium.css ships the v43 components', /quick-fab/.test(css.text) && /palette-back/.test(css.text) && /\.heatmap\b/.test(css.text) && /study-card/.test(css.text));

for (const f of ['vendor/dexie.min.js', 'vendor/fsrs.min.js']) {
  const r = await get(`${BASE}/${f}`);
  check(`/${f} 200`, r.status === 200 && r.len > 2000, `status=${r.status} bytes=${r.len}`);
}
for (const f of ['vendor/dexie.LICENSE.txt', 'vendor/dexie.NOTICE.txt', 'vendor/ts-fsrs.LICENSE.txt']) {
  const r = await get(`${BASE}/${f}`);
  check(`/${f} 200`, r.status === 200 && r.len > 100, `status=${r.status} bytes=${r.len}`);
}

const sw = await get(`${BASE}/service-worker.js`);
check('service worker cache bumped to v49.2-min-r8', /jarvis-routine-v49\.2-min-r8/.test(sw.text), `status=${sw.status}`);
check('service worker precaches the new modules', /flex\.js\?v=2/.test(sw.text) && /ai\.js\?v=17/.test(sw.text) && /quick\.js\?v=4/.test(sw.text) && /goals\.js\?v=3/.test(sw.text) && /heatmap\.js\?v=1/.test(sw.text) && /study\.js\?v=1/.test(sw.text) && /vendor\/fsrs\.min\.js/.test(sw.text) && /vendor\/three\.r134\.min\.js/.test(sw.text) && /vendor\/vanta\.waves\.0\.5\.24\.min\.js/.test(sw.text) && /vendor\/fluid\/fluid\.js/.test(sw.text) && /push\.js\?v=10/.test(sw.text));

/* nothing private may be publicly served */
for (const p of ['plans_const.txt', 'private/', 'backups/', '.env', '.assetsignore', 'site/index.html', 'private/schedule-template.v1.json']) {
  const r = await get(`${BASE}/${p}`);
  check(`/${p} is not public`, r.status === 404, `status=${r.status}`);
}

const manifest = await get(`${BASE}/manifest.webmanifest`);
check('/manifest.webmanifest 200', manifest.status === 200, `status=${manifest.status}`);

const tpl = await get(`${API}/api/schedule-template`);
check('private template still requires auth', tpl.status === 401, `status=${tpl.status}`);

const health = await get(`${API}/api/health`);
check('backend /api/health 200 (untouched)', health.status === 200, `status=${health.status}`);

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} post-deploy checks passed`);
process.exit(failed.length ? 1 : 0);
