'use strict';
process.env.TZ='Europe/Moscow';
const fs=require('fs'),vm=require('vm'),assert=require('assert'),path=require('path');
const root=path.resolve(__dirname,'..');
const raw=fs.readFileSync(path.join(root,'site/index.html'),'utf8');
const inline=raw.match(/<script>([\s\S]*?)<\/script>/i)?.[1];
assert(inline);
class ClockDate extends Date{constructor(...args){super(...(args.length?args:['2026-11-15T15:05:00Z']))}static now(){return +new Date('2026-11-15T15:05:00Z')}}
const storage=new Map(),listeners={},nodes=new Map();
function makeNode(id){
 if(!nodes.has(id))nodes.set(id,{id,innerHTML:'',textContent:'',dataset:{},classList:{add(){},remove(){},contains(){return false}},
 append(){},appendChild(){},remove(){},setAttribute(){},addEventListener(){},scrollIntoView(){},querySelector(){return null}});
 return nodes.get(id);
}
const document={body:makeNode('body'),documentElement:{dataset:{}},querySelector:makeNode,createElement:()=>({innerHTML:'',className:'',setAttribute(){},scrollIntoView(){},remove(){}}),
 addEventListener(type,fn,capture){(listeners[type]??=[]).push({fn,capture:!!capture})}};
const sandbox={Date:ClockDate,document,window:null,navigator:{},location:{protocol:'file:',origin:'null'},console,JSON,Math,Array,Object,Number,String,Boolean,Set,Map,RegExp,Promise,Intl,Error,TypeError,parseInt,parseFloat,isNaN,URL,URLSearchParams,
 localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,String(v))},
 setTimeout:()=>0,clearTimeout(){},setInterval:()=>0,clearInterval(){},confirm:()=>true,crypto:require('crypto').webcrypto,
 fetch(){throw Error('Unexpected network call')},
 FormData:class{constructor(form){this.form=form}entries(){return Object.entries(this.form.values)}}};
sandbox.window=sandbox;sandbox.window.addEventListener=()=>{};
const ctx=vm.createContext(sandbox);function run(code,name){return vm.runInContext(code,ctx,{filename:name||'test.js',timeout:10000})}
run(inline,'index.js');run(fs.readFileSync(path.join(root,'site/smart.js'),'utf8'),'smart.js');run(fs.readFileSync(path.join(root,'site/ai.js'),'utf8'),'ai.js');run(fs.readFileSync(path.join(root,'site/ux-fixes.js'),'utf8'),'ux-fixes.js');
const privateTemplate=require('./lib/private-schedule.cjs').install(run);
assert.equal(privateTemplate.count,392,'private template must still hold 392 blocks');
assert.equal(run('PLANS.flat(2).length'),392);
// This used to throw ReferenceError: catCounts is not defined.
run("ui.tab='more';ui.moreTab='stats';render()",'stats.js');
assert(makeNode('#app').innerHTML.includes('Память JARVIS'));
run("S.events.push(...Array.from({length:5},(_,i)=>({eid:'ev_test_'+i,type:'skip',category:'Код',date:today()})))",'fixture.js');
run("ui.tab='more';ui.moreTab='stats';render()",'stats-with-data.js');
assert(makeNode('#app').innerHTML.includes('Категория &quot;Код&quot;'), 'stats labels must be HTML-escaped');
console.log('OK stats renders; category summaries use scoped counters');
assert(run('todayView()').includes('обязательных'));
assert(run('todayView()').includes('Выполнено '));
assert(run('todayView()').includes('data-action="togglePast"'));
assert(run('plannerView()').includes('Покивань обзор недели'));
console.log('OK understandable counters and compact views');
const day=run('today()');
const overlaps=sandbox.jarvisTaskConflict.conflicts(day,'','12:00','12:40');
assert(overlaps.length>0,'Must detect the reported overlapping 12:00 task');
assert.equal(sandbox.jarvisTaskConflict.freeSlot(day,'','12:00','12:40'),null, 'Packed day must not invent free time');
const free=sandbox.jarvisTaskConflict.freeSlot(day,'','12:00','12:10');
assert(free,'Must find an available shorter interval');
assert.equal(sandbox.jarvisTaskConflict.conflicts(day,'',free.start,free.end).length,0);
console.log('OK overlap detection and safe alternative time');
function makeForm(name,start,end){const form={id:'taskform',dataset:{},getAttribute(name){return name==='id'?this.id:null},values:{id:'',name,start,end,cat:'Организация',status:'План',note:'',repeat:'once'},warning:null,
 get elements(){return {id:{value:this.values.id},start:{get value(){return form.values.start},set value(v){form.values.start=v}},end:{get value(){return form.values.end},set value(v){form.values.end=v}}}},
 querySelector(sel){return sel==='#taskConflictWarning'?this.warning:null},appendChild(node){this.warning=node;node.remove=()=>this.warning=null},requestSubmit(){dispatchSubmit(this)}};return form}
function dispatchSubmit(form){let stopped=false,prevented=false;const e={target:form,preventDefault(){prevented=true},stopImmediatePropagation(){stopped=true}};
 for(const {fn,capture} of listeners.submit.filter(x=>x.capture)) {fn(e);if(stopped)break}
 if(!stopped)for(const {fn} of listeners.submit.filter(x=>!x.capture)){fn(e)}
 return {stopped,prevented};}
let form=makeForm('Overlapping task','12:00','12:10');let before=run('S.extras.length');
let result=dispatchSubmit(form);assert(result.stopped&&result.prevented,'Overlapping save must be intercepted');
assert.equal(run('S.extras.length'),before,'No optimistic "saved" while overlap unresolved');
assert(form.warning?.innerHTML.includes('Время уже занято'));
console.log('OK conflicting submission is stopped before persistence');
const control={dataset:{uxConflict:'find'},closest(sel){return sel==='[data-ux-conflict]'?this:sel==='#taskform'?form:null}};
const click=({target:control,preventDefault(){},stopImmediatePropagation(){}});
for(const {fn,capture} of listeners.click.filter(x=>x.capture)){fn(click)}
assert.equal(run('S.extras.length'),before+1,'Explicit choice must save exactly once');
assert.equal(sandbox.jarvisTaskConflict.conflicts(day,'',form.values.start,form.values.end).length,1,'Expected saved task itself in results');
console.log('OK choosing a free time actually saves, without colliding with prior tasks');
console.log('ALL JARVIS 3.2 focused checks passed');
