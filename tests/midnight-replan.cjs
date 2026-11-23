'use strict';
// Midnight regression: calendar v3.4 uses local midnight, so planner must NOT
// carry the old 04:00 "logical yesterday" offset into today's available time.
process.env.TZ = 'Europe/Moscow';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const index=fs.readFileSync(path.join(root,'site/index.html'),'utf8');
const inline=index.match(/<script>([\s\S]*?)<\/script>/i)?.[1];assert.ok(inline);
const midnight=Date.parse('2026-11-16T21:30:00Z'); // Moscow 17 Nov 00:30
class FixedDate extends Date {constructor(...args){super(...(args.length?args:[midnight]))}static now(){return midnight}}
const store=new Map(),nodes=new Map();
function node(id){if(!nodes.has(id))nodes.set(id,{id,innerHTML:'',textContent:'',style:{},dataset:{},scrollTop:0,scrollHeight:500,classList:{add(){},remove(){},contains(){return false}},append(){},appendChild(){},remove(){},setAttribute(){},addEventListener(){},querySelector(){return null}});return nodes.get(id)}
const listeners={};
const document={querySelector:node,documentElement:{dataset:{}},addEventListener(type,fn){(listeners[type]??=[]).push(fn)},createElement:()=>node('create-'+nodes.size),body:node('body')};
const ctx={Date:FixedDate,document,localStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,String(v)),removeItem:k=>store.delete(k)},navigator:{},location:{protocol:'file:',origin:'null'},window:null,console,JSON,Math,Array,Object,Number,String,Boolean,Set,Map,RegExp,Promise,Intl,Error,TypeError,parseInt,parseFloat,isNaN,crypto:require('node:crypto').webcrypto,URL,URLSearchParams,setTimeout:()=>0,clearTimeout(){},setInterval:()=>0,clearInterval(){},confirm:()=>true,fetch(){throw Error('network forbidden')}};
ctx.window=ctx;ctx.window.addEventListener=()=>{};ctx.window.scrollTo=()=>{};
const context=vm.createContext(ctx);const run=(x,n)=>vm.runInContext(x,context,{filename:n||'test',timeout:20000});
run(inline,'index.js');run(fs.readFileSync(path.join(root,'site/smart.js'),'utf8'),'smart.js');
require('./lib/private-schedule.cjs').install(run);
run(fs.readFileSync(path.join(root,'site/calendar-nav.js'),'utf8'),'calendar-nav.js');
assert.equal(run('today()'),'2026-11-17');
assert.equal(run('ui.date'),'2026-11-17');
assert.equal(run("weekLabel(today())"),'ЧЁТНАЯ');
const state=run("(()=>{const s=today(),plan=buildSmartPlan(s);return {count:plan.count,placed:plan.placed,expired:plan.expired.length,skipped:plan.skipped.length,wake:wakeTime(s)};})()");
assert.ok(state.count>0,'must have flex tasks for regression');
assert.ok(state.placed>0,`midnight replan should be allowed to fill upcoming daytime, got ${JSON.stringify(state)}`);
console.log('PASS midnight date / academic parity / replan valid future slots');

// Actual registered UI click handlers: quick moves and swaps must respect fixed
// events BEFORE persistence, while postpone must be deduplicated and conflict-free.
run("ui.date='2026-11-15';ui.week=monday(ui.date);S.extras.push({id:'x_audit_shift',name:'Audit shift',start:'18:30',end:'18:50',fromDate:ui.date,repeat:'once',cat:'Код',status:'План'})");
function click(action,id,extras={}){
  const btn={dataset:{action,id,...extras},closest:(selector)=>selector==='[data-action]'?btn:null};
  for(const fn of listeners.click||[])fn({target:btn,preventDefault(){},stopPropagation(){}});
}
const moveBefore=run("JSON.stringify({a:S.dayAdjust[ui.date]||{},n:S.events.length})");
click('shiftTask','x_audit_shift',{min:'30'});
assert.equal(run("JSON.stringify({a:S.dayAdjust[ui.date]||{},n:S.events.length})"),moveBefore,'shift collision cannot persist');
console.log('PASS shift blocks overlap with protected 19:00 event');
run("S.extras.push({id:'x_audit_a',name:'Audit A',start:'17:00',end:'18:00',fromDate:ui.date,repeat:'once',cat:'Код',status:'План'},{id:'x_audit_b',name:'Audit B',start:'18:50',end:'19:00',fromDate:ui.date,repeat:'once',cat:'Код',status:'План'})");
const swapBefore=run("JSON.stringify({a:S.dayAdjust[ui.date]||{},n:S.events.length})");
click('swap','x_audit_a');click('swap','x_audit_b');
assert.equal(run("JSON.stringify({a:S.dayAdjust[ui.date]||{},n:S.events.length})"),swapBefore,'swap collision cannot persist');
console.log('PASS swap blocks overlap with protected 19:00 event');
run("S.extras.push({id:'x_audit_postpone',name:'Audit postponed',start:'11:30',end:'11:55',fromDate:ui.date,repeat:'once',cat:'Код',status:'План'})");
click('postponeTask','x_audit_postpone');
assert.equal(run("S.extras.filter(t=>t.transferSourceId==='x_audit_postpone').length"),1,'exactly one carryover');
const ok=run("(()=>{const next=shift(ui.date,1),x=S.extras.find(t=>t.transferSourceId==='x_audit_postpone');return itemList(next).filter(t=>t.id!==x.id&&t.status!=='Буфер'&&t.cat!=='Буфер').every(t=>clock(x.start)>=clock(t.end)||clock(x.end)<=clock(t.start))})()");
assert.ok(ok,'carryover never overlaps another task');
click('postponeTask','x_audit_postpone');
assert.equal(run("S.extras.filter(t=>t.transferSourceId==='x_audit_postpone').length"),1,'double click must not duplicate carryover');
console.log('PASS carryover finds a genuine free slot and rejects duplicates');
// Imported JSON is untrusted; a stale memory profile must render as text,
// not HTML that could execute with the stored APP_ACCESS_TOKEN in localStorage.
run('S.memory.profile.preferredPeriod="<img src=x onerror=alert(1)>";S.memory.profile.peakConfidence="<svg onload=alert(1)>"');
const memoryHtml=run('statsView()');
assert.ok(!memoryHtml.includes('<img src=x onerror=alert(1)>'),'memory profile HTML injection');
assert.ok(!memoryHtml.includes('<svg onload=alert(1)>'),'memory confidence HTML injection');
console.log('PASS imported profile strings escaped in stats UI');
assert.equal(run('validStateImport(S)'),true,'live state must remain importable');
assert.equal(run('validStateImport({done:{},extras:"not-an-array"})'),false,'reject corrupted extras');
assert.equal(run('validStateImport({done:[],extras:[]})'),false,'reject corrupt done map');
assert.equal(run('validStateImport({done:{},extras:[null]})'),false,'reject corrupt task records');
console.log('PASS imported user data validated before replacing persisted state');
