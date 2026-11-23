'use strict';
process.env.TZ='Europe/Moscow';
const fs=require('fs'),vm=require('vm'),assert=require('assert');
const root=require('path').resolve(__dirname,'..'), original=fs.readFileSync(root+'/site/index.html','utf8');
const script=original.match(/<script>([\s\S]*?)<\/script>/i)?.[1];
assert(script,'inline script missing');
class ClockDate extends Date{constructor(...args){super(...(args.length?args:['2026-11-15T15:05:00Z']));}static now(){return +new Date('2026-11-15T15:05:00Z')}}
const db=new Map();
const elements=new Map();function elem(id){if(!elements.has(id))elements.set(id,{id,innerHTML:'',textContent:'',scrollTop:0,scrollHeight:500,classList:{add(){},remove(){},contains(){return false}},append(){},remove(){},setAttribute(){},addEventListener(){},querySelector(){return null}});return elements.get(id)}
const listeners={};const document={querySelector:selector=>elem(selector),addEventListener(type,fn){(listeners[type]??=[]).push(fn)},createElement:()=>elem(Math.random().toString()),body:elem('body')};
const sandbox={Date:ClockDate,document,window:null,navigator:{},location:{protocol:'file:',origin:'null'},console,JSON,Math,Array,Object,Number,String,Boolean,Set,Map,RegExp,Promise,Intl,Error,TypeError,parseInt,parseFloat,isNaN,crypto:require('crypto').webcrypto,
 localStorage:{getItem:k=>db.get(k)??null,setItem:(k,v)=>db.set(k,String(v)),removeItem:k=>db.delete(k)},
 setTimeout:()=>0,clearTimeout(){},setInterval:()=>0,clearInterval(){},confirm:()=>true,fetch(){throw Error('No network: any API request from local replan is forbidden')},
 URL,URLSearchParams};sandbox.window=sandbox;sandbox.window.addEventListener=()=>{};
const ctx=vm.createContext(sandbox);
function run(src,name){return vm.runInContext(src,ctx,{filename:name,timeout:15000})};
function check(name,code){let res;try{res=run(code,'check.js');assert(res);console.log('OK',name)}catch(e){console.error('FAIL',name,e.message);process.exitCode=1}}
run(script,'index_inline.js');run(fs.readFileSync(root+'/site/smart.js','utf8'),'smart.js');run(fs.readFileSync(root+'/site/ai.js','utf8'),'ai.js');
require('./lib/private-schedule.cjs').install(run);
check('globals loaded',"typeof window.buildSmartPlan==='function'&&typeof window.sendChat==='function'");
check('392 original tasks',"PLANS.flat(2).length===392");
run("S.wakeTimes[today()]='10:30';persist();",'setup.js');
const pure=run("(()=>{const s=today(),before=JSON.stringify(S);const plan=buildSmartPlan(s);return {pure:JSON.stringify(S)===before,plan:plan,day:s};})()",'preview.js');
assert(pure.pure,'preview modified state');console.log('OK preview is read-only');
assert.equal(pure.day,'2026-11-15');
check('no morning routines after lunch in preview',"(()=>{const p=buildSmartPlan(today());return !p.moved.some(t=>/завтрак|утренн|подъём/i.test(t.name)&&t.to>=13*60)})()");
// Local-first chat with no connected backend, no paid network.
run("ui.tab='ai';render();",'ui.js');
(async()=>{
 await run("sendChat('Я проснулся поздно. Перестрой остаток дня и перенеси необязательные дела.')",'ai_msg.js');
 check('replan works offline',"A?.history?.length>0".replace('A?.history','window.aiState?.history'));
 check('one truthful response',"window.aiState.history.length===2&&/Изменил расписание на сегодня/.test(window.aiState.history[1].content)");
 check('no morning activities rescheduled to evening',"itemList(today()).every(t=>!(/завтрак|утренн|подъём|ночные линзы/i.test(t.name)&&clock(t.start)>=13*60))");
 check('undo recorded',"!!S.planUndo[today()]");
 const snap=run("(()=>{const x=S.planUndo[today()];return JSON.stringify({adjust:x.adjust,pending:x.pending,extras:S.extras.filter(t=>!(x.addedTransfers||[]).some(a=>a.id===t.id))})})()",'undo_before.js');
 run("window.revertPlan(today())",'undo.js');
 const restored=run("JSON.stringify({adjust:S.dayAdjust[today()],pending:S.pending[today()],extras:S.extras})",'undo_after.js');
 assert.equal(restored,snap);console.log('OK full Undo restores dayAdjust/pending/extras');
 run('window.smartReplan(today(),{silent:true}); S.extras.push({id:"x_post_replan",fromDate:today(),repeat:"once",name:"User-created task",start:"21:40",end:"22:00",cat:"Организация",status:"План"}); window.revertPlan(today())','safe-undo.js');
 check('Undo does not delete tasks created after replanning',"S.extras.some(t=>t.id==='x_post_replan')");
 check('saved local chat',"localStorage.getItem('jarvis_routine_ai_history_local_v1')?.includes('Изменил расписание на сегодня')");
 // Natural free-form message must modify TODAY, even when a different day is selected.
 run("ui.date=shift(today(),1);ui.tab='ai';render()",'other-day.js');
 const storedDay=run("JSON.stringify(S.dayAdjust[today()]||{})",'pre_natural.js');
 await run("sendChat('Сегодня встал в 10:40, весь день смотрел сериал. Надо вечером быть продуктивным и успеть сделать полезные дела.')",'natural_ai.js');
 check('free-form late wake triggers real replan without API',"!!S.planUndo[today()]&&window.aiState.history.at(-1).content.includes('Изменил расписание на сегодня')");
 check('free-form late wake records reported wake on Sunday',"S.wakeTimes[today()]==='10:40'");
 check('UI selected tomorrow does not receive tomorrow replan',"!S.planUndo[shift(today(),1)]");
 check('AI chat contains actual upcoming agenda',"window.aiState.history.at(-1).content.includes('Ближайшие дела:')");
 check('AI chat exposes direct undo control',"window.aiView().includes('data-ai=\"undoPlan\"')");
 check('sleep and fixed events not moved',"itemList(today()).filter(t=>plannerIsFixed(t,today())).every(t=>{const b=baseItemList(today()).find(x=>x.id===t.id);return b&&b.start===t.start&&b.end===t.end})");
 run("window.revertPlan(today())",'undo_natural.js');
 check('undo restores reported wake',"S.wakeTimes[today()]==='10:30'");
 check('undo restores day state',"JSON.stringify(S.dayAdjust[today()]||{})==="+JSON.stringify(storedDay));

 // §8 mission scenario: the VM clock is Sunday 18:05 and the personal template
 // already holds the protected 19:00–21:30 event. "Make the evening productive"
 // must keep it, keep sleep, and stay repeatable.
 const fixedId=run("itemList(today()).find(t=>/Roblox/i.test(t.name))?.id||''",'fixed-id.js');
 assert(fixedId,'protected 19:00–21:30 event not found in the template');
 const fixedStart=run(`itemList(today()).find(t=>t.id===${JSON.stringify(fixedId)}).start`);
 const fixedEnd=run(`itemList(today()).find(t=>t.id===${JSON.stringify(fixedId)}).end`);
 assert.equal(fixedStart,'19:00'); assert.equal(fixedEnd,'21:30');
 await run("sendChat('Я сегодня поздно встал, теперь хочу продуктивный вечер')",'evening_1.js');
 check('§8 fixed 19:00–21:30 event unchanged',`(()=>{const t=itemList(today()).find(x=>x.id===${JSON.stringify(fixedId)});return !!t&&t.start==='19:00'&&t.end==='21:30'})()`);
 check('§8 bedtime block not shortened or moved',"itemList(today()).filter(t=>/засыпание|без экрана/i.test(t.name)).every(t=>t.start==='23:15')");
 check('§8 no morning routine lands in the evening',"itemList(today()).every(t=>!(/завтрак|утренн|подъём|гигиен/i.test(t.name)&&clock(t.start)>=13*60))");
 const overlaps = run(`JSON.stringify(itemList(today()).filter(t=>t.id!==${JSON.stringify(fixedId)}&&t.status!=='Буфер'&&!(clock(t.end)<=clock('19:00')||clock(t.start)>=clock('21:30'))).map(t=>[t.name,t.start,t.end,t.status,t.cat]))`, 'overlaps.js');
 try { assert.equal(overlaps, '[]'); console.log('OK §8 nothing overlaps the protected event'); } catch (e) { console.error('FAIL §8 nothing overlaps the protected event', overlaps); process.exitCode = 1; }
 const firstPass=run("JSON.stringify(S.extras.map(t=>[t.id,t.name,t.start,t.end]).sort())",'pass1.js');
 await run("sendChat('Я сегодня поздно встал, теперь хочу продуктивный вечер')",'evening_2.js');
 const secondPass=run("JSON.stringify(S.extras.map(t=>[t.id,t.name,t.start,t.end]).sort())",'pass2.js');
 try { assert.equal(secondPass, firstPass); console.log('OK §8 repeated request does not accumulate transfers'); } catch (e) { console.error('FAIL §8 repeated request does not accumulate transfers'); console.log('PASS1', firstPass); console.log('PASS2', secondPass); process.exitCode = 1; }
 check('§8 no duplicated blocks on the day',"(()=>{const seen=new Set();for(const t of itemList(today())){const k=t.name+'|'+t.start+'|'+t.end;if(seen.has(k))return false;seen.add(k)}return true})()");
 run("window.revertPlan(today())",'undo_evening.js');
 check('§8 undo keeps the protected event',`(()=>{const t=S.extras.find(x=>x.id===${JSON.stringify(fixedId)})||itemList(today()).find(x=>x.id===${JSON.stringify(fixedId)});return !t||(t.start==='19:00'&&t.end==='21:30')})()`);

 // Test AI confirmed actions through the captured real UI event handler.
 async function applyProposal(p){
   sandbox.aiState.proposals=[p];run('ui.tab="ai";render()','render.js');
   const button={dataset:{ai:'apply',index:'0'},closest:selector=>selector==='[data-ai]'?button:null};
   await Promise.all((listeners.click||[]).map(fn=>fn({target:button,preventDefault(){}})));
 }
 let id=run('itemList(today()).find(t=>t.status==="Обязательно"&&!done(today(),t.id)).id','first.js');
 await applyProposal({action:'complete',taskId:id,date:'2026-11-15'});
 check('AI complete is real even when UI has no checkbox',`S.done[today()]?.[${JSON.stringify(id)}]===true`);
 check('Action log records completed task',"window.aiState.actionLog.some(x=>x.type==='complete')");
 await applyProposal({action:'create_habit',name:'Test habit',mode:'daily'});
 check('AI create habit works without task date',"S.customHabits.some(x=>x.name==='Test habit')");
 // Delete suggestion is only applied after explicit click.
 run('S.extras.push({id:"x_temporary",fromDate:today(),repeat:"once",name:"Temporary",start:"20:40",end:"21:00",cat:"Организация",status:"План"})');
 await applyProposal({action:'delete',taskId:'x_temporary',date:'2026-11-15'});
 check('AI delete hides requested non-fixed task',"!itemList(today()).some(x=>x.id==='x_temporary')");
 // Creating/moving into an occupied interval is rejected like the manual form.
 await applyProposal({action:'add',date:'2026-11-15',start:'19:00',durationMin:30,title:'SHOULD_NOT_APPEAR',cat:'Организация'});
 check('AI add rejects overlap with existing fixed event',"!S.extras.some(t=>t.name==='SHOULD_NOT_APPEAR')");
 const movable=run("itemList(today()).find(t=>t.cat==='Код'&&!plannerIsFixed(t,today()))?.id",'movable.js');
 assert(movable,'expected a movable coding task');
 const beforeMove=run(`itemList(today()).find(t=>t.id===${JSON.stringify(movable)}).start`,'before_move.js');
 await applyProposal({action:'move',date:'2026-11-15',taskId:movable,start:'19:00'});
 const afterMove=run(`itemList(today()).find(t=>t.id===${JSON.stringify(movable)}).start`,'after_move.js');
 assert.equal(afterMove,beforeMove);
 console.log('OK AI move rejects overlap with protected event');

 console.log('ALL VM checks passed');
})().catch(e=>{console.error('VM FAIL:',e);process.exitCode=1})
