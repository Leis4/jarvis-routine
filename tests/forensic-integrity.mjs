// Focused forensic regression: backend must implement atomic snapshot CAS and
// reject calendar-normalized invalid dates. No remote API or real data used.
import {readFileSync,writeFileSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import assert from 'node:assert/strict';
const src=readFileSync(new URL('../backend/src/worker.js',import.meta.url),'utf8')
 .replace(/^import \{ buildPushPayload \}.*;\s*/m,'const buildPushPayload=async()=>({});\n');
const moddir=mkdtempSync(join(tmpdir(),'jr-forensic-')); const modpath=join(moddir,'worker.mjs');
writeFileSync(modpath,src);const {default:worker}=await import('file://'+modpath);
const auth='test-safe-token-longer-than-24-chars';
function db(){
 let snap=null, remind=[];
 return {
 get snapshot(){return snap},get reminders(){return remind},
 prepare(sql){return {bind(...args){return {
   async first(){if(sql.includes('FROM snapshots'))return snap?{version:snap.version}:null;return null},
   async run(){
    if(sql.startsWith('INSERT OR IGNORE INTO snapshots')){
     if(snap)return {meta:{changes:0}};
     snap={version:1,payload:args[0],updated_at:args[1]};return {meta:{changes:1}};
    }
    if(sql.startsWith('UPDATE snapshots SET version=version+1')){
     if(!snap||snap.version!==args[2])return {meta:{changes:0}};
     snap={version:snap.version+1,payload:args[0],updated_at:args[1]};return {meta:{changes:1}};
    }
    throw Error('Unexpected query '+sql);
   }
 };}}},
 async batch(stmts){
  // Verify reminder deletion and insert are in the SAME database batch.
  assert.match(stmts[0].sql,/^DELETE FROM reminders/);
  for(const stmt of stmts.slice(1))assert.match(stmt.sql,/^INSERT INTO reminders/);
  remind=stmts.slice(1);
  return [];
 },
 }
}
function makeDB(){const base=db();const prepare=base.prepare.bind(base);base.prepare=(sql)=>{
 const stmt=prepare(sql);return {first:()=>stmt.bind().first(),bind(...args){const v=stmt.bind(...args);return {...v,sql,args}}};
 };return base}
const DB=makeDB();const env={APP_ACCESS_TOKEN:auth,ALLOWED_ORIGIN:'https://jarvis.example',DB};
function req(path,body){return new Request('https://api.example'+path,{method:'POST',headers:{Authorization:'Bearer '+auth,Origin:env.ALLOWED_ORIGIN,'Content-Type':'application/json'},body:JSON.stringify(body)})}
test('CAS: two clients at version zero cannot both overwrite snapshot',async()=>{
 const replies=await Promise.all([
  worker.fetch(req('/api/snapshot',{state:{owner:'one'},expectedVersion:0}),env),
  worker.fetch(req('/api/snapshot',{state:{owner:'two'},expectedVersion:0}),env)
 ]);
 assert.deepEqual(replies.map(r=>r.status).sort(),[200,409]);
 assert.equal(DB.snapshot.version,1);
 const first=JSON.parse(DB.snapshot.payload).owner;
 const fresh=await worker.fetch(req('/api/snapshot',{state:{owner:'three'},expectedVersion:1}),env);
 assert.equal(fresh.status,200);assert.equal(DB.snapshot.version,2);
 const stale=await worker.fetch(req('/api/snapshot',{state:{owner:'stale'},expectedVersion:1}),env);
 assert.equal(stale.status,409);assert.equal(JSON.parse(DB.snapshot.payload).owner,'three');
 assert.ok(first==='one'||first==='two');
});
test('Reject missing/invalid expectedVersion instead of coercing to zero',async()=>{
 for(const expectedVersion of [undefined,-1,1.5,'0']){
  const r=await worker.fetch(req('/api/snapshot',{state:{foo:'bar'},expectedVersion}),env);
  assert.equal(r.status,400);
 }
});
test('Reject invalid calendar dates rather than normalizing',async()=>{
 for(const day of ['2026-02-30','2026-11-31','2026-13-01','2025-02-29']){
  const r=await worker.fetch(req('/api/reminders',{day,items:[]}),env);
  assert.equal(r.status,400,day);
 }
});
test('Reminder replacement uses one atomic D1 batch',async()=>{
 const time=Date.now()+7200000;
 const r=await worker.fetch(req('/api/reminders',{day:'2026-11-16',items:[{taskId:'demo',title:'Demo',remindAt:time}]}),env);
 assert.equal(r.status,200,await r.clone().text());
 assert.equal((await r.json()).scheduled,1);
});
