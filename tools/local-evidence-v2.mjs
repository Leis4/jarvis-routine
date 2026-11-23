#!/usr/bin/env node
// JARVIS local evidence v2. No dependencies, remote API, or source writes.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const ROOT = process.cwd();
const MAX_SIZE = 1_000_000;
const MAX_REVIEW_LINES = 100;
const MAX_REVIEW_CHARS = 12000;
const MODEL = 'qwen2.5-coder:7b';

function fail(msg, code = 2) { console.error(`[ERROR] ${msg}`); process.exit(code); }
function safeFile(arg) {
  if (!arg || typeof arg !== 'string') fail('Pass a JS file path.');
  const full = path.resolve(ROOT, arg);
  const relative = path.relative(ROOT, full).replace(/\\/g, '/');
  if (relative.startsWith('../') || relative === '..' || path.isAbsolute(relative)) fail('File must be in project.');
  if (/^(?:private|backups|node_modules|\.git)(?:\/|$)/i.test(relative) || /(?:^|\/)\.env(?:\.|$)/i.test(relative) || relative === 'site/index.html') fail('Sensitive/oversized source is blocked.');
  if (!/\.(?:m?js|cjs)$/i.test(relative)) fail('Only .js/.mjs/.cjs allowed.');
  const st = fs.statSync(full);
  if (!st.isFile() || st.size > MAX_SIZE) fail('File missing, not a regular file, or over 1 MB.');
  const canonicalRoot = fs.realpathSync(ROOT);
  const canonicalFile = fs.realpathSync(full);
  if (!canonicalFile.startsWith(canonicalRoot + path.sep)) fail('Symlink escapes project directory.');
  return { full, rel: relative, src: fs.readFileSync(full, 'utf8') };
}
const ident = '(?:[A-Za-z_$][\\w$]*)';
const forbidden = new Set(['if','for','while','catch','switch','with','function','return','try','else','do']);

function fallbackCandidates(src) {
  const found = [];
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m = line.match(/^\s*(?:(?:export|default)\s+)*(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/);
    let kind = 'function declaration';
    if (!m) { m = line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>)/); kind = 'assigned function'; }
    if (!m) { m = line.match(/^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*\{/); kind = 'method candidate'; }
    if (m && !forbidden.has(m[1])) found.push({ name: m[1], line: i+1, kind, start: lines.slice(0,i).reduce((a,s)=>a+s.length+1,0) });
  }
  return found;
}
function astCandidates(src) {
  let acorn;
  try { acorn = require('acorn'); } catch { return null; }
  let tree;
  try {
    tree = acorn.parse(src, {ecmaVersion:'latest', sourceType:'module', locations:true, allowHashBang:true});
  } catch {
    try { tree = acorn.parse(src, {ecmaVersion:'latest', sourceType:'script', locations:true, allowHashBang:true}); } catch { return null; }
  }
  const out = [];
  const push = (name, node, kind) => {
    if (name && node && !forbidden.has(name)) out.push({name, line:node.loc.start.line, kind, start:node.start, end:node.end});
  };
  const keyName = n => n?.type === 'Identifier' ? n.name : n?.type === 'Literal' ? String(n.value) : null;
  const walk = node => {
    if (!node || typeof node !== 'object' || !node.type) return;
    if (node.type === 'FunctionDeclaration') push(node.id?.name, node, 'function');
    if (node.type === 'VariableDeclarator' && ['ArrowFunctionExpression','FunctionExpression'].includes(node.init?.type)) push(keyName(node.id),node.init,'variable');
    if (node.type === 'MethodDefinition') push(keyName(node.key),node.value,'method');
    if (node.type === 'Property' && ['ArrowFunctionExpression','FunctionExpression'].includes(node.value?.type)) push(keyName(node.key),node.value,'property');
    if (node.type === 'AssignmentExpression' && ['ArrowFunctionExpression','FunctionExpression'].includes(node.right?.type)) push(keyName(node.left?.property)||keyName(node.left),node.right,'assignment');
    for (const [k,v] of Object.entries(node)) {
      if (k === 'loc' || k === 'start' || k === 'end') continue;
      if (Array.isArray(v)) {
        for (const part of v) if (part && typeof part === 'object') walk(part);
      } else if (v && typeof v === 'object' && v.type) {
        walk(v);
      }
    }
  };
  walk(tree);
  // Some bundled syntax may list the same node through different paths. De-duplicate.
  return [...new Map(out.map(x=>[`${x.name}:${x.line}:${x.kind}`,x])).values()].sort((a,b)=>a.line-b.line);
}
function candidates(src) {
  const parsed = astCandidates(src);
  return { mode: parsed ? 'Acorn AST' : 'bounded declaration regex (not full AST)', found: parsed ?? fallbackCandidates(src) };
}
function testsFor(rel, name) {
  const dir = path.resolve(ROOT,'tests');
  if (!fs.existsSync(dir)) return [];
  const tests = [];
  function walk(d, depth=0) {
    if(depth>3 || tests.length>15) return;
    for(const e of fs.readdirSync(d,{withFileTypes:true})) {
      if(e.isDirectory()) { if(!['node_modules','reports','test-results'].includes(e.name)) walk(path.join(d,e.name),depth+1); continue; }
      if(!/\.(?:spec\.(?:c|m)?js|test\.(?:c|m)?js|cjs)$/i.test(e.name)) continue;
      const full=path.join(d,e.name), st=fs.statSync(full);
      if(st.size>400000) continue;
      const txt=fs.readFileSync(full,'utf8');
      if(txt.includes(path.basename(rel)) || (name && txt.includes(name))) tests.push(path.relative(ROOT,full).replace(/\\/g,'/'));
    }
  }
  walk(dir);
  return tests.slice(0,15);
}
function map(file) {
  const {mode,found}=candidates(file.src);
  console.log(`[FILE] ${file.rel} (${file.src.split(/\r?\n/).length} lines)`);
  console.log(`[PARSER] ${mode}; ${found.length} named declaration candidates`);
  for(const f of found.slice(0,130)) console.log(`L${f.line}  ${f.name}  [${f.kind}]`);
  if(found.length>130) console.log(`[... ${found.length-130} omitted]`);
  console.log('[RELATED TEST CANDIDATES] '+(testsFor(file.rel).join(', ')||'none found'));
  if (!mode.includes('AST')) console.log('[LIMITATION] Regex fallback can miss declarations or include false positives; check lines in source.');
}
// Lightweight lexical brace matching for environments without Acorn.
// It is deliberately marked as a heuristic, not an AST parse.
function maskCommentsAndStrings(src) {
  const out = [...src];
  let i = 0;
  const mask = k => { if (out[k] !== '\n') out[k] = ' '; };
  while (i < src.length) {
    const c = src[i], next = src[i+1];
    if (c === '/' && next === '/') {
      mask(i++); mask(i++);
      while (i < src.length && src[i] !== '\n') mask(i++);
    } else if (c === '/' && next === '*') {
      mask(i++); mask(i++);
      while (i < src.length) {
        if (src[i] === '*' && src[i+1] === '/') { mask(i++); mask(i++); break; }
        mask(i++);
      }
    } else if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      mask(i++);
      while (i < src.length) {
        if (src[i] === '\\') { mask(i++); if (i<src.length) mask(i++); continue; }
        if (src[i] === quote) { mask(i++); break; }
        mask(i++);
      }
    } else i++;
  }
  return out.join('');
}
function heuristicFunctionEnd(src, firstLine) {
  let lineStart = 0;
  for(let n=1;n<firstLine;n++) {
    const p = src.indexOf('\n',lineStart);
    if(p<0) return null;
    lineStart=p+1;
  }
  const clean = maskCommentsAndStrings(src);
  const par = clean.indexOf('(',lineStart);
  const arrow = clean.indexOf('=>',lineStart);
  const nextLine = clean.indexOf('\n',lineStart);
  if (par < 0 || (nextLine>=0 && par>nextLine+180) || (arrow>=0 && arrow<par)) return null;
  let depth=0, after=-1;
  for(let i=par;i<clean.length;i++) {
    if(clean[i]==='(') depth++;
    if(clean[i]===')' && --depth===0) { after=i+1; break; }
    if(i>par+1000) return null;
  }
  if(after<0) return null;
  const brace=clean.indexOf('{',after);
  if(brace<0 || brace>after+150 || clean.slice(after,brace).includes(';')) return null;
  let b=0;
  for(let i=brace;i<clean.length;i++) {
    if(clean[i]==='{') b++;
    else if(clean[i]==='}' && --b===0) return src.slice(0,i+1).split('\n').length;
    if(i>brace+50000) return null;
  }
  return null;
}

function excerptFor(file, symbol) {
  const {mode,found}=candidates(file.src);
  const target=found.find(f=>f.name === symbol);
  if(!target) fail(`No named function candidate '${symbol}'. Run 'map' first.`);
  const lines=file.src.split(/\r?\n/);
  const start=target.line;
  let end;
  if (target.end !== undefined) {
    end=file.src.slice(0,target.end).split(/\r?\n/).length;
  } else {
    // For fallback matches, try lexical brace-matching before bounded excerpts.
    end=heuristicFunctionEnd(file.src,start) ?? Math.min(lines.length,start+24);
  }
  const count=end-start+1;
  const fragment=lines.slice(start-1,end).map((l,i)=>`L${start+i}: ${l}`).join('\n');
  if(count>MAX_REVIEW_LINES || fragment.length>MAX_REVIEW_CHARS) fail(`Function/excerpt too large (${count} lines). Use a smaller function or manual bounded evidence.`);
  return {target,mode,start,end,fragment,partial:!mode.includes('AST'),lines};
}
function show(file,symbol) {
  const x=excerptFor(file,symbol);
  console.log(`[FILE] ${file.rel}, ${symbol}, lines ${x.start}-${x.end}`);
  console.log(`[SOURCE MODE] ${x.mode}${x.partial?' — lexical span, not AST-verified':''}`);
  console.log(x.fragment);
}
async function review(file,symbol, dry=false) {
  const x=excerptFor(file,symbol);
  console.log(`[FILE] ${file.rel} :: ${symbol}; lines ${x.start}-${x.end}`);
  console.log(`[SOURCE] ${x.mode}${x.partial?' (lexically bounded excerpt, not AST-verified)':''}`);
  if (dry) { console.log(x.fragment); console.log('[DRY RUN] No model called.'); return; }
  const prompt = `Ты статический аналитик JavaScript. Тебе дан ТОЛЬКО цитированный исходный код. НЕЛЬЗЯ выдумывать другие файлы, зависимости, результаты тестов или ошибки.\nЗадача: кратко объяснить, что делает функция ${symbol}. Предположения о баге допустимы только если виден конкретный логический контрпример прямо в этом фрагменте; иначе risks=[]. Если отсутствует контекст, напиши об этом в missing_context.\nОтветь только JSON: {"summary":"...","risks":[{"line":123,"quote":"exact substring from that line","reason":"..."}],"missing_context":["..."]}. Не выдумывай line/quote. Максимум 2 риска.\nИсходник (строки ${x.start}-${x.end}, ${x.partial?'частичный фрагмент':'выделение функции'}):\n${x.fragment}`;
  let res;
  try {
    res=await fetch('http://127.0.0.1:11434/api/generate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:MODEL,prompt,stream:false,format:'json',keep_alive:'2m',options:{temperature:0.05,num_predict:300,num_ctx:8192}}),signal:AbortSignal.timeout(120000)});
  } catch(e) { fail('Local Ollama unavailable: '+e.message); }
  if(!res.ok) fail('Local Ollama HTTP '+res.status);
  const data=await res.json();
  let answer;
  try { answer=JSON.parse(data.response); } catch { fail('Local model did not return valid JSON; no claims accepted.'); }
  console.log('[LOCAL SUMMARY — NOT VERIFIED] '+String(answer.summary||'').slice(0,700));
  let accepted=0,rejected=0;
  for (const r of (Array.isArray(answer.risks)?answer.risks:[]).slice(0,2)) {
    const line=Number(r.line),quote=String(r.quote||'');
    if(Number.isInteger(line) && line>=x.start && line<=x.end && quote.length>=4 && x.lines[line-1].includes(quote)) {
      accepted++;
      console.log(`[CITED HYPOTHESIS; NOT A PROVEN BUG] L${line} ${quote.slice(0,180)} :: ${String(r.reason||'').slice(0,220)}`);
    } else { rejected++; console.log('[REJECTED] Risk has no exact quote in provided source.'); }
  }
  for (const c of (Array.isArray(answer.missing_context)?answer.missing_context:[]).slice(0,3)) console.log('[MISSING CONTEXT] '+String(c).slice(0,160));
  console.log(`[VERIFICATION] cited hypotheses ${accepted}; rejected ${rejected}. Source citations confirm text only, NOT correctness of conclusions.`);
  console.log(`[LOCAL TOKENS] prompt=${data.prompt_eval_count??'?'} output=${data.eval_count??'?'}; no paid API used.`);
}
function usage() { console.log('Usage: node tools/local-evidence-v2.mjs map <file.js> | show <file.js> <function> | review <file.js> <function> [--dry-run]'); }
const [cmd,arg,symbol,...opts]=process.argv.slice(2);
if (!['map','show','review'].includes(cmd) || !arg || ((cmd==='show'||cmd==='review')&&!symbol)) { usage(); process.exit(2); }
const file=safeFile(arg);
if(cmd==='map') map(file);
if(cmd==='show') show(file,symbol);
if(cmd==='review') await review(file,symbol,opts.includes('--dry-run'));
