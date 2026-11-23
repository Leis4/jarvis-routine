'use strict';
process.env.TZ='Europe/Moscow';
const fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict'),path=require('path');
const root=path.resolve(__dirname,'..'),html=fs.readFileSync(root+'/site/index.html','utf8');
const inline=html.match(/<script>([\s\S]*?)<\/script>/i)?.[1];assert(inline);
class FixedDate extends Date {constructor(...args){super(...(args.length?args:['2026-11-15T18:44:00Z']));}static now(){return new Date('2026-11-15T18:44:00Z').valueOf()}}
const storage=new Map(),listeners={};
const el=()=>({innerHTML:'',textContent:'',scrollTop:0,scrollHeight:0,classList:{add(){},remove(){},contains(){return false}},addEventListener(){},setAttribute(){},append(){},remove(){},querySelector(){return null}});
const elements=new Map();
const document={querySelector(selector){if(!elements.has(selector))elements.set(selector,el());return elements.get(selector)},addEventListener(event,fn,options){(listeners[event]??=[]).push({fn,capture:options===true})},createElement:el,body:el()};
const sandbox={Date:FixedDate,document,window:null,navigator:{},location:{protocol:'file:',origin:'null'},console,JSON,Math,Array,Object,Number,String,Boolean,Set,Map,RegExp,Promise,Intl,Error,TypeError,parseInt,parseFloat,isNaN,crypto:require('crypto').webcrypto,
 localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,String(v)),removeItem:k=>storage.delete(k)},setTimeout:()=>0,clearTimeout(){},setInterval:()=>0,clearInterval(){},confirm:()=>true,fetch(){throw Error('Network request not expected')},URL,URLSearchParams};
sandbox.window=sandbox;sandbox.window.addEventListener=()=>{};
const ctx=vm.createContext(sandbox),run=(code,name='check.js')=>vm.runInContext(code,ctx,{filename:name,timeout:15000});
run(inline,'index_inline.js');for(const file of ['smart.js','ai.js','ux-fixes.js','calendar-nav.js'])run(fs.readFileSync(root+'/site/'+file,'utf8'),file);
const privateTemplate=require('./lib/private-schedule.cjs').install(run);
assert.equal(privateTemplate.count,392,'private template must still hold 392 blocks');
function test(name,code){assert(run(code),name);console.log('PASS',name)}
test('original tasks preserved','PLANS.flat(2).length===392');
test('auto odd 9–15 November 2026',"parity('2026-11-09')===0 && parity('2026-11-15')===0");
test('auto even 16–22 November 2026',"parity('2026-11-16')===1 && parity('2026-11-22')===1");
test('next odd 23–29 November 2026',"parity('2026-11-23')===0 && parity('2026-11-29')===0");
test('week parity runs into following year',"parity('2027-01-04') !== parity('2026-12-28')");
test('no forced week calibration',"chooseWeek()===''");
test('planner contains a native date picker and month calendar toggle',"plannerView().includes('data-jr-date-input') && plannerView().includes('data-jr-action=\"toggle\"')");
test('date strip displays selected week',"plannerView().includes('date-strip')");
test('settings allows automatic and manual override',"settingsView().includes('data-jr-action=\"auto\"') && settingsView().includes('data-jr-action=\"manual\"')");
function click(action,fields){const attrs=Object.assign({jrAction:action},fields),btn={dataset:attrs,closest(selector){return selector==='[data-jr-action]'?btn:null}};for(const x of listeners.click.filter(x=>x.capture))x.fn({target:btn});for(const x of listeners.click.filter(x=>!x.capture))x.fn({target:btn})}
click('date',{jrDate:'2027-02-03'});
test('jump to future date updates UI selected date and week',"ui.date==='2027-02-03' && ui.week===monday('2027-02-03')");
click('toggle');test('month picker shows 42 dates',"(plannerView().match(/class=\"jr-cal-cell/g)||[]).length===42");
click('month',{jrStep:'1'});test('month navigation forward',"ui.jrCalendarMonth==='2027-03'");
click('today');test('Today shortcut returns to actual calendar date',"ui.date==='2026-11-15'");
click('manual');test('manual mode can be enabled',"S.weekParityMode==='manual' && S.anchor.monday===monday(ui.date)");
click('set-week',{jrParity:'1'});test('manual override controls week cycle',"parity('2026-11-15')===1 && parity('2026-11-16')===0");
click('auto');test('returning to auto restores official reference cycle',"parity('2026-11-15')===0 && parity('2026-11-16')===1");
let tmp=run('JSON.stringify(S)');test('schedule and completion data remain untouched',`Object.keys(S.overrides).length===0 && S.extras.length===0 && Object.keys(S.done).length===0`);
assert(html.includes('calendar-nav.js?v=1')&&html.includes('calendar-nav.css?v=1'));
const sw=fs.readFileSync(root+'/site/service-worker.js','utf8');
const cacheVersion=Number(sw.match(/jarvis-routine-v(\d+)/)?.[1]);
assert(cacheVersion>=39,'Service Worker cache must not revert to an older release');
assert(sw.includes('./calendar-nav.js?v=1'),'Calendar module must stay in offline shell');
console.log('ALL JARVIS 3.4 calendar tests passed');
