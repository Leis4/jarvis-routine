import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// 1. The public shell must NOT contain the personal schedule any more.
const html = readFileSync(join(root, 'site', 'index.html'), 'utf8');
const publicIds = html.match(/"id":"p\d/g);
const inlinePlans = /const PLANS=\[\[/.test(html);
console.log('1. public index.html schedule ids:', publicIds ? publicIds.length : 0, '| inline PLANS literal:', inlinePlans);
console.log(!publicIds && !inlinePlans ? '   OK no personal schedule in public HTML' : '   FAIL personal schedule still public');

// 2. The private template keeps every original block.
const templatePath = join(root, 'private', 'schedule-template.v1.json');
if (existsSync(templatePath)) {
  const raw = readFileSync(templatePath, 'utf8');
  const template = JSON.parse(raw);
  const count = template.plans.flat(2).length;
  console.log('2. private template blocks:', count, '| habits:', template.habitList.length);
  console.log(count === 392 ? '   OK 392 blocks preserved' : '   FAIL mismatch');
  const backups = existsSync(join(root, 'backups')) ? readdirSync(join(root, 'backups')).filter((f) => f.startsWith('schedule-template.v1.') && f.endsWith('.json')) : [];
  console.log('   private backups:', backups.length, '| sha256:', createHash('sha256').update(raw).digest('hex').slice(0, 16));
} else {
  console.log('2. FAIL private/schedule-template.v1.json missing — run node tools/privacy/extract-schedule.mjs');
}

// 3. No secrets in public sources (the token field placeholder is not a secret).
const secrets = ['QWEN_API_KEY', 'AITUNNEL_API_KEY', 'AI_TOKEN', 'AI_SECRET', 'sk-ant', 'sk-or'];
const secretValue = /(?:Bearer\s+[A-Za-z0-9_\-.]{24,}|[A-Za-z0-9_\-]{40,})/;
const sources = ['site/index.html', 'site/schedule-bootstrap.js', 'site/smart.js', 'site/ai.js', 'site/ai.css', 'site/service-worker.js'];
let allClean = true;
for (const src of sources) {
  const content = readFileSync(join(root, src), 'utf8');
  for (const s of secrets) {
    if (content.includes(s)) {
      console.log(`   FAIL secret "${s}" found in ${src}`);
      allClean = false;
    }
  }
  const match = content.match(secretValue);
  if (match) {
    console.log(`   FAIL hard-coded credential-like literal in ${src}: ${match[0].slice(0, 8)}…`);
    allClean = false;
  }
}
if (allClean) console.log('3. No secrets in public sources: OK');

// 4. .gitignore must protect private/ and backups/.
const gi = readFileSync(join(root, '.gitignore'), 'utf8');
console.log('4. .gitignore covers private/:', gi.includes('private/') ? 'OK' : 'FAIL',
  '| backups/:', gi.includes('backups/') ? 'OK' : 'FAIL');

// 5. Service worker cache version.
const sw = readFileSync(join(root, 'site', 'service-worker.js'), 'utf8');
const cacheMatch = sw.match(/CACHE='([^']+)'/);
if (cacheMatch) console.log('5. Service Worker cache:', cacheMatch[1], '| bootstrap precached:', sw.includes('schedule-bootstrap.js') ? 'OK' : 'FAIL');

// 6. Backend exposes the private template only behind auth.
const worker = readFileSync(join(root, 'backend', 'src', 'worker.js'), 'utf8');
const route = worker.indexOf("'/api/schedule-template'");
const gate = worker.indexOf('if(!await authorized(req,env))');
console.log('6. /api/schedule-template route:', route > 0 ? 'present' : 'MISSING',
  '| behind auth gate:', route > 0 && gate > 0 && route > gate ? 'OK' : 'FAIL');

console.log('\n--- CHECK COMPLETE ---');