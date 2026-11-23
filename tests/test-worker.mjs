import {readFileSync} from 'node:fs';import {mkdtempSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {test} from 'node:test';import assert from 'node:assert/strict';
let s=readFileSync(new URL('../backend/src/worker.js',import.meta.url),'utf8').replace(/^import \{ buildPushPayload \}.*;\s*/m,'const buildPushPayload=async()=>({});\n');
const tmp=mkdtempSync(join(tmpdir(),'routine-worker-'));writeFileSync(join(tmp,'mock-worker.mjs'),s);
const {default:worker}=await import('file://'+join(tmp,'mock-worker.mjs'));
const env={APP_ACCESS_TOKEN:'test-bearer-token-with-over-24-chars',ALLOWED_ORIGIN:'https://example.github.io',DB:{}};
test('health works without credentials',async()=>{const r=await worker.fetch(new Request('https://service.workers.dev/api/health'),env);assert.equal(r.status,200);assert.equal((await r.json()).version,'3.0.0')});
test('unauthenticated database access denied',async()=>{const r=await worker.fetch(new Request('https://service.workers.dev/api/snapshot'),env);assert.equal(r.status,401)});
test('wrong origin denied',async()=>{const r=await worker.fetch(new Request('https://service.workers.dev/api/snapshot',{headers:{Origin:'https://evil.example',Authorization:'Bearer '+env.APP_ACCESS_TOKEN}}),env);assert.equal(r.status,403)});
test('AI requires server-side secret',async()=>{const r=await worker.fetch(new Request('https://service.workers.dev/api/ai/chat',{method:'POST',headers:{Origin:env.ALLOWED_ORIGIN,Authorization:'Bearer '+env.APP_ACCESS_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({message:'Привет'})}),env);assert.equal(r.status,503);assert.match((await r.json()).error,/AITUNNEL_API_KEY/)});
test('OPTIONS allows only designated origin',async()=>{const r=await worker.fetch(new Request('https://service.workers.dev/api/snapshot',{method:'OPTIONS',headers:{Origin:env.ALLOWED_ORIGIN}}),env);assert.equal(r.status,204);assert.equal(r.headers.get('Access-Control-Allow-Origin'),env.ALLOWED_ORIGIN)});

test('AITunnel: server sends direct model id, key stays in Worker and returns normalized chat', async()=>{
 const calls=[];
 const oldFetch=globalThis.fetch;
 globalThis.fetch=async (url,opts)=>{calls.push({url,opts});return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({answer:'Готово',proposals:[]})}}],usage:{prompt_tokens:12,completion_tokens:5}}),{status:200,headers:{'Content-Type':'application/json'}})};
 const DB={prepare(q){return {bind(...args){return {first:async()=> q.includes('request_usage')?{requests:0,max_calls:0}: {n:0}, all:async()=>({results:[]})}}}},batch:async()=>{}};
 try{
  const e={...env,DB,QWEN_BASE_URL:'https://api.aitunnel.ru/v1',AITUNNEL_API_KEY:'SECRET_ONLY_ON_SERVER'};
  const req=new Request('https://service.workers.dev/api/ai/chat',{method:'POST',headers:{Origin:e.ALLOWED_ORIGIN,Authorization:'Bearer '+e.APP_ACCESS_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({message:'Перепланируй',tier:'plus',date:'2026-11-15'})});
  const r=await worker.fetch(req,e);
  assert.equal(r.status,200,await r.clone().text());
  const out=await r.json();assert.equal(out.model,'qwen3.7-plus');
  assert.equal(calls[0].url,'https://api.aitunnel.ru/v1/chat/completions');
  const sent=JSON.parse(calls[0].opts.body);assert.equal(sent.model,'qwen3.7-plus');
  assert.equal(calls[0].opts.headers.Authorization,'Bearer SECRET_ONLY_ON_SERVER');
  assert.equal(JSON.stringify(out).includes('SECRET_ONLY_ON_SERVER'),false);
 }finally{globalThis.fetch=oldFetch}
});
