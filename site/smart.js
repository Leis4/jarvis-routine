/* JARVIS Routine 2.0 — local-first planner enhancements.
   Original scheduler and personal plan are in index.html; this file extends it.
   Recommendations use a transparent Bayesian contextual bandit with explicit evidence counts.
   No external API calls, trackers, or cloud sync. */
(() => {
'use strict';
const VERSION='2.0';
if(!S.dayAdjust)S.dayAdjust={};
if(!S.planUndo)S.planUndo={};
if(!S.pending)S.pending={};
if(!S.events)S.events=[];
if(!S.customHabits)S.customHabits=[];
if(!S.shampooDays)S.shampooDays=[1,5];
if(!S.reminders)S.reminders={enabled:false,minutes:10,importance:'important',last:{}};
if(!S.focusLogs)S.focusLogs=[];
if(!S.learning)S.learning={enabled:true};
const rawBaseItemList=baseItemList;
const rawTodayView=todayView, rawHabitsView=habitsView, rawStatsView=statsView;
const rawTaskHTML=taskRowHTML,rawSettingsView=settingsView,rawHeader=appHeader;
const rawProgress=progress;
const dayStamp=()=>new Date().toISOString();
const clamp=(v,min,max)=>Math.min(max,Math.max(min,v));
const dDiff=(a,b)=>Math.round((parse(a)-parse(b))/86400000);
const duration=(t)=>Math.max(5,clock(t.end)-clock(t.start));
const isBedtime=t=>/(отбой|сон|спать|подготовк.*сн)/i.test(t.name)&&clock(t.start)>=21*60;
const isOptionalClass=t=>t.cat==='Университет'&&!/(мат\.?\s*анализ|теор\.?\s*вероят|проектн|управлени[ея] данными|баз[ыа] данн)/i.test(t.name)&&(/лекци|алгоритмиз|разработк|право|операц/i.test(t.name));
const isFixed=(t,s)=>{
  // Never silently move sleep/bedtime, including Friday and Saturday.
  if(isBedtime(t))return true;
  return anchorTask(t,s)||/^(Университет|Спорт|Зал|Семья|Сон|Дорога)$/.test(t.cat)||!!t.fixed;
};
const datekey=(s,id)=>`${s}::${id}`;
const recentTime=()=>niceTime(new Date().getHours()*60+new Date().getMinutes());
let swapFirst=null;
let openTaskControls=false;
let suppressSwapClickUntil=0;
let chartDays=14;

// Keep the previous import format and add arbitrary N-day repeats without modifying the original plans.
baseItemList=function(s){
  const arr=rawBaseItemList(s);
  // Interval / weekday / parity series get a genuinely free slot for every occurrence
  // instead of copying the original time. Fixed-time series (daily/weekly/biweekly) keep
  // the time the user chose. Expansion stays lazy: no instances are stored.
  const reflow=t=>!t.fixedTime&&!!t.fromDate&&(t.repeat==='everyN'||/^every\d+$/.test(t.repeat||'')||t.repeat==='weekdays'||t.repeat==='parity');
  const placed=[];
  const out=arr.map(t=>{
    if(!reflow(t))return t;
    const busy=arr.filter(x=>x.id!==t.id&&(isFixed(x,s)||x.status==='Обязательно')).map(x=>({start:clock(x.start),end:clock(x.end)})).concat(placed);
    const chosen=proposeSlot(s,{...t},busy,{first:Math.max(minutesHM(wakeTime(s)),9*60),last:Math.min(timeWindow(s).end,20*60)});
    if(!chosen)return t;
    placed.push({start:chosen.start,end:chosen.end});
    return {...t,start:niceTime(chosen.start),end:niceTime(chosen.end)};
  });
  return out.sort((a,b)=>clock(a.start)-clock(b.start));
};

// Day-specific times take precedence; changes to one Sunday do not damage other Sundays.
itemList=function(s){
  const adjustments=S.dayAdjust[s]||{};
  const delta=flexibleWake(s)?minutesHM(wakeTime(s))-minutesHM(baseWake(s)):0;
  return baseItemList(s).flatMap(t=>{
    const adjusted=adjustments[t.id];if(adjusted?.omit)return [];
    if(adjusted)return [{...t,...adjusted}];
    if(!delta||isFixed(t,s))return [t];
    // When wake changed, move only the early morning blocks pending explicit smart replan.
    const morning=clock(t.start)<12*60;
    if(!morning)return [t];
    let start=clock(t.start)+delta,end=clock(t.end)+delta;
    return [{...t,start:niceTime(start),end:niceTime(end),wakeShifted:true}];
  }).sort((a,b)=>clock(a.start)-clock(b.start));
};

function logEvent(type,s,t,extra={}){
  const ev={eid:'ev_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,8),type,at:dayStamp(),date:s,taskId:t?.id||'',title:t?.name||'',category:t?.cat||'',plannedStart:t?.start||'',wake:wakeTime(s),...extra};
  S.events.push(ev);if(S.events.length>18000)S.events=S.events.slice(-18000);
  persist();indexedWrite(ev);return ev;
}
const indexedDBName='jarvis_routine_structured_v2';
let dbp=null;
function dbHandle(){
  if(!('indexedDB' in window))return Promise.resolve(null);
  if(dbp)return dbp;
  dbp=new Promise(resolve=>{
    try{let req=indexedDB.open(indexedDBName,1);
      req.onupgradeneeded=()=>{let db=req.result; if(!db.objectStoreNames.contains('events'))db.createObjectStore('events',{keyPath:'eid'});};
      req.onsuccess=()=>resolve(req.result);req.onerror=()=>resolve(null);
    }catch(e){resolve(null)}
  });return dbp;
}
async function indexedWrite(ev){try{let db=await dbHandle();if(!db)return;db.transaction('events','readwrite').objectStore('events').put(ev)}catch(e){/* JSON backup remains authoritative */}}
// One-time mirror for v2 events, also useful after recovering a JSON backup.
function mirrorEvents(){dbHandle().then(db=>{if(!db)return;try{const store=db.transaction('events','readwrite').objectStore('events');for(const e of S.events.slice(-5000))store.put(e)}catch(err){}})}

function conflictsFor(t,s,items=itemList(s)){
  let st=clock(t.start),en=clock(t.end);
  return items.filter(q=>q.id!==t.id&&isFixed(q,s)&&st<clock(q.end)&&en>clock(q.start));
}
function moveTask(s,id,offset){
  const items=itemList(s),t=items.find(x=>x.id===id);if(!t)return;
  if(isFixed(t,s)){toast('Это закреплённый блок. Измени его через редактор, если действительно нужно.');return;}
  let next=clock(t.start)+offset;if(next<minutesHM(wakeTime(s))-5||next+duration(t)>24*60+45){toast('Время выходит за допустимые границы дня');return;}
  let moved={...t,start:niceTime(next),end:niceTime(next+duration(t))};
  const cl=conflictsFor(moved,s);
  // A 15-minute nudge must never write an overlap with a protected event.
  // Previously the conflict was detected only AFTER the new time was persisted.
  if(cl.length){toast('Нельзя перенести: пересечение с фиксированным делом');return;}
  (S.dayAdjust[s]||={})[id]={start:moved.start,end:moved.end};
  logEvent('move',s,t,{newStart:moved.start});
  toast('Время изменено');render();
}
function swapTasks(s,aId,bId){
  let ts=itemList(s),a=ts.find(x=>x.id===aId),b=ts.find(x=>x.id===bId);
  if(!a||!b)return;if(isFixed(a,s)||isFixed(b,s)){toast('Фиксированные дела местами не меняются');return;}
  const pa=clock(a.start),pb=clock(b.start),da=duration(a),db=duration(b);
  let nextA={start:niceTime(pb),end:niceTime(pb+da)},nextB={start:niceTime(pa),end:niceTime(pa+db)};
  if(conflictsFor({...a,...nextA},s).length||conflictsFor({...b,...nextB},s).length){
    swapFirst=null;toast('Обмен пересекается с фиксированным событием');return;
  }
  (S.dayAdjust[s]||={})[aId]=nextA;S.dayAdjust[s][bId]=nextB;
  logEvent('swap',s,a,{otherId:bId});swapFirst=null;render();toast('Поменял дела местами');
}
function postponeTask(s,id){
 let t=itemList(s).find(t=>t.id===id)||baseItemList(s).find(t=>t.id===id);if(!t||isFixed(t,s)){toast('Не могу перенести фиксированное событие');return}
 // A double-tap/stale button must not create two copies of the same task.
 if(S.extras.some(x=>x.transferSourceId===id&&x.transferSourceDate===s)){
   toast('Это дело уже перенесено на другой день');return;
 }
 const tomorrow=shift(s,1),win=timeWindow(tomorrow);
 const busy=itemList(tomorrow).filter(x=>x.status!=='Буфер'&&x.cat!=='Буфер')
   .map(x=>({start:clock(x.start),end:clock(x.end)}));
 // Reserve a *real* free slot before hiding the source. Never write overlapping
 // transfers to tomorrow at the original clock time.
 const opts={first:Math.max(win.start,8*60,clock(t.start)),last:Math.min(win.end,23*60+30)};
 let slot=proposeSlot(tomorrow,t,busy,opts);
 if(!slot)slot=proposeSlot(tomorrow,t,busy,{first:Math.max(win.start,8*60),last:opts.last});
 if(!slot){toast('На завтра не найдено свободного окна. Выбери день вручную.');return;}
 const newId='x_'+Date.now().toString(36)+Math.random().toString(36).slice(2,7);
 (S.dayAdjust[s]||={})[id]={omit:true};
 S.extras.push({...t,id:newId,transferSourceId:id,transferSourceDate:s,
   fromDate:tomorrow,repeat:'once',start:niceTime(slot.start),end:niceTime(slot.end),
   note:(t.note||'')+' · Перенесено с '+s});
 logEvent('postpone',s,t,{nextDate:tomorrow,newStart:niceTime(slot.start)});
 render();toast('Перенесено на завтра: '+niceTime(slot.start)+'–'+niceTime(slot.end));
}

function eventCount(){return S.events.filter(e=>['complete','skip'].includes(e.type)).length}
function hoursGroup(mins){return mins<12*60?'утро':mins<18*60?'день':'вечер'}
function wakeGroup(s){let d=minutesHM(wakeTime(s))-minutesHM(baseWake(s));return d>=80?'поздно':d<=-30?'рано':'обычно'}
function predict(t,s,start){
  let hour=hoursGroup(start),wb=wakeGroup(s),total=0,positive=0,clockObs=0,observedMinutes=[];
  const relevant=S.events.filter(ev=>['complete','skip'].includes(ev.type)&&ev.category===t.cat);
  for(let ev of relevant){
    let evMinute=ev.actualStart?minutesHM(ev.actualStart):minutesHM(ev.plannedStart||'12:00');
    const matchHour=hoursGroup(evMinute)===hour,evDelta=ev.wake?(minutesHM(ev.wake)-minutesHM(baseWake(ev.date||s))):0,evWake=evDelta>=80?'поздно':evDelta<=-30?'рано':'обычно',matchWake=!!ev.wake&&evWake===wb;
    let weight=(matchHour?1:0.22)*(matchWake?1:0.75);
    total+=weight;
    if(ev.type==='complete')positive+=weight;
    if(matchHour)clockObs++;
    if(ev.actualDuration&&ev.actualDuration>0&&ev.actualDuration<360)observedMinutes.push(ev.actualDuration);
  }
  let prior=t.cat==='Код'?(hour==='вечер'?0.70:hour==='утро'?0.52:0.60):t.cat==='Математика'?(hour==='утро'?0.67:0.62):0.64;
  let probability=(3*prior+positive)/(3+total);
  let learned=relevant.length>=6;
  let expectedDuration=observedMinutes.length>=3?Math.round(observedMinutes.reduce((a,b)=>a+b,0)/observedMinutes.length):duration(t);
  return {probability,observations:relevant.length,learned,expectedDuration};
}

function timeWindow(s){return {start:minutesHM(wakeTime(s)),end:indexDay(s)===4||indexDay(s)===5?25*60+30:23*60+15}}
function classifyPriority(t){
 let x= t.priority?Number(t.priority): t.status==='Обязательно'?4:t.status==='План'?3:t.status==='Гибко'?2:1;
 if(/(подъём|душ|зубы|завтрак|ужин|уход|линзы)/i.test(t.name))x+=1;
 if(t.deadlineDate){const until=dDiff(t.deadlineDate,ui.date);if(until<=2)x+=3;else if(until<=7)x+=1;}
 return x;
}
const slotsIntersect=(a,b)=>a.start<b.end&&a.end>b.start;
function placementScore(t,s,start,ideal){
 let pred=predict(t,s,start);
 // A compact contextual bandit: success estimate + time proximity, no fabricated training data.
 return (Math.abs(start-ideal)/60)*0.85 + (1-pred.probability)*110/60 +(start>=21*60?0.7:0)+(t.cat==='Код'&&start<9*60?0.6:0);
}
function proposeSlot(s,t,occupied,options={}){
 const len=clamp(duration(t),5,300),window=timeWindow(s);
 let first=options.first??Math.max(window.start,8*60),last=options.last??window.end;
 first=Math.max(first,window.start);
 if(last-first<len)return null;
 const ideal=Math.max(first,clock(t.start)+(options.wakeDelta||0));
 let best=null;
 for(let st=Math.ceil(first/5)*5;st+len<=last;st+=5){
   let interval={start:st,end:st+len};
   if(occupied.some(o=>slotsIntersect(o,interval)))continue;
   let score=placementScore(t,s,st,ideal);
   if(!best||score<best.score)best={...interval,score};
 }
 return best;
}
/* ── Personal Memory & Analytics ── */
if(!S.memory)S.memory={profile:{}, observations:[], version:1};
const MEM = S.memory;

function recordObservation(cat, value, weight=1){
  const existing=MEM.observations.find(o=>o.cat===cat);
  if(existing){
    // Moving average with weight decay
    existing.value=Math.round((existing.value*existing.weight + value*weight)/(existing.weight+weight)*10)/10;
    existing.weight=Math.min(existing.weight+weight, 50);
    existing.updated=today();
    existing.count=(existing.count||1)+1;
  } else {
    MEM.observations.push({cat, value:Math.round(value*10)/10, weight:Math.min(weight,10), count:1, updated:today()});
  }
}
function getObservation(cat){ const o=MEM.observations.find(o=>o.cat===cat); return o?o.value:null; }

function refreshMemory(){
  const ev=S.events.filter(e=>['complete','skip'].includes(e.type));
  const doneE=ev.filter(e=>e.type==='complete'), skipE=ev.filter(e=>e.type==='skip');
  
  // Completion rate by category
  const catCounts={}; for(const e of ev){ catCounts[e.category]||={t:0,c:0}; catCounts[e.category].t++; if(e.type==='complete')catCounts[e.category].c++; }
  for(const [cat,ct] of Object.entries(catCounts)){
    if(ct.t>=3) recordObservation('cat_complete_'+cat, ct.c/ct.t, ct.t);
  }
  
  // Preferred time of day
  const hours=doneE.map(e=>minutesHM(e.actualStart||e.plannedStart||'12:00'));
  if(hours.length>=3){
    const avgHour=hours.reduce((a,b)=>a+b,0)/hours.length;
    recordObservation('preferred_hour', avgHour/60, hours.length);
    const morning=hours.filter(h=>h<12*60).length;
    const afternoon=hours.filter(h=>h>=12*60&&h<18*60).length;
    const evening=hours.filter(h=>h>=18*60).length;
    const peak=morning>=afternoon&&morning>=evening?'утро':afternoon>=evening?'день':'вечер';
    MEM.profile.preferredPeriod=peak;
    MEM.profile.peakConfidence=Math.round(Math.max(morning,afternoon,evening)/hours.length*100);
  }
  
  // Duration accuracy
  const durEvents=doneE.filter(e=>e.actualDuration&&e.actualDuration>0);
  if(durEvents.length>=3){
    const avgDuration=Math.round(durEvents.reduce((s,e)=>s+e.actualDuration,0)/durEvents.length);
    recordObservation('avg_actual_duration', avgDuration, durEvents.length);
  }
  
  // Skip rate
  if(ev.length>=5){
    const skipRate=skipE.length/ev.length;
    recordObservation('skip_rate', skipRate, ev.length);
  }
  
  // Late wake frequency
  const wakes=Object.entries(S.wakeTimes||{});
  if(wakes.length>=3){
    const lateDays=wakes.filter(([,v])=>minutesHM(v)-minutesHM(baseWake(v))>=80).length;
    recordObservation('late_wake_ratio', lateDays/wakes.length, wakes.length);
  }

  // Habit streaks
  for(const h of S.customHabits){
    let streak=0; let d=today();
    for(let i=0;i<60;i++){
      let dt=shift(d,-i);
      if(habitDone(dt,h.id)) streak++; else break;
    }
    recordObservation('habit_streak_'+h.id, streak, Math.min(streak,14));
  }
  
  MEM.updated=today();
  persist();
}

function memorySummary(){
  refreshMemory();
  const lines=[];
  if(MEM.profile.preferredPeriod) lines.push(`Продуктивнее всего — ${MEM.profile.preferredPeriod} (${MEM.profile.peakConfidence}% отметок).`);
  const skipRate=getObservation('skip_rate');
  if(skipRate!==null && skipRate>0.3) lines.push(`Пропускается ${Math.round(skipRate*100)}% дел. Возможно, расписание слишком плотное.`);
  const avgDur=getObservation('avg_actual_duration');
  if(avgDur!==null) lines.push(`Средняя фактическая длительность дел: ${Math.round(avgDur)} мин.`);
  const lateWake=getObservation('late_wake_ratio');
  if(lateWake!==null && lateWake>0.4) lines.push(`Поздний подъём в ${Math.round(lateWake*100)}% дней. Рекомендуется сдвинуть менее важные дела на вторую половину дня.`);
  
  // Category totals must be computed in this scope. refreshMemory() has
  // a separate local variable; accessing it here used to crash Stats.
  const catCounts=Object.create(null);
  for(const e of (S.events||[])){
    if(!['complete','skip'].includes(e.type)||!e.category) continue;
    const ct=(catCounts[e.category]||={t:0,c:0});
    ct.t++;
    if(e.type==='complete') ct.c++;
  }
  for(const [cat,ct] of Object.entries(catCounts)){
    if(ct.t>=5 && ct.c/ct.t<0.4) lines.push(`Категория "${cat}" — выполнено только ${Math.round(ct.c/ct.t*100)}% дел.`);
  }
  
  if(!lines.length) lines.push('Пока собираю наблюдения. Нужно больше отметок выполнения для персональных выводов.');
  return lines;
}

function memoryView(){
  const lines=memorySummary();
  let html=`<div class="subhead"><h2>Память JARVIS</h2><span>Локально</span></div><div class="card">`;
  html+=`<div class="stat-grid">`;
  html+=`<div class="stat-card"><b>${S.events.filter(e=>['complete','skip'].includes(e.type)).length}</b><small>Отметок</small></div>`;
  html+=`<div class="stat-card"><b>${MEM.observations.length}</b><small>Наблюдений</small></div>`;
  html+=`<div class="stat-card"><b>${safe(MEM.profile.preferredPeriod||'—')}</b><small>Лучшее время</small></div>`;
  html+=`<div class="stat-card"><b>${Object.keys(S.wakeTimes||{}).length}</b><small>Дней с подъёмом</small></div>`;
  html+=`</div><div class="sectiontitle">Выводы</div>`;
  for(const line of lines) html+=`<p class="infotext">${safe('• '+line)}</p>`;
  html+=`<div style="display:flex;gap:6px;margin-top:8px"><button class="btn tight" data-action="refreshMemory">Обновить</button><button class="btn tight" data-action="clearMemory">Сбросить наблюдения</button></div>`;
  html+=`<p class="tagline">Персональные выводы на основе ${S.events.length} событий. Не медицинская рекомендация.</p></div>`;
  return html;
}

/* ── Realistic local-first replanning (v3.1) ──
   Preview is PURE: never mutate S, even on conflict analysis.
   Time-specific routines expire instead of migrating to absurd hours.
   Transfers are committed only by smartReplan and restored by undo. */
function temporalBounds(t,s,dayStart,dayEnd){
  const name=String(t.name||''),cat=t.cat||'',original=clock(t.start),length=duration(t);
  let earliest=dayStart,latest=dayEnd,ephemeral=false,routine=false;
  const morning=/подъ[её]м|утренн|завтрак|снять ночные линзы|зубы.*одет/i.test(name)
    ||(cat==='Гигиена'&&original<12*60);
  if(morning){
    routine=true;
    latest=Math.min(latest,12*60+30,minutesHM(wakeTime(s))+3*60);
  } else if(/обед/i.test(name)){
    routine=true;earliest=Math.max(earliest,11*60);latest=Math.min(latest,16*60+30);
  } else if(/ужин/i.test(name)){
    routine=true;earliest=Math.max(earliest,17*60);latest=Math.min(latest,21*60);
  } else if(cat==='Перерыв'||/^(перерыв|отдых [0-9]+ мин)/i.test(name)){
    // A break without its original work session is not a new evening task.
    routine=true;ephemeral=true;
    earliest=Math.max(earliest,original-15);
    latest=Math.min(latest,original+Math.max(25,length+25));
  } else if(cat==='Отдых'||/свободн.*время|отдых без/i.test(name)){
    // Leisure should not multiply or migrate across days.
    routine=true;
    earliest=Math.max(earliest,original-45);
    latest=Math.min(latest,original+Math.max(75,length+45));
  } else if(/вечерн.*душ|линзы.*сн|план на завтра|подготовк.*сн/i.test(name)){
    routine=true;earliest=Math.max(earliest,20*60);latest=Math.min(latest,23*60+30);
  }
  return {earliest,latest,routine,ephemeral};
}
function buildSmartPlan(s,options={}){
  const productive=options.goal==='productive';
  const base=baseItemList(s), selected=S.dayAdjust[s]||{};
  const win=timeWindow(s),todaySelected=s===today();
  const now=new Date();let minute=now.getHours()*60+now.getMinutes();
  // Calendar v3.4 switches the date at local midnight. Do NOT treat 00:00–03:59
  // as yesterday: that would expire every upcoming task in today's preview.
  const effectiveStart=todaySelected?Math.max(win.start,Math.ceil((minute+5)/5)*5):win.start;
  const fixed=[],flex=[],expired=[],released=[],skipped=[],moved=[],transfers=[];
  const result=JSON.parse(JSON.stringify(selected));
  for(const original of base){
    const override=selected[original.id];
    if(override?.omit)continue;
    const t={...original,...override};
    if(done(s,t.id))continue; // Actual completion is not inferred from time.
    if(isFixed(t,s)||t.pinned){
      fixed.push({id:t.id,start:clock(t.start),end:clock(t.end),name:t.name,cat:t.cat});
    } else if(t.status==='Буфер'||t.cat==='Буфер'){
      // Buffer means *available* time, not a task to reschedule.
      result[t.id]={omit:true};
    } else if(productive&&(t.cat==='Отдых'||/свободн.*время|сериал|тикток|свободный отдых/i.test(t.name))){
      // Only genuinely flexible leisure is released; fixed family/social time stays.
      released.push({t,reason:'Освобождено время под приоритетные дела'});
      result[t.id]={omit:true};
    } else flex.push(t);
  }
  const occupied=fixed.map(t=>({...t}));
  const ranked=t=>{
    const until=t.deadlineDate?dDiff(t.deadlineDate,s):Infinity;
    const work=productive&&(/^(Код|Математика|Карьера|Университет)$/.test(t.cat)
      ||/python|код|матанализ|junior radar|собеседован|проект|учеб[а-я]*/i.test(t.name));
    // Prefer meaningful work over optional chores when the user asks for
    // a productive evening; urgent deadlines and mandatory routines still matter.
    return classifyPriority(t)+(until<=1?4:until<=3?2:0)+(work?4:0);
  };
  flex.sort((a,b)=>ranked(b)-ranked(a)
    ||(a.deadlineDate?dDiff(a.deadlineDate,s):999)-(b.deadlineDate?dDiff(b.deadlineDate,s):999)
    ||clock(a.start)-clock(b.start));
  // Gentle / low-energy goals keep fewer non-mandatory blocks. Hard constraints
  // (fixed events, sleep, mandatory routines) are never touched.
  const gentle=options.goal==='gentle',low=options.goal==='low';
  if(gentle||low){
    const cap=low?1:2;let workKept=0;
    for(let i=0;i<flex.length;i++){
      const t=flex[i];
      const mandatory=t.status==='Обязательно'||['Питание','Гигиена','Сон','Перерыв'].includes(t.cat);
      if(mandatory)continue;
      const work=/^(Код|Математика|Университет|Карьера)$/.test(t.cat)||/python|код|матем|проект|учёб|курсов|контрольн/i.test(t.name);
      if(work&&workKept<cap){workKept++;continue;}
      result[t.id]={omit:true};
      skipped.push({t,reason:low?'Щадящий режим: нагрузка снижена':(gentle?'Бережный режим: больше отдыха':'Освобождено время')});
      flex.splice(i,1);i--;
    }
  }
  let demand=0;
  // Reserve new future slots within this calculation, not just items already
  // persisted; otherwise several deferred tasks can land at 09:00 tomorrow.
  const futureReservations=new Map();
  const placeAfter=task=>{
    for(let offset=1;offset<=5;offset++){
      const future=shift(s,offset),other=timeWindow(future);
      if(task.deadlineDate&&dDiff(task.deadlineDate,future)<0)break;
      const busy=itemList(future).filter(t=>t.status!=='Буфер'&&t.cat!=='Буфер'
        &&(isFixed(t,future)||t.status==='Обязательно'||t.status==='План'))
        .map(t=>({start:clock(t.start),end:clock(t.end)}))
        .concat(futureReservations.get(future)||[]);
      const first=Math.max(other.start,9*60),last=Math.min(other.end,22*60+30);
      const slot=proposeSlot(future,task,busy,{first,last});
      if(slot){
        if(!futureReservations.has(future))futureReservations.set(future,[]);
        futureReservations.get(future).push({start:slot.start,end:slot.end});
        return {date:future,start:niceTime(slot.start),end:niceTime(slot.end)};
      }
    }
    return null;
  };
  for(const t of flex){
    const isWorkT=/^(Код|Математика|Университет|Карьера)$/.test(t.cat)||/python|код|матем|проект|учёб|курсов|контрольн/i.test(t.name);
    const len=(low&&isWorkT)?Math.min(duration(t),25):duration(t),st=clock(t.start),b=temporalBounds(t,s,effectiveStart,win.end);
    if((options.avoidEvening||[]).some(n=>String(t.name).toLowerCase().includes(n)))b.latest=Math.min(b.latest,18*60);
    // A routine whose meaningful window is over is missed, not moved to 18:20.
    if(b.latest-b.earliest<len || (todaySelected&&b.routine&&clock(t.end)<minute-30)){
      expired.push({t,reason:'Время этого дела уже прошло'});
      result[t.id]={omit:true};
      continue;
    }
    // Prioritise actually feasible work, not hours of already missed breakfast/breaks.
    demand+=len;
    const slot=proposeSlot(s,t,occupied,{first:b.earliest,last:b.latest});
    if(slot){
      occupied.push({start:slot.start,end:slot.end,id:t.id});
      result[t.id]={start:niceTime(slot.start),end:niceTime(slot.end)};
      if(Math.abs(slot.start-st)>=10)moved.push({id:t.id,name:t.name,from:st,to:slot.start,reason:'Сдвинуто в свободное окно'});
      continue;
    }
    // Do not silently force urgent tasks on top of classes/other fixed events.
    // Only optional *non-routine* tasks can be transferred across days.
    const deferrable=t.status!=='Обязательно'&&!b.routine
      &&!['Питание','Гигиена','Сон','Перерыв','Отдых'].includes(t.cat)
      &&(!t.deadlineDate||dDiff(t.deadlineDate,s)>0);
    const transfer=deferrable?placeAfter(t):null;
    if(transfer){
      transfers.push({task:t,from:s,...transfer});
      result[t.id]={omit:true};
      moved.push({id:t.id,name:t.name,from:st,to:clock(transfer.start),date:transfer.date,reason:'Перенесено на '+transfer.date});
    }else{
      skipped.push({t,reason:b.routine?'Не поместилось в подходящее время':'Сегодня недостаточно свободного времени'});
      result[t.id]={omit:true};
    }
  }
  const futureFixed=fixed.map(x=>({start:Math.max(effectiveStart,x.start),end:Math.min(win.end,x.end)}))
    .filter(x=>x.end>x.start).sort((a,b)=>a.start-b.start);
  let busyMinutes=0,last=effectiveStart;
  for(const x of futureFixed){busyMinutes+=Math.max(0,x.end-Math.max(x.start,last));last=Math.max(last,x.end)}
  const capacity=Math.max(0,win.end-effectiveStart-busyMinutes);
  const overload=Math.max(0,demand-capacity);
  return {result,skipped,expired,released,moved,transfers,count:flex.length,fixed:fixed.length,
    overload,placed:flex.length-skipped.length-expired.length-transfers.length,
    wakeDelta:minutesHM(wakeTime(s))-minutesHM(baseWake(s))};
}
function smartReplan(s,{silent=false,goal='balanced',reportedWake=null,avoidEvening=[]}={}){
  // Snapshot all state that can change, not just the current day's offsets.
  const before={
    adjust:JSON.parse(JSON.stringify(S.dayAdjust[s]||{})),
    pending:JSON.parse(JSON.stringify(S.pending[s]||[])),
    addedTransfers:[],
    wake: Object.prototype.hasOwnProperty.call(S.wakeTimes||{},s)?S.wakeTimes[s]:null
  };
  // Record actual late wake only on flex days; on university days the fixed
  // morning start remains unchanged, but missed work is still handled by time.
  if(reportedWake&&/^([01]\d|2[0-3]):[0-5]\d$/.test(reportedWake)&&flexibleWake(s)){
    S.wakeTimes||={};S.wakeTimes[s]=reportedWake;
  }
  const plan=buildSmartPlan(s,{goal,avoidEvening}); // Calculation itself has no other side effects.
  S.planUndo[s]=before;
  S.dayAdjust[s]=plan.result;
  S.pending[s]=plan.skipped.map(x=>({id:x.t.id,name:x.t.name,reason:x.reason,
    required:x.t.status==='Обязательно'||classifyPriority(x.t)>=4}));
  S.planUndo[s].applied=JSON.parse(JSON.stringify(plan.result));
  S.planUndo[s].appliedPending=JSON.parse(JSON.stringify(S.pending[s]));
  for(const tx of plan.transfers){
    const newId='x_rp_'+s.replace(/-/g,'')+'_'+String(tx.task.id).replace(/[^\w]/g,'_');
    if(S.extras.some(t=>t.id===newId))continue;
    const transferred={...tx.task,id:newId,fromDate:tx.date,repeat:'once',
      start:tx.start,end:tx.end,note:(tx.task.note||'')+' · Перенесено с '+s};
    S.extras.push(transferred);
    S.planUndo[s].addedTransfers.push(JSON.parse(JSON.stringify(transferred)));
  }
  logEvent('replan',s,null,{scheduled:plan.placed,deferred:plan.skipped.length,
    expired:plan.expired.length,released:plan.released.length,transferred:plan.transfers.length,moved:plan.moved.length,
    overload:plan.overload});
  if(!silent){
    let msg='✦ Обновил день: '+plan.placed+' дел в расписании';
    if(plan.expired.length)msg+=', '+plan.expired.length+' устаревших пропущено';
    if(plan.transfers.length)msg+=', '+plan.transfers.length+' перенесено на другие дни';
    if(plan.skipped.length)msg+=', '+plan.skipped.length+' не поместилось';
    toast(msg);
  }
  render();return plan;
}
function revertPlan(s){
  if(!Object.prototype.hasOwnProperty.call(S.planUndo,s)){
    toast('Нет сохранённого плана для отмены');return;
  }
  const previous=S.planUndo[s],current=S.dayAdjust[s]||{},applied=previous.applied||{};
  // Preserve any manual edits made after the last replan.
  if(previous.applied){
    const restored={...current};
    for(const [id,change] of Object.entries(applied)){
      if(JSON.stringify(current[id])!==JSON.stringify(change))continue;
      if(Object.prototype.hasOwnProperty.call(previous.adjust,id))restored[id]=previous.adjust[id];
      else delete restored[id];
    }
    S.dayAdjust[s]=restored;
  }else S.dayAdjust[s]=previous.adjust;
  if(JSON.stringify(S.pending[s]||[])===JSON.stringify(previous.appliedPending||[]))S.pending[s]=previous.pending;
  if(Object.prototype.hasOwnProperty.call(previous,'wake')){
    S.wakeTimes||={};
    if(previous.wake===null)delete S.wakeTimes[s];
    else S.wakeTimes[s]=previous.wake;
  }
  // Only remove transfers created by this replan, not unrelated later tasks.
  const created=new Map((previous.addedTransfers||[]).map(t=>[t.id,t]));
  S.extras=S.extras.filter(t=>!created.has(t.id)||JSON.stringify(t)!==JSON.stringify(created.get(t.id)));
  delete S.planUndo[s];persist();render();toast('Вернул план, сохранив последующие изменения');
}

function automaticallyPlaceTask(item,upTo,repeatId){
 let s=ui.date;if(dDiff(upTo,s)<0)return [];
 const days=Math.min(45,dDiff(upTo,s)+1),op=[];
 for(let i=0;i<days;i++){
   let dt=shift(s,i),busy=itemList(dt).filter(t=>isFixed(t,dt)||t.status==='Обязательно').map(t=>({start:clock(t.start),end:clock(t.end)}));
   let available=proposeSlot(dt,item,busy,{first:Math.max(minutesHM(wakeTime(dt)),9*60),last:Math.min(timeWindow(dt).end,21*60)});
   if(available)op.push({date:dt,start:niceTime(available.start),end:niceTime(available.end),quality:available.score});
 }
 return op.sort((a,b)=>a.quality-b.quality);
}
function suggestDeadline(title,deadline,total,cat,priority){
 if(!deadline||dDiff(deadline,ui.date)<0)return {slots:[],error:'Дедлайн уже прошёл'};
 if(dDiff(deadline,ui.date)>45)return {slots:[],error:'Пока поддерживается планирование в пределах 45 дней'};
 let left=clamp(total,10,3000),slots=[];
 const dayCaps={};
 while(left>0){
   let blockLen=Math.min(40,left),template={name:title,start:'17:30',end:niceTime(17*60+30+blockLen),cat,status:'Обязательно',priority,deadlineDate:deadline};
   let options=automaticallyPlaceTask(template,deadline);
   options.sort((a,b)=>{
     // Urgent work has some bias toward earlier dates, but still avoids crowded days.
     let x=a.quality+(dayCaps[a.date]||0)*2.6 + dDiff(a.date,ui.date)*0.25;
     let y=b.quality+(dayCaps[b.date]||0)*2.6 + dDiff(b.date,ui.date)*0.25;
     return x-y;
   });
   let place=options.find(a=>(dayCaps[a.date]||0)<3 && !slots.some(q=>q.date===a.date&&minutesHM(a.start)<minutesHM(q.end)&&minutesHM(a.end)>minutesHM(q.start)));
   if(!place)break;
   slots.push({...place,len:blockLen});dayCaps[place.date]=(dayCaps[place.date]||0)+1;left-=blockLen;
 }
 return {slots:slots.sort((a,b)=>a.date.localeCompare(b.date)||a.start.localeCompare(b.start)),left};
}

function customHabitScheduled(h,s){
 let d=dDiff(s,h.fromDate||today());if(d<0)return false;
 if(h.mode==='everyN')return d%(Number(h.interval)||2)===0;
 if(h.mode==='weekly')return (h.days||[]).includes(indexDay(s));
 return true;
}
function customHabitActive(h,s){
 if(h.archived)return false;
 return customHabitScheduled(h,s);
}
/* Honest scheduling helpers: a habit is "planned" only on days it is actually
   scheduled, so new habits are never shown as failures before they exist, and
   archives keep their history but are not counted as current obligations. */
function habitScheduled(h,d){
 if(!h)return false;
 if(h.mode)return customHabitScheduled(h,d);
 if(Array.isArray(h.days))return h.days.includes(indexDay(d));
 return true;
}
function habitHistory(h,days){days=days||7;let out=[];for(let i=days-1;i>=0;i--){let d=shift(today(),-i);out.push({d,planned:habitScheduled(h,d),done:habitDone(d,h.id)});}return out;}
function habitWeekPercent(h){
 let planned=habitHistory(h,7).filter(x=>x.planned);
 if(!planned.length)return null;
 return Math.round(planned.filter(x=>x.done).length/planned.length*100);
}
function habitStreak(h){
 let n=0;
 for(let i=0;i<400;i++){let d=shift(today(),-i);
  if(!habitScheduled(h,d))continue;
  if(habitDone(d,h.id))n++;
  else if(i===0)continue; /* today is still open, do not break the run yet */
  else break;
 }
 return n;
}
function habitPeriodPercent(h,days){days=(days===30)?30:7;let planned=habitHistory(h,days).filter(x=>x.planned);if(!planned.length)return null;return Math.round(planned.filter(x=>x.done).length/planned.length*100);}
function habitHistoryStrip(h,days){days=(days===30)?30:7;
 return habitHistory(h,days).map(x=>x.planned?`<span class="hdot ${x.done?'on':''}" title="${safe(x.d)}">${x.done?'✓':'·'}</span>`:'<span class="hdot off" title="'+(x.d?safe(x.d):'')+'">–</span>').join('');
}
function allTrackedHabits(){
 const built=HABITS.filter(h=>h.id!=='shampoo');
 return built.concat(S.customHabits||[]);
}
function currentHabits(s){let x=HABITS.filter(h=>h.days.includes(indexDay(s))&&h.id!=='shampoo');
 const isTreat=(S.shampooDays||[1,5]).includes(indexDay(s));
 x.push({id:'hairwash',name:isTreat?'Лечебный шампунь':'Мягкий шампунь',sub:isTreat?'По инструкции/назначению, выдержать рекомендуемое время':'Не увеличивать агрессивное очищение; обычный уход',days:[indexDay(s)]});
 return [...x,...S.customHabits.filter(h=>customHabitActive(h,s))];}

function smartControls(t,s){
  const f=isFixed(t,s),running=!!S.activeTasks?.[datekey(s,t.id)];
  const prob=predict(t,s,clock(t.start));
  const learned=prob.learned?`≈${Math.round(prob.probability*100)}% · ${prob.observations} наблюдений`:'Рекомендация по правилам';
  const clas=swapFirst===t.id?' swap-selected':'';
  return `<div class="smart-task-actions${clas}">
    ${!f?`<button data-action="shiftTask" data-id="${safe(t.id)}" data-min="-15" aria-label="На 15 минут раньше">−15м</button><button data-action="shiftTask" data-id="${safe(t.id)}" data-min="15" aria-label="На 15 минут позже">+15м</button><button data-action="swap" data-id="${safe(t.id)}">↕ Обмен</button><button data-action="postponeTask" data-id="${safe(t.id)}">→ Завтра</button><button data-action="skipTask" data-id="${safe(t.id)}">Пропустить</button>`:'<span class="smart-locked">🔒 Фиксированное время</span>'}
    ${t.cat==='Университет'&&isOptionalClass(t)?`<button data-action="skipSession" data-id="${safe(t.id)}">Сегодня дома</button>`:''}
    ${!f?`<button data-action="taskStart" data-id="${safe(t.id)}">${running?'⏱ Идёт':'▶ Начать'}</button>`:''}
    <span class="model-hint" title="Оценка успеха по контексту, не гарантия">${learned}</span>
  </div>`;
}
/* Smart per-task controls are rendered inside the compact task expand panel (index.html taskRowHTML). */
/* ── Conflict Resolution UI ── */
function showConflictCard(plan){
  if(!plan.skipped.length && !plan.moved.length && !plan.overload && !plan.expired?.length){
    toast('Конфликтов не найдено. Расписание оптимально.'); return;
  }
  let html='<div class="modalhead"><h2>JARVIS \u00b7 Анализ дня</h2><button class="iconbtn" data-action="close">\u00d7</button></div>';
  html+='<div class="card" style="margin:6px 0">';
  if(plan.overload>0) html+='<p class="infotext">\u26a0 День перегружен на '+Math.round(plan.overload)+' мин. Не все задачи поместятся.</p>';
  if(plan.expired?.length)html+='<p class="infotext">Сегодня уже неактуальны '+plan.expired.length+' утренних или временных дел. Они не будут переноситься на вечер и не считаются выполненными.</p>';
  if(plan.skipped.length) html+='<div class="sectiontitle">Не поместились ('+plan.skipped.length+')</div>';
  for(const x of plan.skipped){
    const isReq=x.t.status==='Обязательно'||classifyPriority(x.t)>=4;
    html+='<div class="deadline-line"><b>'+(isReq?'\u26a0 ':'')+safe(x.t.name)+'</b><small>'+safe(x.reason)+'</small>\n      <div style="display:flex;gap:6px;margin-top:2px">\n        <button class="btn tight" data-action="restorePending" data-id="'+safe(x.t.id)+'">Оставить</button>\n        <button class="btn tight" data-action="postponeTask" data-id="'+safe(x.t.id)+'">На завтра</button>\n      </div></div>';
  }
  if(plan.moved.length) html+='<div class="sectiontitle">Изменено ('+plan.moved.length+')</div>';
  for(const x of plan.moved) html+='<div class="deadline-line"><b>'+safe(x.name)+'</b><small>'+safe(x.reason)+'</small></div>';
  html+='<div style="display:flex;gap:6px;margin-top:8px">\n    <button class="btn primary" data-action="smartReplan">Применить</button>\n    <button class="btn" data-action="close">Отмена</button>\n  </div></div>';
  document.querySelector('#modalbox').innerHTML=html;
  document.querySelector('#modalback').classList.add('show');
}

function plannerBanner(s){
  const count=eventCount(),pending=(S.pending[s]||[]);
  const items=itemList(s);
  const totalMin=items.reduce((a,t)=>a+(clock(t.end)-clock(t.start)),0);
  const availMin=timeWindow(s).end-timeWindow(s).start;
  const overload=totalMin>availMin?Math.round(totalMin-availMin):0;
  return `<div class="smart-banner"><div class="smart-banner-top"><div><div class="eyebrow">АДАПТИВНЫЙ ДЕНЬ</div><strong>Твой план, твои правила</strong><small>Переход к другому делу, перенос ±15 мин, обмен задач или автопланирование.</small></div><button class="btn primary" data-action="resolveConflicts">✦ Анализ</button></div><div class="smart-banner-actions"><button class="btn tight" data-action="smartReplan">Пересобрать</button><button class="btn tight" data-action="undoSmart">↶ Отменить</button><button class="btn tight" data-action="smartAdd">＋ Дедлайн / дело</button><button class="btn tight" data-action="tab" data-tab="planner">⚙ План</button></div><div class="model-hint">${count>=6?'Модель использует '+count+' отметок завершения/пропуска':'Пока '+count+' наблюдений: стартовые правила, модель обучается по твоим отметкам'}. Фиксированные пары, зал и Roblox не двигаем.</div>${overload>0?`<div class="wakeconflict">⚠ Перегрузка дня на ${overload} мин. <button class="btn tight" data-action="resolveConflicts">Покивань варианты</button></div>`:''}${pending.length?`<div class="wakeconflict">⚠ Не поместились ${pending.length} дел (обязательных ${pending.filter(x=>x.required).length}). <button class="btn tight" data-action="resolveConflicts">Распределить</button></div>`:''}</div>`;
}

todayView=function(){return rawTodayView();};
taskRowHTML=function(t,s,children){
 const raw=rawTaskHTML(t,s,children);
 const smart=smartControls(t,s);
 return raw.replace('<div class="actions">','<div class="actions">'+smart+'<div class="smart-divide"></div>');
};

// Add visible shampoo rotation and personal recurrence without changing source-built habits.
habitsView=function(){
 let s=ui.date,orig=rawHabitsView(),list=S.customHabits.filter(h=>!h.archived);
 let archived=S.customHabits.filter(h=>h.archived);
 let hair=(S.shampooDays||[1,5]).includes(indexDay(s));
 let out=`<div class="subhead"><h2>Мои привычки и уход</h2><button class="btn tight primary" data-action="addHabit">+ Добавить</button></div>`;
 out+=`<div class="card"><div class="eyebrow">УХОД ЗА ВОЛОСАМИ</div><div class="smart-hair">${hair?'🧴 Лечебный':'🌿 Мягкий'} · ${safe(DAYSFULL[indexDay(s)])}</div><p class="infotext">Лечебный по выбранным дням: ${S.shampooDays.map(i=>WEEKDAYS[i]).join(', ')}. Остальные дни — привычный мягкий шампунь. Следуй инструкции к лечебному средству.</p><label class="habit-inline"><input class="taskcheck" type="checkbox" data-habit="hairwash" data-date="${s}" ${habitDone(s,'hairwash')?'checked':''}> Шампунь сегодня использован</label><button class="btn tight" data-action="tab" data-tab="settings">Изменить дни</button></div>`;
 if(list.length){
  out+='<div class="card habit-list">';
  for(let h of list){const sched=customHabitScheduled(h,s);const cid='hbc_'+String(h.id).replace(/[^a-zA-Z0-9_-]/g,'')+'_'+s.replace(/-/g,'');const mark=sched?`<input id="${cid}" type="checkbox" class="task-check" data-habit="${safe(h.id)}" data-date="${s}" ${habitDone(s,h.id)?'checked':''}>`:'<span class="habit-off" aria-hidden="true">·</span>';const lab=sched?`<label for="${cid}">`:'<label>';out+=`<div class="habrow${sched?'':' offday'}">${mark}${lab}${safe(h.name)}<small>${safe(habitModeText(h))}${sched?'':' · не сегодня'}${h.sub?' · '+safe(h.sub):''}</small></label><button class="btn tight" data-action="editHabit" data-id="${safe(h.id)}" aria-label="Изменить привычку">✎</button><button class="btn tight" data-action="archiveHabit" data-id="${safe(h.id)}" aria-label="Убрать в архив">⤓</button></div>`;}
  out+='</div>';
 } else {
  out+='<div class="card"><p class="tagline">Пока нет своих привычек. Добавь первую — она появится в списке на выбранные дни.</p></div>';
 }
 const period=(ui.habitPeriod===30)?30:7;
 const tracked=allTrackedHabits().filter(h=>!h.archived);
 const hist=tracked.map(h=>{const pct=habitPeriodPercent(h,period),streak=habitStreak(h);return `<div class="habit-hist"><div class="habit-hist-head"><span class="grow">${safe(h.name)}</span>${streak?`<span class="hstreak">🔥 ${streak}</span>`:''}<span class="hweek">${pct==null?'—':pct+'%'}</span></div><div class="hstrip">${habitHistoryStrip(h,period)}</div></div>`;}).join('');
 out+=`<div class="subhead"><h2>Статистика</h2><div class="hab-period"><button data-action="habitPeriod" data-id="7" class="${period===7?'sel':''}">7 дней</button><button data-action="habitPeriod" data-id="30" class="${period===30?'sel':''}">30 дней</button></div></div>`;
 out+=`<div class="card habit-hist-card">${hist||'<p class="infotext">Пока нет запланированных привычек.</p>'}<p class="infotext">Процент считается только по запланированным дням; отдых и «не запланировано» не считаются провалом.</p></div>`;
 if(archived.length){out+='<div class="sectiontitle">Архив</div><div class="card habit-list">';
  for(let h of archived)out+=`<div class="habrow archived"><label class="grow">${safe(h.name)}<small>в архиве · отметки сохранены</small></label><button class="btn tight" data-action="restoreHabit" data-id="${safe(h.id)}">Вернуть</button><button class="btn tight" data-action="delHabit" data-id="${safe(h.id)}" aria-label="Удалить навсегда">✕</button></div>`;
  out+='</div>';
 }
 // Prevent duplicate default shampoo row from the original fixed list.
 orig=orig.replace(/<div class="habrow"><input class="taskcheck" type="checkbox" data-habit="shampoo"[\s\S]*?<\/div>/,'');
 return orig+out;
};
function habitModeText(h){return h.mode==='everyN'?`каждые ${h.interval} дн.`:h.mode==='weekly'?'по выбранным дням':'ежедневно';}
(function(){try{if(typeof document==='undefined'||document.getElementById('habitHistStyles'))return;let st=document.createElement('style');st.id='habitHistStyles';st.textContent='.habit-hist{padding:7px 0;border-top:1px solid var(--line)}.habit-hist:first-child{border-top:none}.habit-hist-head{display:flex;align-items:center;gap:8px;font-size:13px}.habit-hist-head .grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.hstreak{color:var(--orange);font-variant-numeric:tabular-nums}.hweek{color:var(--sub);font-variant-numeric:tabular-nums;font-weight:700}.hstrip{display:flex;gap:2px;margin-top:6px}.hdot{flex:1;min-width:0;height:16px;border-radius:4px;display:grid;place-items:center;font-size:9px;background:var(--bg2);color:var(--muted)}.hdot.on{background:var(--green);color:#0b1b21;font-weight:800}.hdot.off{opacity:.28}.habrow.archived{opacity:.7}.hab-period{display:flex;gap:4px}.hab-period button{font-size:11px;min-height:30px;padding:4px 10px;border:1px solid var(--line);border-radius:9px;background:var(--bg2);color:var(--sub)}.hab-period button.sel{background:var(--card);color:var(--text);border-color:var(--accent)}.habit-off{width:22px;text-align:center;color:var(--muted);flex:none}.habrow.offday{opacity:.72}';document.head.appendChild(st);}catch(e){}})();

function insightsText(){
 const ev=S.events.filter(e=>['complete','skip'].includes(e.type)),doneE=ev.filter(e=>e.type==='complete'),skipE=ev.filter(e=>e.type==='skip'),moves=S.events.filter(e=>e.type==='move'||e.type==='swap'),wakeEntries=Object.entries(S.wakeTimes||{}),serial=Object.values(S.logs||{}).reduce((a,l)=>a+Number(l.serial||0),0);
 let hints=[];
 if(ev.length<6)hints.push(`Для персональных рекомендаций нужно хотя бы 6–10 реальных отметок завершения или пропуска. Сейчас: ${ev.length}. Пока действует базовая оптимизация.`);
 else{
   const buckets=['утро','день','вечер'].map(p=>{const e=doneE.filter(x=>hoursGroup(minutesHM(x.actualStart||x.plannedStart||'12:00'))===p);return {p,n:e.length};}).sort((a,b)=>b.n-a.n);
   if(buckets[0].n>0)hints.push(`Чаще всего отмечаешь выполненные задачи в период «${buckets[0].p}» (${buckets[0].n} подтверждений). Это описание отметок, не докиванельство продуктивности в эти часы.`);
   if(skipE.length)hints.push(`${skipE.length} задач явно пропущено. Планировщик может отдавать больше места обязательным блокам.`);
 }
 if(wakeEntries.length)hints.push(`Фактический подъём указан для ${wakeEntries.length} дней. Позднее пробуждение сокращает число свободных окон до фиксированных событий.`);
 if(moves.length)hints.push(`Переносов/обменов: ${moves.length}. Они помогают понять, насколько исходный шаблон совпадает с реальностью.`);
 if(!hints.length)hints.push('Начни отмечать фактическое начало и окончание задач, чтобы видеть точные закономерности, а не выдуманные прогнозы.');
 return hints;
}
function extraInsightView(){
 const a=S.events.filter(e=>['complete','skip'].includes(e.type));
 const durationEvents=a.filter(e=>e.actualDuration>0);
 const meanDur=durationEvents.length?Math.round(durationEvents.reduce((v,e)=>v+e.actualDuration,0)/durationEvents.length):null;
 const wakes=Object.entries(S.wakeTimes||{});
 const avgWake=wakes.length?niceTime(Math.round(wakes.reduce((n,[,v])=>n+minutesHM(v),0)/wakes.length)):null;
 return `<div class="subhead"><h2>Данные о тебе · локально</h2><span>Без облака</span></div><div class="stat-grid"><div class="stat-card"><b>${a.length}</b><small>Результатов задач для модели</small></div><div class="stat-card"><b>${meanDur??'—'}</b><small>${meanDur?'Средняя фактическая длительность, мин':'Время пока не измерено'}</small></div><div class="stat-card"><b>${avgWake||'—'}</b><small>Средний записанный подъём</small></div><div class="stat-card"><b>${S.events.length}</b><small>Всех событий в журнале</small></div></div><div class="sectiontitle">Наблюдения и рекомендации</div><div class="card">${insightsText().map(x=>`<p class="infotext">• ${safe(x)}</p>`).join('')}<div class="divider"></div><div class="model-hint">Метод: локальное байесовское обновление вероятности выполнения по категории дела, времени суток и подъёму. Это предварительные оценки, а не медицинский, психологический или научно валидированный прогноз.</div></div><div class="subhead"><h2>Выгрузить историю</h2></div><div class="card"><div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn primary" data-action="exportSQL">Скачать .sql</button><button class="btn" data-action="exportCSV">CSV</button><button class="btn" data-action="export">JSON</button></div><p class="infotext">События зеркалируются в IndexedDB. SQL-файл — экспорт таблиц для импорта в SQLite; сам GitHub Pages не запускает SQL-сервер. Данные остаются на устройстве до экспорта.</p></div>`;
}
/* 12-week activity heatmap. The grid itself is a pure module (site/heatmap.js),
   so the same layout can later show focus minutes or reviews. */
function heatmapView(){
 if(typeof JarvisHeatmap==='undefined')return '';
 const HM=JarvisHeatmap,end=today();
 const model=HM.build({end,weeks:12,valueFor:d=>{try{const pr=progress(d);return pr.b>0?pr.p:null}catch(e){return null}}});
 return '<div class="subhead"><h2>Активность</h2><span class="tagline">12 недель</span></div><div class="card">'+HM.render(model,{caption:'Выполнение по дням. Пустые клетки — нет данных.',highlight:end})+'</div>';
}
statsView=function(){return rawStatsView()+heatmapView()+memoryView()+extraInsightView()};

function plannerView(){let s=ui.date,n=eventCount();const lastPlan=S.events.filter(e=>e.type==='replan'&&e.date===s).slice(-1)[0];const pending=S.pending[s]||[];
 const deadlines=S.extras.filter(t=>t.deadlineDate&&dDiff(t.deadlineDate,s)>=0&&dDiff(t.deadlineDate,s)<45).sort((a,b)=>a.deadlineDate.localeCompare(b.deadlineDate)).slice(0,6);
 let html=appHeader()+`<div class="today-header"><div class="today-date">План<small>${safe(dateTitle(s))}</small></div><button class="iconbtn" data-action="opendate" data-date="${s}" title="Открыть день" aria-label="Открыть день">→</button></div>`;
 html+=dateStrip(s)+wakePanel(s);
 html+=`<div class="subhead"><h2>Неделя</h2><span class="tagline">${n} отметок · тап — открыть день</span></div>`+weekCards(s);
 html+=`<div class="subhead"><h2>Пересобрать день</h2></div><div class="card"><p class="infotext">Алгоритм ищет свободные окна с учётом подъёма, важности и прошлых отметок. Пары, зал и игры с братом не двигает.</p><div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px"><button class="btn primary" data-action="smartReplan">✦ Пересобрать</button><button class="btn" data-action="undoSmart">↶ Отменить</button><button class="btn" data-action="smartAdd">＋ Дело/дедлайн</button></div>${lastPlan?`<p class="tagline">Последний расчёт: ${lastPlan.scheduled||0} размещено, ${lastPlan.deferred||0} отложено</p>`:''}${pending.length?`<div class="wakeconflict">⚠ Не поместились ${pending.length} дел (обязательных ${pending.filter(x=>x.required).length}).</div>`:''}</div>`;
 if(pending.length){html+=`<div class="card compact">${pending.map(x=>`<div class="deadline-line"><b>${x.required?'⚠ ':''}${safe(x.name)}</b><small>${safe(x.reason)}</small><div style="display:flex;gap:6px;margin-top:4px"><button class="btn tight" data-action="restorePending" data-id="${safe(x.id)}">Вернуть</button><button class="btn tight" data-action="postponeTask" data-id="${safe(x.id)}">На завтра</button></div></div>`).join('')}</div>`;}
 html+=`<div class="subhead"><h2>Новое дело / дедлайн</h2></div><div class="card"><form id="smartTaskForm"><div class="form-group"><label>Название</label><input class="field" name="name" placeholder="Например, завершить курсовую" maxlength="160" required></div><div class="grid2"><div class="form-group"><label>Минут</label><input class="field" name="duration" type="number" min="10" max="2400" step="10" value="80" required></div><div class="form-group"><label>Крайний срок</label><input class="field" name="deadline" type="date" value="${shift(s,5)}" min="${s}" required></div></div><div class="grid2"><div class="form-group"><label>Категория</label><select class="field" name="cat"><option>Код</option><option>Математика</option><option>Университет</option><option>Быт</option><option>Отдых</option><option>Организация</option></select></div><div class="form-group"><label>Приоритет</label><select class="field" name="priority"><option value="4">Высокий</option><option value="3">Обычный</option><option value="2">Низкий</option></select></div></div><button type="submit" class="btn primary" style="margin-top:8px">✦ Найти окна и добавить</button><p class="tagline">Длинная задача делится на блоки до 40 минут.</p></form></div>`;
 html+=`<div class="subhead"><h2>Повторяющиеся</h2></div><div class="card"><form id="repeatForm"><div class="form-group"><label>Дело</label><input class="field" name="name" placeholder="Например, лёгкая уборка" maxlength="160" required></div><div class="grid2"><div class="form-group"><label>Каждые N дней</label><input class="field" name="interval" type="number" min="1" max="90" value="2"></div><div class="form-group"><label>Минут</label><input class="field" name="duration" type="number" min="5" max="180" value="15"></div></div><button type="submit" class="btn" style="margin-top:8px">＋ Добавить и запланировать</button></form></div>`;
 if(deadlines.length)html+=`<div class="sectiontitle">Дедлайны</div><div class="card compact">${deadlines.map(t=>`<div class="deadline-line"><b>${safe(t.name)}</b><small>до ${safe(t.deadlineDate)} · ${safe(t.start)}</small></div>`).join('')}</div>`;
 html+=`<div class="subhead"><h2>Напоминания iPhone</h2></div><div class="card"><p class="infotext">Открытое приложение напомнит заранее; для системных уведомлений надёжнее экспорт в Календарь.</p><div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px"><button class="btn" data-action="notificationPermission">🔔 Уведомления</button><button class="btn primary" data-action="ics7">📅 7 дней</button><button class="btn" data-action="ics14">14 дней</button></div></div>`;
 html+=`<div class="subhead"><h2>Планировщик 2.0</h2></div><div class="card"><p class="infotext">${insightsText().slice(0,2).map(x=>safe(x)).join(' ')}</p><button class="btn tight" data-action="tab" data-tab="more" style="margin-top:6px">Ещё →</button></div>`;
 return html;
}
settingsView=function(){let html=rawSettingsView();let add=`<div class="subhead"><h2>Уведомления iPhone</h2></div><div class="card" id="pushCard"><p class="infotext" id="pushStatus">Проверяю поддержку Web Push…</p><div class="task-conflict-actions" id="pushActions" style="margin-top:6px"><button class="btn primary" data-push="enable">Включить</button><button class="btn" data-push="test">Проверить уведомление</button><button class="btn" data-push="off">Отключить</button></div><div class="eyebrow" style="margin-top:10px">Напомнить за</div><div class="task-conflict-actions" id="pushLead"><button class="btn tight" data-push-lead="0">0 мин</button><button class="btn tight" data-push-lead="5">5 мин</button><button class="btn tight" data-push-lead="10">10 мин</button><button class="btn tight" data-push-lead="15">15 мин</button></div><p class="tagline" id="pushHint">Push приходит на заблокированный iPhone только для PWA, добавленной на экран «Домой». Сервер отправляет по Cron; точность — около минуты, не секунды. Подробный текст можно скрыть в iOS.</p></div><div class="subhead"><h2>Уход за волосами</h2></div><div class="card"><p class="infotext">Отметь два дня лечебного шампуня; в остальные дни по твоему обычному режиму — мягкий. Менять частоту лечения следует по инструкции к средству.</p><div class="day-checkboxes">${WEEKDAYS.map((d,i)=>`<label><input type="checkbox" data-shampoo-day="${i}" ${(S.shampooDays||[]).includes(i)?'checked':''}> ${d}</label>`).join('')}</div><button class="btn" data-action="saveShampoo">Сохранить дни</button></div><div class="subhead"><h2>Приватность и уведомления</h2></div><div class="card infotext">История выполнения, события и локальная модель не отправляются на GitHub. Они сохраняются в хранилище приложения на iPhone. Но исходное расписание и привычки больше не входят в файлы сайта: они загружаются один раз с твоего сервера по токену и хранятся только на устройстве. Push-напоминания отправляет сервер по Cron; если сервер не настроен, доступен экспорт в календарь.</div><div class="subhead"><h2>Техническая версия</h2></div><div class="card infotext">JARVIS Routine v49.2 · точное время повторяющихся дел, вложенные задачи, диагностика Web Push, cinematic 3D AURA/FLUID.</div>`;
 return html.replace('<div class="subhead"><h2>Резервная копия</h2>',add+'<div class="subhead"><h2>Резервная копия</h2>');
};


function openHabitDialog(h){
 const edit=!!(h&&h.id),days=(h&&Array.isArray(h.days))?h.days:[];
 const opt=m=>`<option value="${m}" ${edit&&h.mode===m?'selected':''}>${m==='daily'?'Каждый день':m==='everyN'?'Каждые N дней':'Раз в неделю (выбранные дни)'}</option>`;
 let html=`<div class="modalhead"><h2>${edit?'Изменить привычку':'Новая привычка'}</h2><button class="iconbtn" data-action="close">×</button></div><form id="habitForm"><input type="hidden" name="habitId" value="${edit?safe(h.id):''}"><div class="formgroup"><label>Что делать</label><input class="field" name="name" placeholder="Например, протереть пыль" required maxlength="100" value="${edit?safe(h.name):''}"></div><div class="formgroup"><label>Примечание</label><input class="field" name="sub" placeholder="5–10 минут после учёбы" value="${edit?safe(h.sub||''):''}"></div><div class="formgroup"><label>Периодичность</label><select class="field" name="mode">${opt('daily')}${opt('everyN')}${opt('weekly')}</select></div><div class="formgroup"><label>N дней (для выбранной периодичности)</label><input class="field" name="interval" type="number" min="1" max="90" value="${edit&&h.mode==='everyN'?(Number(h.interval)||2):2}"></div><div class="formgroup"><label>Дни недели для недельной привычки</label><div class="day-checkboxes">${WEEKDAYS.map((d,i)=>`<label><input type="checkbox" name="day${i}" ${edit?(days.includes(i)?'checked':''):(i===6?'checked':'')}> ${d}</label>`).join('')}</div></div><button class="btn primary" type="submit">${edit?'Сохранить':'Создать привычку'}</button>${edit?`<button class="btn tight" type="button" data-action="archiveHabit" data-id="${safe(h.id)}" style="margin-top:6px">Убрать в архив</button>`:''}</form>`;
 document.querySelector('#modalbox').innerHTML=html;document.querySelector('#modalback').classList.add('show');
}
function sqlString(x){return x==null?'NULL':"'"+String(x).replaceAll("'","''")+"'"}
function downloadFile(name,content,type){let blob=new Blob([content],{type}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name;document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),4000)}
function exportSQL(){
 const lines=[`-- JARVIS Routine ${VERSION}. SQLite-compatible SQL export (generated locally).`,`BEGIN TRANSACTION;`,`CREATE TABLE IF NOT EXISTS events(eid TEXT PRIMARY KEY, at TEXT, date TEXT, type TEXT, task_id TEXT, title TEXT, category TEXT, planned_start TEXT, actual_start TEXT, actual_duration INTEGER, wake TEXT, meta_json TEXT);`,`CREATE TABLE IF NOT EXISTS daily_wake(date TEXT PRIMARY KEY, wake_time TEXT);`,`CREATE TABLE IF NOT EXISTS task_ticks(date TEXT, task_id TEXT, completed INTEGER, PRIMARY KEY(date,task_id));`,`CREATE TABLE IF NOT EXISTS habit_ticks(date TEXT, habit_id TEXT, completed INTEGER, PRIMARY KEY(date,habit_id));`,`CREATE TABLE IF NOT EXISTS entertainment(date TEXT PRIMARY KEY,tiktok_minutes INTEGER,serial_minutes INTEGER);`,`CREATE TABLE IF NOT EXISTS user_tasks(id TEXT PRIMARY KEY,title TEXT,category TEXT,start_date TEXT,start_time TEXT,end_time TEXT,repeat_mode TEXT,deadline_date TEXT,priority INTEGER);`];
 for(const e of S.events){let meta={...e};for(let k of ['eid','at','date','type','taskId','title','category','plannedStart','actualStart','actualDuration','wake'])delete meta[k];
   lines.push(`INSERT OR REPLACE INTO events VALUES(${[e.eid,e.at,e.date,e.type,e.taskId,e.title,e.category,e.plannedStart,e.actualStart||'',Number(e.actualDuration)||null,e.wake,JSON.stringify(meta)].map((v,i)=>i===9&&v!==null?Number(v):sqlString(v)).join(',')});`)}
 for(const [date,wake] of Object.entries(S.wakeTimes||{}))lines.push(`INSERT OR REPLACE INTO daily_wake VALUES(${sqlString(date)},${sqlString(wake)});`);
 for(const [date,ticks] of Object.entries(S.done||{}))for(const [id,val] of Object.entries(ticks))lines.push(`INSERT OR REPLACE INTO task_ticks VALUES(${sqlString(date)},${sqlString(id)},${val?1:0});`);
 for(const [date,ticks] of Object.entries(S.habits||{}))for(const [id,val] of Object.entries(ticks))lines.push(`INSERT OR REPLACE INTO habit_ticks VALUES(${sqlString(date)},${sqlString(id)},${val?1:0});`);
 for(const [date,logs] of Object.entries(S.logs||{}))lines.push(`INSERT OR REPLACE INTO entertainment VALUES(${sqlString(date)},${Number(logs.tiktok)||0},${Number(logs.serial)||0});`);
 for(const x of S.extras||[])lines.push(`INSERT OR REPLACE INTO user_tasks VALUES(${[x.id,x.name,x.cat,x.fromDate,x.start,x.end,x.repeat,x.deadlineDate].map(sqlString).join(',')},${Number(x.priority)||3});`);
 lines.push('COMMIT;');downloadFile('jarvis-routine-'+today()+'.sql',lines.join('\n'),'application/sql;charset=utf-8');toast('SQL-экспорт готов');
}
function exportCSV(){const headers=['eid','at','date','type','title','category','plannedStart','actualStart','actualDuration','wake'];let rows=[headers.join(',')];for(const e of S.events)rows.push(headers.map(k=>'"'+String(e[k]??'').replaceAll('"','""')+'"').join(','));downloadFile('jarvis-events-'+today()+'.csv',rows.join('\r\n'),'text/csv;charset=utf-8')}
function icsEscape(str){return String(str??'').replaceAll('\\','\\\\').replaceAll('\n','\\n').replaceAll(',','\\,').replaceAll(';','\\;')}
function icsLocal(s,time){let h=minutesHM(time),d=s;if(h<5*60||h>=24*60){d=shift(s,1);h=h%1440}return d.replaceAll('-','')+'T'+String(Math.floor(h/60)).padStart(2,'0')+String(h%60).padStart(2,'0')+'00'}
function exportCalendar(days){
 let lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//JARVIS Routine//RU','CALSCALE:GREGORIAN','METHOD:PUBLISH','X-WR-CALNAME:JARVIS Routine'];
 let count=0;
 for(let i=0;i<days;i++){let date=shift(today(),i);for(let t of itemList(date)){
   if(!isCheckable(t)||(!(isRequired(t)||isFixed(t,date))))continue;
   let key=`jarvis-${date}-${t.id}`.replace(/[^a-zA-Z0-9-]/g,'-');
   lines.push('BEGIN:VEVENT',`UID:${key}@jarvis-routine.local`,`DTSTAMP:${new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'')}`,`DTSTART:${icsLocal(date,t.start)}`,`DTEND:${icsLocal(date,t.end)}`,`SUMMARY:${icsEscape(t.name)}`,`DESCRIPTION:${icsEscape(t.note||'JARVIS Routine')}`,'BEGIN:VALARM','TRIGGER:-PT10M','ACTION:DISPLAY',`DESCRIPTION:${icsEscape(t.name)}`,'END:VALARM','END:VEVENT');count++;
 }}lines.push('END:VCALENDAR');downloadFile('jarvis-routine-'+days+'days.ics',lines.join('\r\n')+'\r\n','text/calendar;charset=utf-8');toast(`Календарь: ${count} событий; импортируй в Apple Calendar`);
}
async function requestNotifications(){
 if(!('Notification' in window)){toast('Уведомления браузера недоступны; используй файл календаря');return;}
 try{const x=await Notification.requestPermission();if(x==='granted'){S.reminders.enabled=true;persist();toast('Разрешено. Пока приложение открыто, будут напоминания.')}else toast('Уведомления не разрешены — доступен экспорт в календарь');}catch(e){toast('В iPhone установи сайт на экран «Домой» или используй календарь')}
}
async function showTaskNotification(title,body){
 if(!S.reminders.enabled||!('Notification' in window)||Notification.permission!=='granted')return;
 try{if(navigator.serviceWorker){let r=await navigator.serviceWorker.ready;await r.showNotification(title,{body,icon:'./icon-192.png',tag:'jr-reminder-'+Date.now()});}else new Notification(title,{body});}catch(err){toast(title+': '+body)}
}
function checkReminders(){
 if(document.visibilityState!=='visible'||ui.date!==today()||!S.reminders.enabled)return;
 let now=new Date(),minute=now.getHours()*60+now.getMinutes();
 let s=today(),limit=S.reminders.minutes||10;
 for(const t of itemList(s)){
   if(!isRequired(t)||done(s,t.id))continue;
   let before=clock(t.start)-minute;
   if(before>limit||before<0)continue;
   let k=datekey(s,t.id),stamp=s+'-'+t.start;
   if(S.reminders.last[k]===stamp)continue;
   S.reminders.last[k]=stamp;persist();showTaskNotification('Скоро: '+t.name,`Через ${before} мин · ${t.start}`);
 }
}

// Gather learning examples only from user action, not guessed completion or passive observation.
document.addEventListener('change',e=>{
 if(e.target.id==='wakeSlider'){
   const s=ui.date;logEvent('wake',s,null,{time:wakeTime(s)});smartReplan(s,{silent:true});toast('Подъём учтён: гибкие дела перепланированы');
 }
 if(e.target.matches('input[data-id][data-date]')){
   const s=e.target.dataset.date,id=e.target.dataset.id,t=itemList(s).find(x=>x.id===id);if(!t)return;
   if(e.target.checked){
     const started=S.activeTasks?.[datekey(s,id)];let actualDuration=started?Math.round((Date.now()-started)/60000):null;
     if(actualDuration!=null&&(actualDuration<=0||actualDuration>480))actualDuration=null;
     logEvent('complete',s,t,{actualStart:started?niceTime(new Date(started).getHours()*60+new Date(started).getMinutes()):recentTime(),actualDuration});
     if(S.activeTasks)delete S.activeTasks[datekey(s,id)];
   }else logEvent('uncheck',s,t);
 }
 if(e.target.matches('input[data-habit][data-date]')){
   logEvent(e.target.checked?'habit_done':'habit_undo',e.target.dataset.date,null,{habitId:e.target.dataset.habit});
 }
 if(e.target.matches('input[data-shampoo-day]')){/* settings save handled on button */}
});

document.addEventListener('submit',e=>{
 if(e.target.id==='smartTaskForm'){
   e.preventDefault();let f=Object.fromEntries(new FormData(e.target).entries()),total=Number(f.duration),name=f.name.trim(),deadline=f.deadline,cat=f.cat||'Организация',priority=Number(f.priority)||4;
   if(!name||!deadline||!Number.isFinite(total)){toast('Проверь название, длительность и дату');return}
   const proposal=suggestDeadline(name,deadline,total,cat,priority);
   if(proposal.error){toast(proposal.error);return}
   if(!proposal.slots.length){toast('Не найдено места до срока; попробуй увеличить дедлайн или изменить план');return}
   const group='project_'+Date.now().toString(36);
   for(let i=0;i<proposal.slots.length;i++){
     let p=proposal.slots[i],id='x_'+Date.now().toString(36)+'_'+i;
     S.extras.push({id,groupId:group,name:proposal.slots.length>1?`${name} · ${i+1}/${proposal.slots.length}`:name,start:p.start,end:p.end,cat,status:'Обязательно',note:`Автоматически подобрано. Дедлайн ${deadline}`,fromDate:p.date,deadlineDate:deadline,repeat:'once',priority});
   }
   logEvent('deadline_added',ui.date,null,{title:name,deadline,plannedBlocks:proposal.slots.length,leftMinutes:proposal.left});render();toast(`Добавлено ${proposal.slots.length} блоков${proposal.left?`; ${proposal.left} мин не уместились`:''}. Проверь план.`);if(proposal.left)alert('Не всё удалось разместить до дедлайна: '+proposal.left+' минут. Убери менее важные дела или поставь блок вручную.');
 }
 if(e.target.id==='repeatForm'){
   e.preventDefault();let f=Object.fromEntries(new FormData(e.target).entries()),name=f.name.trim(),interval=clamp(Number(f.interval)||2,1,90),durationM=clamp(Number(f.duration)||15,5,180);
   let tpl={id:'x_'+Date.now().toString(36),name,start:'16:00',end:niceTime(16*60+durationM),cat:'Быт',status:'План',note:`Каждые ${interval} дн. · переносимо`,fromDate:ui.date,repeat:'everyN',intervalDays:interval,priority:3};
   const suggestions=automaticallyPlaceTask(tpl,shift(ui.date,Math.min(14,interval+1)));
   if(suggestions.length){tpl.start=suggestions[0].start;tpl.end=suggestions[0].end;}
   S.extras.push(tpl);logEvent('recurring_added',ui.date,tpl,{interval});render();toast(`Добавлено: ${name} каждые ${interval} дн.`);
 }
 if(e.target.getAttribute('id')==='habitForm'){
   e.preventDefault();let f=Object.fromEntries(new FormData(e.target).entries()),name=f.name.trim(),mode=f.mode,interval=clamp(Number(f.interval)||2,1,90),days=WEEKDAYS.map((_,i)=>i).filter(i=>f['day'+i]);
   if(!name)return;const id=f.habitId;
   if(id){const h=S.customHabits.find(x=>x.id===id);if(h){h.name=name;h.sub=f.sub;h.mode=mode;h.interval=interval;h.days=days;}}
   else{S.customHabits.push({id:'h_'+Date.now().toString(36),name,sub:f.sub,mode,interval,days,fromDate:ui.date});}
   persist();modalClose();render();toast(id?'Привычка обновлена':'Привычка добавлена');
 }
});

document.addEventListener('click',e=>{
 let el=e.target.closest('[data-action]');if(!el)return;
 const a=el.dataset.action,s=ui.date,id=el.dataset.id;
 if(a==='smartReplan'){const f=window.JarvisFlip;f?f(()=>smartReplan(s)):smartReplan(s);}
 else if(a==='undoSmart'){const f=window.JarvisFlip;f?f(()=>revertPlan(s)):revertPlan(s);}
 else if(a==='shiftTask'){const f=window.JarvisFlip;f?f(()=>moveTask(s,id,Number(el.dataset.min))):moveTask(s,id,Number(el.dataset.min));}
 else if(a==='swap'){if(Date.now()<suppressSwapClickUntil)return;if(!swapFirst){swapFirst=id;toast('Теперь нажми «Обмен» на другом деле')}else if(swapFirst===id){swapFirst=null;toast('Обмен отменён')}else swapTasks(s,swapFirst,id);}
 else if(a==='postponeTask'){const f=window.JarvisFlip;f?f(()=>postponeTask(s,id)):postponeTask(s,id);}
 else if(a==='restorePending'){if(S.dayAdjust[s])delete S.dayAdjust[s][id];S.pending[s]=(S.pending[s]||[]).filter(x=>x.id!==id);persist();render();toast('Дело возвращено; проверь пересечения')}
 else if(a==='skipTask'){let t=itemList(s).find(x=>x.id===id);if(t&&!isFixed(t,s)&&confirm('Отметить это дело как пропущенное сегодня?')){(S.dayAdjust[s]||={})[id]={omit:true};logEvent('skip',s,t,{actualStart:recentTime()});render()}}
 else if(a==='skipSession'){let t=itemList(s).find(x=>x.id===id);if(t&&isOptionalClass(t)&&confirm('Отметить сегодня эту пару как свободный блок? Убедись, что нет сдачи или контрольной.')){(S.dayAdjust[s]||={})[id]={omit:true};logEvent('class_absent',s,t,{selfReported:true});smartReplan(s);}}
 else if(a==='taskStart'){
   let t=itemList(s).find(t=>t.id===id);if(!t)return;
   S.activeTasks||={};let key=datekey(s,id);
   if(S.activeTasks[key]){toast('Таймер уже запущен · отметь дело выполненным по завершении')}else{S.activeTasks[key]=Date.now();logEvent('start',s,t,{actualStart:recentTime()});toast('Записал фактическое начало '+recentTime())}render();
 }
 else if(a==='refreshMemory'){refreshMemory();toast('Память обновлена');}
  else if(a==='clearMemory'){if(confirm('Сбросить все накопленные наблюдения JARVIS? Расписание и отметки останутся.')){S.memory={profile:{},observations:[],version:1};persist();render();toast('Наблюдения сброшены')}}
  else if(a==='resolveConflicts'){const plan=buildSmartPlan(ui.date);showConflictCard(plan);}
  else if(a==='smartAdd'){ui.tab='planner';render();setTimeout(()=>document.querySelector('[name="name"]')?.focus(),50)}
 else if(a==='addHabit')openHabitDialog();
 else if(a==='habitPeriod'){ui.habitPeriod=Number(id)===30?30:7;render();}
 else if(a==='editHabit'){let h=S.customHabits.find(t=>t.id===id);if(h)openHabitDialog(h);}
 else if(a==='archiveHabit'){let h=S.customHabits.find(t=>t.id===id);if(h&&!h.archived){h.archived=true;persist();modalClose();render();toast('Привычка в архиве. Отметки сохранены.')}}
 else if(a==='restoreHabit'){let h=S.customHabits.find(t=>t.id===id);if(h){h.archived=false;persist();render();toast('Привычка возвращена')}}
 else if(a==='delHabit'){let h=S.customHabits.find(t=>t.id===id);if(h&&confirm(`Удалить привычку «${h.name}» навсегда? Старые отметки останутся в истории.`)){S.customHabits=S.customHabits.filter(x=>x.id!==id);persist();render()}}
 else if(a==='saveShampoo'){let days=Array.from(document.querySelectorAll('[data-shampoo-day]:checked')).map(x=>Number(x.dataset.shampooDay));if(days.length>3){toast('Выбери не более трёх дней лечебного шампуня');return}S.shampooDays=days;persist();render();toast('Чередование шампуней обновлено')}
 else if(a==='exportSQL')exportSQL();
 else if(a==='exportCSV')exportCSV();
 else if(a==='ics7')exportCalendar(7);
 else if(a==='ics14')exportCalendar(14);
 else if(a==='notificationPermission')requestNotifications();
},false);

// Importing a prior backup needs new fields initialized (the old handler replaces S object).
document.addEventListener('change',e=>{if(e.target.id==='importFile')setTimeout(()=>{S.dayAdjust||={};S.planUndo||={};S.pending||={};S.events||=[];S.customHabits||=[];S.shampooDays||=[1,5];S.reminders||={enabled:false,minutes:10,last:{}};mirrorEvents();render()},500)},false);

// Optional touch drag on the ↕ handle: drop onto another task to swap their start times.
let dragInfo=null;
document.addEventListener('pointerdown',e=>{
 const handle=e.target.closest('[data-action="swap"]');if(!handle)return;
 dragInfo={id:handle.dataset.id,date:ui.date,x:e.clientX,y:e.clientY,moved:false};
});
document.addEventListener('pointermove',e=>{
 if(!dragInfo)return;
 if(Math.hypot(e.clientX-dragInfo.x,e.clientY-dragInfo.y)>12)dragInfo.moved=true;
});
document.addEventListener('pointerup',e=>{
 if(!dragInfo)return;
 let source=dragInfo;dragInfo=null;if(!source.moved)return;
 suppressSwapClickUntil=Date.now()+500;
 const el=document.elementFromPoint?.(e.clientX,e.clientY);
 const target=el?.closest?.('.task');const button=target?.querySelector?.('[data-action="swap"]');
 if(button&&button.dataset.id!==source.id){swapTasks(source.date,source.id,button.dataset.id);}
 else toast('Перетащи ↕ на другую карточку или нажми «Обмен» дважды');
});

// Chrome/Safari can freeze background timers; check actual wall clock on visibility regain.
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){checkReminders();timerTick()}});
setInterval(checkReminders,20000);
mirrorEvents();
render();

/* ── Public planner API ──
   This file runs inside its own scope, while the AI layer (ai.js) has its own.
   Without these exports the deterministic local planner is unreachable from
   ai.js, so a "rebuild the rest of the day" request falls through to the model
   and returns a truncated JSON reply. Free, offline, no API call involved. */
window.buildSmartPlan=buildSmartPlan;
window.smartReplan=smartReplan;
window.currentHabits=currentHabits;
window.revertPlan=revertPlan;
window.plannerIsFixed=(t,s)=>isFixed(t,s);
window.plannerReady=true;
})();
