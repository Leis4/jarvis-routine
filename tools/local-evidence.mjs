#!/usr/bin/env node
// JARVIS local evidence tool: deterministic map + bounded read-only Ollama review.
// Never writes to the project, never calls cloud APIs, never walks private folders.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());
const [mode, relativePath, ...rest] = process.argv.slice(2);
const query = rest.join(' ').trim();
const allowedRoots = ['site', 'tests', 'tools'];
const badNames = /(^|[\\/])(?:private|backups|node_modules|\.git|\.wrangler)(?:[\\/]|$)|(^|[\\/])(?:\.env(?:\..*)?|\.dev\.vars|index\.html|opencode\.json|.*\.key|.*\.pem)$/i;

function die(message, code=1) { console.error('[LOCAL EVIDENCE] ' + message); process.exit(code); }
if (!['map','review'].includes(mode) || !relativePath) {
  die('Usage: node tools/local-evidence.mjs map|review site/flex.js [question]');
}
const normalized = relativePath.replace(/\\/g, '/');
if (!allowedRoots.some(prefix => normalized.startsWith(prefix + '/')) || badNames.test(normalized))
  die('Only non-sensitive source files under site/, tests/, tools/ (excluding index.html) are allowed.');
const real = path.resolve(root, normalized);
if (!real.startsWith(root + path.sep)) die('Path outside project.');
let fileReal;
try { fileReal=fs.realpathSync(real); } catch { die('File not found: ' + normalized); }
if (!fileReal.startsWith(root + path.sep)) die('Symlink outside project.');
if (!fs.statSync(fileReal).isFile()) die('Not a file.');
if (fs.statSync(fileReal).size > 300_000) die('File too large; use rg to narrow the search.');
const raw = fs.readFileSync(fileReal, 'utf8');
if (raw.includes('\0')) die('Binary file.');
const lines=raw.split(/\r?\n/);
if (lines.length>10000) die('Too many lines.');

const identifierPattern = /\b(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(|\b(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>|\b(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/;
const functions=[];
for (let i=0;i<lines.length;i++) {
  const line=lines[i];
  if (line.trim().startsWith('//') || line.trim().startsWith('*') || line.length>500) continue;
  const m=line.match(identifierPattern);
  if (m) functions.push({line:i+1,name:m[1]||m[2]||m[3]});
}
const unique=[...new Map(functions.map(f=>[`${f.name}:${f.line}`,f])).values()];

function referencingTests() {
  const dir=path.join(root,'tests'); if(!fs.existsSync(dir)) return [];
  const basename=path.basename(normalized).replace(/\.[^.]+$/,'');
  const found=[];
  function scan(d, depth) {
    if(depth>4 || found.length>=20) return;
    for(const e of fs.readdirSync(d,{withFileTypes:true})) {
      if(e.name==='node_modules' || e.name==='reports' || e.name==='test-results') continue;
      const p=path.join(d,e.name);
      if(e.isDirectory()) scan(p,depth+1);
      else if(/\.(?:js|cjs|mjs|ts|tsx)$/.test(e.name)) {
        try {
          if(fs.statSync(p).size>120000) continue;
          const content=fs.readFileSync(p,'utf8');
          if(e.name.includes(basename)||content.includes(`${basename}.js`)||content.includes(`/${basename}`))
            found.push(path.relative(root,p).replace(/\\/g,'/'));
        } catch {}
      }
      if(found.length>=20) break;
    }
  }
  scan(dir,0); return found;
}
if(mode==='map') {
  console.log(`[VERIFIED FILE] ${normalized} (${lines.length} lines)`);
  console.log(`[DECLARATION CANDIDATES] ${unique.length}; regex-based, may include methods and miss some forms.`);
  for(const f of unique.slice(0,100)) console.log(`L${f.line} ${f.name}`);
  if(unique.length>100) console.log(`... ${unique.length-100} further candidates omitted`);
  console.log('[RELATED TEST CANDIDATES]');
  const tests=referencingTests();
  if(tests.length) for(const t of tests) console.log('  '+t);
  else console.log('  none detected automatically; NOT proof tests are absent');
  process.exit(0);
}
if (!query) die('Review requires a focused question.');
if (query.length>400) die('Question too long.');

// Select source lines by overlap with query; add context. No semantic claims from this selection.
const terms=[...new Set((query.toLowerCase().match(/[\p{L}_$][\p{L}\p{N}_$]{2,}/gu)||[]).filter(x=>x.length>3))].slice(0,15);
const scores=lines.map((line,i)=>({i,score:terms.reduce((s,t)=>s+(line.toLowerCase().includes(t)?1:0),0)}));
const relevant=scores.filter(x=>x.score>0).sort((a,b)=>b.score-a.score||a.i-b.i).slice(0,12);
const selected=new Set();
for(const {i} of relevant) for(let n=Math.max(0,i-6);n<Math.min(lines.length,i+10);n++) selected.add(n);
if(selected.size===0) for(let i=0;i<Math.min(85,lines.length);i++) selected.add(i);
const sorted=[...selected].sort((a,b)=>a-b).slice(0,125);
let excerpt=sorted.map(i=>`L${i+1}: ${lines[i]}`).join('\n');
excerpt=excerpt.slice(0,11500);
const matchedLineNums=new Set(sorted.map(i=>i+1));

const model=process.env.JARVIS_LOCAL_REVIEW_MODEL || 'qwen2.5-coder:7b';
console.log(`[SOURCE] ${normalized}; total ${lines.length} lines; excerpt ${sorted.length} lines; local model ${model}`);
console.log('[NOTICE] Model receives only excerpts; findings are untrusted until independently verified.');
const controller=new AbortController(); const timeout=setTimeout(()=>controller.abort(),120000);
let response;
try {
  response=await fetch('http://127.0.0.1:11434/api/chat',{
    method:'POST', signal:controller.signal,
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
      model, stream:false, format:'json', keep_alive:'5m',
      options:{temperature:0,num_ctx:8192,num_predict:550},
      messages:[
        {role:'system',content:'You are a careful read-only code reviewer. Only analyze supplied numbered source excerpts. Never claim tools or files were opened. Do not invent source lines or function names. Output ONLY a JSON object {"findings":[{"line":number,"quote":"literal substring from that line","assessment":"short concern or explanation"}],"limitations":"short"}. Max 5 findings. If insufficient evidence use empty findings. Use same language as user. No markdown.'},
        {role:'user',content:`Source: ${normalized}\nQUESTION: ${query}\nVERIFIED EXCERPTS (only these lines):\n${excerpt}`}
      ]
    })
  });
} catch(e) {die('Ollama request failed: '+(e.name==='AbortError'?'timeout (120s)':e.message));}
finally {clearTimeout(timeout);}
if(!response.ok) die('Ollama HTTP '+response.status+' (local).');
let body; try {body=await response.json();} catch {die('Invalid Ollama JSON response.');}
const content=body?.message?.content;
if(!content || typeof content!=='string') die('Model returned no text.');
let parsed; try {parsed=JSON.parse(content);}catch {die('Model did not return valid structured JSON.');}
const findings=Array.isArray(parsed.findings)?parsed.findings:[];
let verified=0, rejected=0;
for(const f of findings.slice(0,8)) {
 const n=Number(f?.line), quote=typeof f?.quote==='string'?f.quote.trim():'';
 if(!Number.isInteger(n)||!matchedLineNums.has(n)||quote.length<5||quote.length>250||!lines[n-1]?.includes(quote)) {rejected++;continue;}
 const assessment=String(f?.assessment||'').replace(/[\r\n]+/g,' ').slice(0,300);
 console.log(`L${n}: ${quote.slice(0,160)}\n  LOCAL ASSESSMENT (not verified): ${assessment}`); verified++;
}
console.log(`[VERIFICATION] ${verified} claims cite exact provided source text; ${rejected} claims rejected. Interpretation still requires DeepSeek review.`);
console.log(`[LIMITATIONS] ${String(parsed.limitations||'Excerpt-only analysis').slice(0,300)}`);
console.log(`[LOCAL USAGE] prompt_eval_count=${body.prompt_eval_count??'n/a'} eval_count=${body.eval_count??'n/a'}; no paid API request.`);
