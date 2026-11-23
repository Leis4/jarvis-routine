/* JARVIS Routine 3.0 — AI UI / cloud / push integration for original v2 scheduler.
   Privacy: the app does NOT talk to a server until the user configures and opts in.
   The Qwen API key NEVER appears in the client. No silent AI modifications. */
(() => {
'use strict';
const CONFIG_KEY='jarvis_routine_ai_v3';
const HISTORY_KEY='jarvis_routine_ai_history_local_v1';
function loadHistory(){try{const v=JSON.parse(localStorage.getItem(HISTORY_KEY)||'[]');return Array.isArray(v)?v.slice(-35).filter(m=>['user','assistant'].includes(m.role)&&typeof m.content==='string'):[]}catch{return []}}

const load=()=>{try{return JSON.parse(localStorage.getItem(CONFIG_KEY)||'{}')}catch{return {}}};
const A={url:'',token:'',mode:'auto',autonomy:'off',connected:false,cloudVersion:0,sync:false,pushEnabled:false,autoBrief:false,history:[],chats:[],chatId:'',draft:'',image:'',_animCount:-1,proposals:[],insights:null,status:'',busy:false,showConfig:false,...load()};
A.history=loadHistory();A.proposals=[];A.insights=null;A.connected=false;A.busy=false;A.cloudVersion=0;A.status='';A.showConfig=false;
const CHATS_KEY='jarvis_qwen_chats_v1';
function slimHistory(msgs){return (msgs||[]).slice(-35).map(m=>({role:m.role,model:m.model||'',content:String(m.content||'').slice(0,1800)}))}
function saveChats(){try{localStorage.setItem(CHATS_KEY,JSON.stringify({active:A.chatId,list:(A.chats||[]).map(c=>({id:c.id,title:c.title,createdAt:c.createdAt,updatedAt:c.updatedAt,messages:slimHistory(c.messages)}))}))}catch{}}
function persistHistory(){const slim=slimHistory(A.history);try{localStorage.setItem(HISTORY_KEY,JSON.stringify(slim))}catch{}const c=(A.chats||[]).find(x=>x.id===A.chatId);if(c){c.messages=A.history.slice(-2000);c.updatedAt=Date.now();if(!c.title||c.title==='Новый чат'){const u=A.history.find(m=>m.role==='user');if(u)c.title=String(u.content).replace(/\s+/g,' ').slice(0,42);}saveChats();try{if(window.JarvisChatStore)window.JarvisChatStore.mirrorChat({...c,messages:A.history});}catch(e){}}}
(function initChats(){let store=null;try{store=JSON.parse(localStorage.getItem(CHATS_KEY)||'null')}catch{}const hadLocal=!!(store&&Array.isArray(store.list)&&store.list.length);A._hadLocal=hadLocal;if(hadLocal){A.chats=store.list.map(c=>({id:c.id,title:c.title||'Чат',createdAt:c.createdAt||Date.now(),updatedAt:c.updatedAt||Date.now(),messages:Array.isArray(c.messages)?c.messages:[]}));A.chatId=store.active&&A.chats.some(c=>c.id===store.active)?store.active:A.chats[0].id;const c=A.chats.find(x=>x.id===A.chatId)||A.chats[0];A.chatId=c.id;A.history=slimHistory(c.messages);}else{A.chats=[{id:'c_'+Date.now().toString(36),title:'Новый чат',createdAt:Date.now(),updatedAt:Date.now(),messages:slimHistory(A.history)}];A.chatId=A.chats[0].id;saveChats();}
 setTimeout(function(){try{if(window.JarvisChatStore){window.JarvisChatStore.init().then(db=>{if(!db)return;if(hadLocal){window.JarvisChatStore.migrateLegacy(A.chats);}else{window.JarvisChatStore.loadAll().then(remote=>{if(remote&&remote.length&&!A._adopted){A._adopted=true;A.chats=remote.map(c=>({id:c.id,title:c.title||'Чат',createdAt:c.createdAt||Date.now(),updatedAt:c.updatedAt||Date.now(),messages:Array.isArray(c.messages)?c.messages:[]}));A.chatId=A.chats[0].id;A.history=(A.chats[0].messages||[]).slice(-60);saveChats();try{render()}catch(e){}}});}});}}catch(e){}},0);})();
window.addEventListener('load',function(){try{if(!window.JarvisChatStore)return;window.JarvisChatStore.init().then(function(){if(A._hadLocal){return window.JarvisChatStore.migrateLegacy(A.chats).then(function(){return window.JarvisChatStore.loadChat(A.chatId)}).then(function(full){if(full&&full.length>A.history.length){A.history=full;try{render()}catch(e){}}});}if(A._adopted)return;return window.JarvisChatStore.loadAll().then(function(remote){if(remote&&remote.length){A._adopted=true;A.chats=remote.map(c=>({id:c.id,title:c.title||'Чат',createdAt:c.createdAt||Date.now(),updatedAt:c.updatedAt||Date.now(),messages:Array.isArray(c.messages)?c.messages:[]}));A.chatId=A.chats[0].id;A.history=(A.chats[0].messages||[]).slice(-60);saveChats();try{render()}catch(e){}}});});}catch(e){}});
const persistA=()=>localStorage.setItem(CONFIG_KEY,JSON.stringify({url:A.url,token:A.token,mode:A.mode,autonomy:A.autonomy,sync:A.sync,pushEnabled:A.pushEnabled,autoBrief:A.autoBrief}));
const esc=s=>safe(String(s??''));
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
document.addEventListener('click',e=>{const el=e.target.closest&&e.target.closest('[data-chat]');if(!el)return;e.preventDefault();const a=el.dataset.chat,id=el.dataset.id;if(a==='close'){if(typeof modalClose==='function')modalClose();return}if(a==='new'){newChat();openChats();return}if(a==='switch'){switchChat(id);if(typeof modalClose==='function')modalClose();return}if(a==='rename'){renameChat(id);return}if(a==='delete'){deleteChat(id);return}if(a==='export'){exportChat(id);return}});
try{window.JarvisChats={list:()=>(A.chats||[]).map(c=>({id:c.id,title:c.title,messages:(c.messages||[]).length})),active:()=>A.chatId};}catch(e){}
function apiURL(){if(!A.url)throw Error('Сначала введи адрес Cloudflare Worker');const u=new URL(A.url);if(u.protocol!=='https:'&&u.hostname!=='localhost')throw Error('Сервер должен использовать HTTPS');return u.origin;}
async function call(path,{method='GET',body,signal}={}){
 const root=apiURL();if(!A.token||A.token.length<24)throw Error('Введи токен доступа APP_ACCESS_TOKEN');
 const c=new AbortController(),timeout=setTimeout(()=>c.abort(),50000);
 const onAbort=()=>{try{c.abort()}catch(e){}};
 if(signal)signal.addEventListener('abort',onAbort);
 try{
  const r=await fetch(root+path,{method,headers:{'Authorization':'Bearer '+A.token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:c.signal,cache:'no-store'});
  let data=await r.json().catch(()=>({error:'Сервер вернул неподдерживаемый ответ'}));
  if(!r.ok){const err=new Error(data.error||'HTTP '+r.status);err.status=r.status;err.remoteVersion=data.version;throw err;}return data;
 }catch(e){if(signal&&signal.aborted){const err=new Error('Остановлено');err.name='AbortError';throw err;}if(e.name==='AbortError')throw Error('Истекло время ожидания сервера');throw e}finally{clearTimeout(timeout);if(signal)signal.removeEventListener('abort',onAbort)}
}
function indicator(){return A.connected?`<span class="ai-chip ok">●</span>`:`<span class="ai-chip fail">○</span>`}
function openChats(){
 const mb=document.getElementById('modalbox'),back=document.getElementById('modalback');if(!mb||!back)return;
 const list=(A.chats||[]).slice().sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));
 const rows=list.map(c=>`<div class="chat-row ${c.id===A.chatId?'sel':''}" data-chat="switch" data-id="${esc(c.id)}"><div class="grow"><b>${esc(c.title||'Новый чат')}</b><small>${new Date(c.updatedAt||Date.now()).toLocaleString('ru-RU',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})} · ${(c.messages||[]).length} сообщ.</small></div><i class="ch" data-chat="rename" data-id="${esc(c.id)}" role="button" aria-label="Переименовать" title="Переименовать">✎</i><i class="ch" data-chat="export" data-id="${esc(c.id)}" role="button" aria-label="Экспорт" title="Экспорт">↓</i><i class="ch" data-chat="delete" data-id="${esc(c.id)}" role="button" aria-label="Удалить" title="Удалить">✕</i></div>`).join('');
 mb.innerHTML=`<div class="modalhead"><h2>Чаты Qwen</h2><button class="iconbtn" data-chat="close" aria-label="Закрыть">×</button></div><div class="chat-actions"><button class="btn primary" data-chat="new">＋ Новый чат</button><input class="field" id="chatSearch" placeholder="Поиск по чатам…" autocomplete="off"></div><div class="chat-list">${rows||'<p class="tagline">Пока нет чатов.</p>'}</div>`;
 back.classList.add('show');back.setAttribute('aria-hidden','false');
 const s=document.getElementById('chatSearch');if(s)s.addEventListener('input',()=>{const q=s.value.trim().toLowerCase();list.forEach(c=>{const row=mb.querySelector(`.chat-row[data-id="${c.id}"]`);if(!row)return;const hay=[c.title||'',...(c.messages||[]).map(m=>m.content||'')].join(' ').toLowerCase();row.style.display=!q||hay.includes(q)?'':'none';});});
}
async function switchChat(id){const c=(A.chats||[]).find(x=>x.id===id);if(!c)return;persistHistory();A.draft='';A.chatId=id;A.history=slimHistory(c.messages);try{if(window.JarvisChatStore){const full=await window.JarvisChatStore.loadChat(id);if(full&&full.length>A.history.length)A.history=full;}}catch(e){}persistHistory();render();}
function newChat(){persistHistory();A.draft='';const id='c_'+Date.now().toString(36);A.chats.push({id,title:'Новый чат',createdAt:Date.now(),updatedAt:Date.now(),messages:[]});A.chatId=id;A.history=[];saveChats();render();}
function renameChat(id){const c=(A.chats||[]).find(x=>x.id===id);if(!c)return;const t=prompt('Название чата',c.title||'Новый чат');if(t!=null&&t.trim()){c.title=t.trim().slice(0,60);saveChats();openChats();}}
async function deleteChat(id){const c=(A.chats||[]).find(x=>x.id===id);if(!c)return;if(!confirm('Удалить чат «'+(c.title||'Новый чат')+'»?'))return;let ok=true;try{if(window.JarvisChatStore)ok=await window.JarvisChatStore.deleteChat(id);}catch(e){ok=false;}if(!ok){try{toast('Не удалось удалить чат из хранилища')}catch(e){};return;}A.chats=A.chats.filter(x=>x.id!==id);if(A.chatId===id){A.chatId=A.chats[0]?A.chats[0].id:'';A.history=A.chats[0]?slimHistory(A.chats[0].messages):[];}if(!A.chats.length){A.chats=[{id:'c_'+Date.now().toString(36),title:'Новый чат',createdAt:Date.now(),updatedAt:Date.now(),messages:[]}];A.chatId=A.chats[0].id;A.history=[];}saveChats();openChats();render();}
async function exportChat(id){const c=(A.chats||[]).find(x=>x.id===id);if(!c)return;let msgs=null,full=false;try{if(window.JarvisChatStore){msgs=await window.JarvisChatStore.loadChat(id);full=!!msgs;}}catch(e){}if(!full){msgs=c.messages||[];try{toast('Полная история недоступна — экспортируется рабочая копия')}catch(e){}}const blob=new Blob([JSON.stringify({title:c.title,messages:msgs,full:full},null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='jarvis-chat-'+(c.title||c.id).replace(/[^\w-]+/g,'_')+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),3000);}
function aiStop(){try{if(A.abort)A.abort.abort()}catch(e){}try{toast('Остановлено')}catch(e){}}
function aiMic(){
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR){try{toast('Голосовой ввод недоступен в этом браузере')}catch(e){}return}
  try{
    const rec=new SR();rec.lang='ru-RU';rec.interimResults=false;rec.maxAlternatives=1;
    rec.onresult=e=>{const t=Array.from(e.results).map(r=>r[0].transcript).join(' ');if(t){A.draft=(A.draft?A.draft+' ':'')+t;const ta=document.querySelector('#aiPrompt');if(ta)ta.value=A.draft;}};
    rec.onerror=()=>{try{toast('Не удалось распознать речь')}catch(e){}};
    rec.onend=()=>{try{toast('Голос добавлен в текст')}catch(e){}};
    rec.start();try{toast('Слушаю…')}catch(e){}
  }catch(e){try{toast('Микрофон недоступен')}catch(_){}}
}
function aiSpeak(){
  try{
    const synth=window.speechSynthesis;if(!synth){try{toast('Озвучивание недоступно')}catch(e){};return}
    if(synth.speaking){synth.cancel();return}
    const last=A.history.slice().reverse().find(m=>m.role==='assistant');if(!last){try{toast('Нет ответа для озвучивания')}catch(e){};return}
    const u=new SpeechSynthesisUtterance(String(last.content).slice(0,1200));u.lang='ru-RU';u.rate=1;synth.speak(u);
  }catch(e){try{toast('Озвучивание недоступно')}catch(_){}}
}
function aiAttach(){const el=document.getElementById('aiAttach');if(el)el.click();}
const AGENT_SYSTEM='Ты — JARVIS, персональный помощник. Отвечай по-русски, кратко и по делу. Используй инструменты, чтобы получить реальные данные расписания, привычек, памяти и свободных окон; никогда не выдумывай задачи, время или источники. Для изменений расписания или памяти вызывай propose_* и объясни, что применять нужно кнопкой; сам изменения не применяй. Если данных нет — скажи об этом.';
function agentToolDefs(){
  const defs=[];const schemas=(window.JarvisTools&&window.JarvisTools.schemas)||{};
  for(const name of ['get_ui_context','get_current_time','get_today','get_schedule','get_tasks','get_goals','get_habits','get_progress','find_free_time','search_memory','search_chats','get_planning_rules']){
    const sc=schemas[name];if(sc)defs.push({type:'function',function:{name,description:sc.description||name,parameters:sc.parameters||{type:'object',properties:{}}}});
  }
  const ui={navigate:{tab:'string'},open_date:{date:'string'},open_task:{id:'string'},open_habits:{},open_focus:{},open_settings:{},open_memory:{},select_wallpaper:{mode:'string'},set_motion_level:{level:'string'}};
  for(const [name,props] of Object.entries(ui))defs.push({type:'function',function:{name,description:'UI action: '+name,parameters:{type:'object',properties:Object.fromEntries(Object.entries(props).map(([k,t])=>[k,{type:t}]))}}});
  defs.push({type:'function',function:{name:'propose_day_replan',description:'Show a day replan preview (does not apply)',parameters:{type:'object',properties:{goal:{type:'string'}}}}});
  defs.push({type:'function',function:{name:'propose_memory',description:'Propose saving a confirmed memory (does not apply)',parameters:{type:'object',properties:{type:{type:'string'},content:{type:'string'}},required:['content']}}});
  return defs;
}
async function executeAgentTool(tc){
  const name=tc&&tc.function&&tc.function.name;let args={};try{args=JSON.parse((tc.function&&tc.function.arguments)||'{}')}catch(e){return {ok:false,error:'invalid_arguments'}}
  try{
    const T=window.JarvisTools,A2=window.JarvisActions,P=window.JarvisPlanner;
    if(T&&typeof T[name]==='function')return await T.run(name,args);
    if(name==='navigate')return {ok:!!(A2&&A2.navigate(args.tab))};
    if(name==='open_date')return {ok:!!(A2&&A2.open_date(args.date))};
    if(name==='open_task')return {ok:!!(A2&&A2.open_task(args.id))};
    if(name==='open_habits')return {ok:!!(A2&&A2.open_habits())};
    if(name==='open_focus')return {ok:!!(A2&&A2.open_focus())};
    if(name==='open_settings')return {ok:!!(A2&&A2.open_settings())};
    if(name==='open_memory')return {ok:!!(A2&&A2.open_memory())};
    if(name==='select_wallpaper')return {ok:!!(A2&&A2.select_wallpaper(args.mode))};
    if(name==='set_motion_level')return {ok:!!(A2&&A2.set_motion_level(args.level))};
    if(name==='propose_day_replan'){const pv=P&&P.previewOptimize(ui.date,{goal:args.goal||'balanced'});return {ok:!!pv,preview:true,changes:pv&&pv.changes?pv.changes.length:0}}
    if(name==='propose_memory'){try{if(window.JarvisMemory)window.JarvisMemory.proposeRemember(args.content,args.type)}catch(e){}return {ok:true,proposal:true,content:args.content}}
    return {ok:false,error:'unknown_tool'};
  }catch(e){return {ok:false,error:String(e&&e.message||e)}}
}
async function runAgent(message,imageUrl){
  const tools=agentToolDefs();
  const wantsSearch=/найди|исследуй|актуальн|интернет|документац|сравни|поиск/i.test(message);
  const prior=A.history.slice(-6).map(x=>({role:x.role,content:String(x.content||'').slice(0,1200)}));
  const userContent=imageUrl?[{type:'text',text:message},{type:'image_url',image_url:{url:imageUrl}}]:message;
  const messages=[{role:'system',content:AGENT_SYSTEM},...prior,{role:'user',content:userContent}];
  let usage={inputTokens:0,outputTokens:0,webSearchRequests:0};
  for(let step=0;step<6;step++){
    const data=await call('/api/ai/agent',{method:'POST',body:{messages,tools,webSearch:wantsSearch,tier:A.mode==='auto'?'flash':(A.mode||'flash'),maxToolCalls:6},signal:A.abort&&A.abort.signal});
    if(data&&data.usage){usage.inputTokens+=Number(data.usage.inputTokens)||0;usage.outputTokens+=Number(data.usage.outputTokens)||0;usage.webSearchRequests+=Number(data.usage.webSearchRequests)||0;}
    const msg=(data&&data.message)||{};const calls=Array.isArray(msg.tool_calls)?msg.tool_calls:[];
    if(calls.length){
      messages.push({role:'assistant',content:msg.content||null,tool_calls:calls});
      for(const tc of calls){
        A.status='Инструмент: '+((tc.function&&tc.function.name)||'?');try{render()}catch(e){}
        const result=await executeAgentTool(tc);
        messages.push({role:'tool',tool_call_id:String(tc.id||''),content:JSON.stringify(result).slice(0,6000)});
      }
      continue;
    }
    let answer=msg.content||'';
    const src=(data.annotations||[]).filter(a=>a&&a.type==='url_citation').slice(0,5);
    if(src.length){answer+='\n\nИсточники:\n'+src.map(a=>'• '+((a.url_citation&&a.url_citation.title)||'источник')+' — '+((a.url_citation&&a.url_citation.url)||'')).join('\n');}
    return {answer,usage,annotations:src};
  }
  return {answer:'Достигнут лимит шагов инструментов. Уточни запрос.',usage};
}
function aiView(){
 const bubble=(x,isLast)=>`<div class="msg-row ${x.role==='user'?'user':''}${isLast?' msg-new':''}">${x.role==='user'?'':`<span class="msg-avatar">✦</span>`}<div class="msg-bubble">${x.role==='user'?'':`<div class="eyebrow" style="margin-bottom:2px">${esc(x.model||'JARVIS')}</div>`}${esc(x.content)}</div></div>`;
 const hist=(function(){const slice=A.history.slice(-60);const anim=A.history.length!==A._animCount;A._animCount=A.history.length;return slice.map((x,i)=>bubble(x,anim&&i===slice.length-1)).join('')})();
 const suggestions=[
  ['Что сейчас по плану?','summary'],
  ['Сделай спокойный план на вечер','plan'],
  ['Добавь час Python','add'],
  ['Сколько я реально работал сегодня?','stats'],
  ['Отмени последнее изменение','undo'],
 ];
 const empty=`<div class="msg-row"><span class="msg-avatar">✦</span><div class="msg-bubble ai-hero"><div class="eyebrow" style="margin-bottom:3px">JARVIS</div>Привет. Скажи, что изменить в дне — я сделаю локально и покажу результат. Если нужен интернет-мозг, подключи сервер в настройках ⚙.<div class="ai-suggest">${suggestions.slice(0,3).map(([q])=>`<button class="chip" data-ai="quick" data-query="${esc(String(q))}">${esc(String(q))}</button>`).join('')}</div></div></div>`;
 let html=appHeader();
 html+=`<div class="ai-head">${indicator()}<span class="ai-status">${A.connected?'Подключено':A.url?'Не подключено':'Локально'}</span>${S.planUndo?.[today()]?`<button class="btn tight" data-ai="undoPlan" title="Отменить перепланирование сегодняшнего дня">↶ План</button>`:''}${A.undoStack.length?`<button class="btn tight" data-ai="undoLast" title="Отменить последнее действие">↶ Действие</button>`:''}<button class="iconbtn" data-ai="memory" aria-label="Память" title="Память">${typeof iconSvg==='function'?iconSvg('brain'):'🧠'}</button><button class="iconbtn" data-ai="chats" aria-label="Чаты Qwen" title="Чаты">${typeof iconSvg==='function'?iconSvg('book'):'≡'}</button><button class="iconbtn" data-ai="toggleConfig" aria-label="Настройки AI" title="Настройки">⚙</button></div>`;
 if(A.status)html+=`<div class="ai-alert" role="status">${esc(A.status)}</div>`;
 if(A.lastUsage)html+=`<div class="ai-alert" role="status" style="opacity:.8">Последний запрос: ${Number(A.lastUsage.inputTokens||0)} вх · ${Number(A.lastUsage.outputTokens||0)} вых${A.lastUsage.reasoningTokens?' · '+Number(A.lastUsage.reasoningTokens)+' reasoning':''} токенов (из ответа сервера).</div>`;
 if(A.showConfig){
  html+=`<section class="ai-settings show">`;
  html+=`<div class="ai-set-block"><h2>Подключение к серверу</h2><label class="ai-lbl">URL Worker</label><input class="ai-input" id="aiServer" type="url" placeholder="https://jarvis-routine-api...workers.dev" value="${esc(A.url)}" autocapitalize="off" spellcheck="false"><label class="ai-lbl">Токен доступа</label><input class="ai-input" id="aiToken" type="password" placeholder="APP_ACCESS_TOKEN" value="${esc(A.token)}" autocapitalize="off" spellcheck="false"><div class="ai-actions"><button class="btn primary" data-ai="connect">Подключиться</button><button class="btn" data-ai="hideToken">Очистить</button></div></div>`;
  html+=`<div class="ai-set-block"><h2>Модель AI</h2><div class="ai-mode"><button data-ai="mode" data-mode="auto" class="${A.mode==='auto'?'on':''}">Авто</button><button data-ai="mode" data-mode="flash" class="${A.mode==='flash'?'on':''}">Flash</button><button data-ai="mode" data-mode="plus" class="${A.mode==='plus'?'on':''}">Plus</button><button data-ai="mode" data-mode="max" class="${A.mode==='max'?'on':''}">Max</button></div></div>`;
  html+=`<div class="ai-set-block"><h2>Автономность</h2><div class="ai-mode"><button data-ai="autonomy" data-value="off" class="${A.autonomy==='off'?'on':''}">Выкл</button><button data-ai="autonomy" data-value="assist" class="${A.autonomy==='assist'?'on':''}">Помощник</button><button data-ai="autonomy" data-value="auto" class="${A.autonomy==='auto'?'on':''}">Автопилот</button></div><p class="ai-tiny">Помощник — предлагает, подтверждаешь ты. Автопилот пересчитывает гибкие дела при изменении подъёма. Операции Qwen требуют подтверждения.</p></div>`;
  html+=`<div class="ai-set-block"><h2>Данные</h2><div class="ai-actions"><button class="btn" data-ai="cloudInfo">☁ Статус облака</button><button class="btn" data-ai="pushSnapshot">↑ Сохранить в D1</button><button class="btn" data-ai="pullSnapshot">↓ Восстановить</button></div><label class="ai-check"><input type="checkbox" id="aiAutoSync" ${A.sync?'checked':''}> Автосинхронизация</label></div>`;
  html+=`<div class="ai-set-block"><h2>Для разработчика</h2><div class="ai-actions"><button class="btn" data-ai="insights">Статистика API</button><button class="btn" data-ai="sendEvents">Журнал → SQL</button></div></div><div class="ai-set-block"><h2>Уведомления</h2><p class="ai-tiny">Включение, тест, время напоминания и диагностика — в Настройки → Уведомления iPhone.</p><div class="ai-actions"><button class="btn" data-ai="openPush">Открыть настройки уведомлений</button></div></div>`;
  if(A.insights)html+=`<div class="ai-set-block"><h2>Статистика</h2>${insightsHTML()}</div>`;
  html+=`<div class="ai-set-block"><h2>История действий</h2>${actionHistoryHTML()}</div>`;
  html+=`</section>`;
 }
 html+=`<div class="ai-chat"><div class="ai-messages" id="aiMessages">${hist||empty}${A.busy?'<div class="msg-row"><span class="msg-avatar">✦</span><div class="msg-bubble"><span class="typing"><i></i><i></i><i></i></span></div></div>':''}</div>`;
 if(A.proposals.length){
  html+=`<div class="ai-proposals"><div class="ai-proposals-head">Предложения (${A.proposals.length})</div>`;
  for(let i=0;i<A.proposals.length;i++){let p=A.proposals[i],name=p.action==='create_habit'?p.name:(p.title||(p.date?itemList(p.date).find(x=>x.id===p.taskId)?.name:'')||p.taskId);
   const labels={add:'＋ Добавить',move:'↷ Перенести',update:'↻ Изменить',delete:'✕ Удалить',complete:'✓ Выполнить',create_habit:'＋ Привычка'};
   const detail=p.action==='add'||p.action==='move'?[p.date,p.start,(Number(p.durationMin)||40)+' мин'].join(' · '):p.action==='create_habit'?'Повторяющаяся привычка':p.date;
   html+=`<div class="ai-proposal"><b>${esc(labels[p.action]||'Изменить')}: ${esc(p.action==='create_habit'?p.name:name)}</b><div class="meta">${esc(detail||'')}</div><p class="reason">${esc(p.reason||'')}</p><div class="actions"><button class="btn primary" data-ai="apply" data-index="${i}">Подтвердить</button><button class="btn" data-ai="reject" data-index="${i}">Отклонить</button></div></div>`;
  }
  html+=`</div>`;
 }
 html+=`<form id="aiChatForm" class="ai-composer">${A.image?'<div class="ai-image-preview"><img src="'+A.image+'" alt=""><button type="button" class="ai-tool" data-ai="dropImage" aria-label="Убрать изображение">×</button></div>':''}<div class="ai-tools"><button type="button" class="ai-tool" data-ai="attach" aria-label="Вложение" title="Вложение">📎</button><button type="button" class="ai-tool" data-ai="mic" aria-label="Голосовой ввод" title="Голосовой ввод">🎤</button><button type="button" class="ai-tool" data-ai="speak" aria-label="Озвучить ответ" title="Озвучить ответ">🔊</button></div><div class="ai-composer-main"><textarea id="aiPrompt" rows="1" maxlength="1600" placeholder="Напиши, что нужно сделать…" required>${typeof A.draft==='string'?esc(A.draft):''}</textarea>${A.busy?'<button class="ai-send" type="button" data-ai="stop" aria-label="Остановить">■</button>':'<button class="ai-send" type="submit" aria-label="Отправить">➤</button>'}</div><input type="file" id="aiAttach" accept=".txt,.md,.json,.csv,text/plain,application/json,text/csv,image/png,image/jpeg,image/webp" hidden></form></div>`;
 return html;
}
function insightsHTML(){const x=A.insights;if(!x)return `<p class="ai-tiny">Подключи сервер и нажми «Обновить». Статистика не придумывается: используются реальные отметки, начало и завершение дел.</p>`;
 const usage=(x.usage||[]).map(t=>`<p class="ai-tiny">${esc(t.model)}: ${Number(t.requests)} запросов · ${Number(t.input_tokens)} входных / ${Number(t.output_tokens)} выходных токенов</p>`).join('');
 let categories=(x.categories||[]).slice(0,6).map(t=>{let n=Number(t.total),pct=n?Math.round(Number(t.completed)/n*100):0;return `<p class="ai-tiny">${esc(t.category||'Другое')} — ${pct}% (${n} событий)</p><div class="progressbar"><span style="width:${pct}%"></span></div>`}).join('');
 return `<div class="ai-stat-grid"><div class="ai-stat"><span>Зарегистрировано событий</span><b>${Number(x.events||0)}</b></div><div class="ai-stat"><span>Дней наблюдений</span><b>${Number(x.days||0)}</b></div></div><div class="ai-divider"></div>${categories||'<p>Пока мало данных.</p>'}<div class="ai-divider"></div><h2>Использование Qwen</h2>${usage||'<p>Запросов пока нет.</p>'}<p class="ai-tiny">Количество токенов известно; расход денег зависит от тарифов твоего API-аккаунта. Max ограничен: до 1 запроса в день и 4 в месяц; всего до 25 AI-запросов в день.</p>`;
}
function status(msg){A.status=msg;render()}
async function maybeBrief(){
 if(!A.autoBrief||!A.connected)return;
 const date=today(),key='jarvis_ai_brief_'+date;
 if(localStorage.getItem(key))return;
 // Record before starting to prevent duplicate API calls on a fast rerender.
 localStorage.setItem(key,'1');await sendChat('Сделай краткий персональный обзор дня с учётом моего расписания. Не предлагай лишних новых дел.','daily_brief','flash');
}
async function connect(){A.url=document.querySelector('#aiServer')?.value.trim()||A.url;A.token=document.querySelector('#aiToken')?.value.trim()||A.token;
 persistA();status('Проверяю защищённое подключение…');try{const d=await call('/api/status');A.connected=d.connected;A.showConfig=false;const remote=await call('/api/snapshot');A.cloudVersion=remote.version||0;try{const old=await call('/api/chat/history');if(!A.history.length)A.history=(old.messages||[]).slice(-20).map(m=>({role:m.role,model:m.model,content:m.content}))}catch(_){}A.status=`Подключено. AI: ${d.aiConfigured?'готов':'не настроен'}. Облачная версия: ${A.cloudVersion}.`;render();if(d.aiConfigured)await maybeBrief()}catch(e){A.connected=false;status('Ошибка подключения: '+e.message)}
}
function localStateSnapshot(){return JSON.parse(JSON.stringify(S))}
/* Cloud restore safety. buildCloudRestore is pure so it can be unit-tested
   without any server. It protects local data in two ways:
     - missing:   a non-empty local key the cloud copy does not contain at all
                  (an older snapshot taken before the feature existed);
     - conflicts: a key present in BOTH copies with DIFFERENT nested data, e.g.
                  local S.habits holds today's marks while a stale cloud S.habits
                  is empty. The cloud value still wins, but the caller must warn
                  the user before overwriting and keep a restorable backup. */
const RESTORE_LOCAL_KEYS=['goals','customHabits','flex','dayAdjust','events','focusSessions','focusLogs','shampooDays','reminders','pending','planUndo'];
const RESTORE_COMPARE_KEYS=['done','habits','overrides','logs','extras','wakeTimes','goals','customHabits','flex','dayAdjust','events','focusSessions','focusLogs','shampooDays','reminders','pending','planUndo'];
function restoreNonEmpty(v){return v!=null&&(Array.isArray(v)?v.length>0:typeof v==='object'?Object.keys(v).length>0:true)}
function sameJSON(a,b){try{return JSON.stringify(a)===JSON.stringify(b)}catch(e){return false}}
function buildCloudRestore(local,cloud){
 const defaults={done:{},habits:{},overrides:{},extras:[],logs:{},anchor:null,shave:null,wakeTimes:{}};
 const candidate={...defaults,...(cloud||{})};
 const has=cloud!=null;
 const missing=RESTORE_COMPARE_KEYS.filter(k=>(!has||cloud[k]===undefined)&&restoreNonEmpty(local&&local[k]));
 const conflicts=RESTORE_COMPARE_KEYS.filter(k=>has&&cloud[k]!==undefined&&restoreNonEmpty(local&&local[k])&&!sameJSON(cloud[k],local[k]));
 return {candidate,missing,conflicts};
}
let cloudWritePromise=null;
async function saveCloud(silent=false){
 if(!A.connected)throw Error('Сначала проверь подключение');
 // Serialize even manual + background saves: their expectedVersion must never race.
 if(cloudWritePromise){const shared=await cloudWritePromise;if(!silent)status('Резервная копия сохранена в D1. Версия '+shared.version);return shared;}
 const snapshot=localStateSnapshot(),version=A.cloudVersion;
 const request=call('/api/snapshot',{method:'POST',body:{state:snapshot,expectedVersion:version}});
 cloudWritePromise=request;
 try{
  const d=await request;A.cloudVersion=d.version;
  if(!silent)status('Резервная копия сохранена в D1. Версия '+d.version);
  return d;
 }finally{if(cloudWritePromise===request)cloudWritePromise=null;}
}
async function restoreCloud(){const d=await call('/api/snapshot');if(!d.state){status('На сервере ещё нет резервной копии');return}
 if(typeof validStateImport==='function'&&!validStateImport(d.state)){status('Облачная копия повреждена; локальные данные не изменены.');return}
 if(!confirm('ЗАМЕНИТЬ локальные отметки и личные задачи облачной копией? Локальная копия будет сохранена для отката.'))return;
 const local=localStateSnapshot();
 const built=buildCloudRestore(local,d.state);let candidate=built.candidate;
 if(built.missing.length){
  const keep=confirm('В облачной копии нет: '+built.missing.join(', ')+'. Сохранить эти локальные данные? ОК — сохранить, Отмена — заменить облачными.');
  if(keep){for(const k of built.missing)candidate[k]=local[k];}
  else if(!confirm('Восстановить без них и удалить эти локальные данные без отката? ОК — удалить.'))return;
 }
 if(built.conflicts.length){
  if(!confirm('Внимание: облачная копия перезапишет более свежие локальные данные в: '+built.conflicts.join(', ')+'. Локальная копия будет сохранена для отката. Продолжить?'))return;
 }
 const prev=S;
 let before;try{before=localStorage.getItem(STORE)||JSON.stringify(local)}catch(e){before=JSON.stringify(local)}
 try{localStorage.setItem('jarvis_routine_before_restore_v1',before)}catch(e){}
 S=candidate;
 if(!persist()){S=prev;try{persist()}catch(e){}status('Восстановление отменено: не удалось сохранить на устройстве. Локальные данные не изменены.');return}
 A.cloudVersion=d.version;status('Восстановлена версия '+d.version+'. Локальная копия сохранена для отката.');
}
async function sendEvents(){let events=(S.events||[]).slice(-250);if(!events.length){status('Пока нет событий для синхронизации');return}let r=await call('/api/events',{method:'POST',body:{events}});status(`Отправлено ${r.stored} событий в SQL-журнал. Повторные ID не дублируются.`)}
let syncTimer=null,pushTimer=null,syncInFlight=false,syncRevision=0;const originalPersist=persist;
function queueAutosync(){
 if(!A.connected||!A.sync)return;
 clearTimeout(syncTimer);
 syncTimer=setTimeout(async()=>{
  if(syncInFlight)return; // in-flight write will schedule another pass if data changed
  syncInFlight=true;const startedAt=syncRevision;
  try{
   await saveCloud(true);
   const last=Number(localStorage.getItem('jarvis_ai_events_sent_count')||0),events=S.events||[];
   if(events.length>last){
    await call('/api/events',{method:'POST',body:{events:events.slice(Math.max(last,events.length-120)).slice(-120)}});
    localStorage.setItem('jarvis_ai_events_sent_count',String(events.length));
   }
  }catch(e){
   // Never auto-merge snapshots or silently replace newer cloud data.
   A.sync=false;persistA();
   status(e.status===409?'Облако изменено другим устройством. Локальные данные сохранены; проверь облачную копию перед повторной синхронизацией.':'Автосинхронизация приостановлена; локальные данные сохранены: '+e.message);
  }finally{
   syncInFlight=false;
   if(A.sync&&syncRevision!==startedAt)queueAutosync();
  }
 },9000);
}
persist=function(){const ok=originalPersist();syncRevision++;if(!A.connected)return ok;
 if(A.pushEnabled){clearTimeout(pushTimer);pushTimer=setTimeout(()=>{if(ui.date===today())pushSchedule().catch(()=>{})},12000)}
 queueAutosync();
 return ok;
};
function baseMinutes(x){let [h,m]=x.split(':').map(Number);return h*60+m}
function hhmm(x){return String(Math.floor(x/60)%24).padStart(2,'0')+':'+String(x%60).padStart(2,'0')}
function anchor(t,s=ui.date){return !!(window.plannerIsFixed?.(t,s)||/^(Университет|Спорт|Зал|Семья|Сон|Дорога)$/.test(t.cat)||/Roblox с братом/i.test(t.name))}
function overlap(a,b){return baseMinutes(a.start)<baseMinutes(b.end)&&baseMinutes(a.end)>baseMinutes(b.start)}
// Same overlap rule as manual task entry: only explicit user consent can
// produce overlapping non-buffer tasks. AI proposals never silently bypass it.
function aiCollision(date,excludeId,start,end){
 return itemList(date).find(t=>t.id!==excludeId&&t.status!=='Буфер'&&t.cat!=='Буфер'&&
   !t.deleted&&overlap({start,end},t));
}
function applySuggestion(i){
 const p=A.proposals[i];if(!p)return false;
 const action=p.action;
 if(!['add','move','update','delete','complete','create_habit'].includes(action)){
   status('Это действие пока не поддерживается.');return false;
 }
 let params;
 if(action==='create_habit'){
   params={name:p.name,mode:p.mode||'daily',interval:p.interval||2,days:Array.isArray(p.days)?p.days:[0,1,2,3,4,5,6]};
 } else {
   if(!/^\d{4}-\d\d-\d\d$/.test(p.date))return false;
   if(Math.abs((Date.parse(p.date+'T12:00:00')-Date.now())/86400000)>30){status('Дата вне ближайших 30 дней');return false;}
   const row=itemList(p.date),existing=row.find(t=>t.id===p.taskId);
   if(['move','update','delete','complete'].includes(action)&&!existing){status('Задача не найдена, ничего не изменено.');return false;}
   if(['delete','update'].includes(action)&&anchor(existing,p.date)){status('Нельзя удалить закреплённое событие.');return false;}
   if(action==='move'&&anchor(existing,p.date)){status('Нельзя передвигать закреплённое событие.');return false;}
   if(action==='add'||action==='move'){
     const start=baseMinutes(p.start),len=action==='add'?Math.min(180,Math.max(10,Number(p.durationMin)||40)):baseMinutes(existing.end)-baseMinutes(existing.start);
     if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(p.start||''))||start<baseMinutes(wakeTime(p.date))||start+len>23*60+30){status('Неподходящее время для задачи.');return false;}
     const dest={start:p.start,end:hhmm(start+len)};
     const collision=aiCollision(p.date,p.taskId,dest.start,dest.end);
     if(collision){status('Нельзя применить: время пересекается с делом «'+collision.name+'». Выбери другое время.');return false;}
   }
   params=action==='add'?{title:p.title,date:p.date,start:p.start,durationMin:Number(p.durationMin)||40,cat:p.cat||'Организация',reason:p.reason||''}
     : {taskId:p.taskId,date:p.date,...(action==='move'?{start:p.start}:{}),...(action==='update'?{updates:p.updates}:{})};
 }
 const accepted=execAction({type:action,params},'ai_confirmed');
 if(!accepted)return false;
 A.proposals.splice(i,1);
 A.history.push({role:'assistant',model:'JARVIS',content:'✓ Действие выполнено: '+({add:'добавлена задача',move:'перенесена задача',update:'изменена задача',delete:'задача удалена',complete:'задача отмечена выполненной',create_habit:'привычка создана'}[action])+'. Можно отменить в истории действий.'});
 persistHistory();status('Действие сохранено.');return true;
}
/* Replanning is decided by the deterministic local planner (smart.js), never by
   the model. Works with no server, no key and no API cost. Qwen is only asked
   to phrase a short explanation afterwards, and its failure cannot undo the plan. */
const REPLAN_RX=/(перепланир|перестро[ий]|пересобер|пересобери|оптимизир|перераспредели|распланируй|скорректируй|переделай.*план|поменяй.*расписан|адаптир.*(?:день|вечер)|составь.*(?:план (?:на сегодня|на остаток дня|вечера)|расписан(?:ие)? (?:на сегодня|на вечер))|распиши.*(?:вечер|остаток дня))/i;
// Recognise an ordinary account of a disrupted day followed by an intent to
// salvage the evening. Do not intercept a mere question about sleep or a chat.
function understandDayRequest(message){
 const text=String(message||''), explicit=REPLAN_RX.test(text);
 const disrupted=/(поздно (?:встал|проснул)|(?:встал|проснул(?:ся|ась)?) (?:поздно|только|сегодня)|проспал|не успел|потратил.*(?:время|день)|весь день.*(?:сериал|тикток|игр|ничего)|д[её]н[её]м.*(?:другим|друго[еи]|не тем|сериал)|планы (?:сорвал|изменил)|сбил(?:ся|ась) график)/i.test(text);
 const action=/(надо|нужно|хочу|пора|давай|сделай|помоги|как бы|чтоб|чтобы|можно|успеть)/i.test(text);
 const evening=/(сегодня|вечер|остаток дня|до сна|до отбоя|сейчас|оставшееся время|дня)/i.test(text);
 const useful=/(продуктив|полезн|эффектив|поработа|позанима|уч[её]б|код|python|матем|дела|задач|успеть|расписани|план)/i.test(text);
 const advisoryOnly=/(не (?:меняй|изменяй|перестраивай|трогай) (?:план|расписание)|только (?:посоветуй|объясни|расскажи)|без изменений (?:плана|расписания))/i.test(text);
 const futureOnly=/(?:на завтра|завтрашн(?:ий|его|ему|яя) (?:день|план|расписание))/i.test(text)&&!/сегодня/i.test(text);
 const request=!advisoryOnly&&!futureOnly&&(explicit||(disrupted&&action&&evening&&useful));
 const productive=/(продуктив|полезн|эффектив|поработа|позанима|уч[её]б|код|python|матем|максимум.*(?:дел|успеть))/i.test(text);
 // Only capture clock times adjacent to waking, never a separate "сейчас 18:05".
 const wake=text.match(/(?:проснул(?:ся|ась)?|встал|подъ[её]м)\s*(?:сегодня[,\s]*|поздно[,\s]*){0,2}(?:примерно\s*|около\s*|в\s*)?(\d{1,2})[:.](\d{2})/i)
   || text.match(/(?:в\s*)(\d{1,2})[:.](\d{2})\s*(?:проснул(?:ся|ась)?|встал)/i);
 let reportedWake=null;
 if(wake){const h=Number(wake[1]),m=Number(wake[2]);if(h>=4&&h<=16&&m>=0&&m<60)reportedWake=String(h).padStart(2,'0')+':'+String(m).padStart(2,'0')}
 return {request,goal:productive?'productive':'balanced',reportedWake};
}
function replanRequested(message){return understandDayRequest(message).request&&typeof window.smartReplan==='function'}
function replanSummary(plan){
 const parts=[];
 const shifted=(plan.moved||[]).filter(m=>!m.date);
 if(shifted.length)parts.push('переставлено '+shifted.length+' дел');
 if(plan.transfers?.length)parts.push('перенесено на другие дни '+plan.transfers.length);
 if(plan.expired?.length)parts.push('пропущено '+plan.expired.length+' устаревших дел (не отмечены выполненными)');
 if(plan.released?.length)parts.push('освобождено '+plan.released.length+' необязательных блоков отдыха');
 if(plan.skipped?.length)parts.push('не поместилось '+plan.skipped.length);
 if(plan.overload>0)parts.push('не хватает примерно '+Math.round(plan.overload)+' минут');
 return parts.length?parts.join(', '):'дополнительные перестановки не потребовались';
}
async function sendChat(message,purpose='chat',forceTier=null){
 if(A.busy)return;
 if(window.JarvisMemory&&window.JarvisMemory.isRememberIntent(message)){
   A.history.push({role:'user',content:message});
   window.JarvisMemory.proposeRemember(message);
   A.history.push({role:'assistant',model:'JARVIS · память',content:'Предлагаю сохранить это в общую память. Проверь формулировку и подтверди.'});
   persistHistory();render();return;
 }
 // Local deterministic commands first: they work offline, need no key and never
 // call the paid model. Replanning always goes through the preview/apply path.
 const localCmd=(typeof window.JarvisPlanner!=='undefined'&&window.JarvisPlanner.command)?window.JarvisPlanner.command(message):null;
 if(localCmd&&(localCmd.kind==='answer'||localCmd.kind==='windows'||localCmd.kind==='optimize')){
   A.history.push({role:'user',content:message});
   if(localCmd.kind==='answer'){A.history.push({role:'assistant',model:'JARVIS · локально',content:localCmd.text});}
   else if(localCmd.kind==='windows'){const w=localCmd.windows||[];A.history.push({role:'assistant',model:'JARVIS · локально',content:w.length?'Свободные окна сегодня:\n'+w.map(x=>'• '+x.label+' · '+x.minutes+' мин').join('\n'):'Свободных окон от 10 минут нет.'});}
   else{const reason=localCmd.reason;let usedFlex=false;
     if((reason==='low'||reason==='late')&&window.JarvisFlex&&typeof window.JarvisFlex.state==='function'){
       try{const st=window.JarvisFlex.state();if(st&&st.mode==='on'){
         st.preview=reason==='low'?window.JarvisFlex.previewEnergy(1,today()):window.JarvisFlex.previewLate(30,today());
         ui.tab='today';render();
         A.history.push({role:'assistant',model:'JARVIS · локально',content:reason==='low'?'Включил щадящий предпросмотр: меньше гибкой нагрузки и один короткий блок. Проверь панель «Гибкий режим» и нажми «Применить».':'Подготовил предпросмотр опоздания на 30 минут. Проверь панель «Гибкий режим» и нажми «Применить».'});
         usedFlex=true;}}catch(e){}
     }
     if(!usedFlex){const pv=window.JarvisPlanner.previewOptimize(today());const n=pv&&pv.changes?pv.changes.length:0;A.history.push({role:'assistant',model:'JARVIS · локальный план',content:n?'Подготовил '+n+' изменений ('+(reason==='late'?'после опоздания':'по текущему времени')+'). Проверь список и нажми «Применить» — изменение можно отменить.':'План уже реалистичен — менять нечего.'});}}
   persistHistory();render();return;
 }
 const planIntent=understandDayRequest(message),wantsReplan=planIntent.request;
 if(!wantsReplan&&!A.connected){status('Подключи AI-сервер в настройках для обычного чата. Перепланирование работает и офлайн.');return}
 A.busy=true;A.status='';try{document.body.classList.add('ai-busy')}catch(e){}
 const date=wantsReplan?today():ui.date,prior=A.history.slice(-6).map(x=>({role:x.role,content:x.content}));
 A.history.push({role:'user',content:message});A.abort=new AbortController();render();
 try{
   if(wantsReplan){
     if(typeof window.smartReplan!=='function')throw Error('Локальный планировщик пока недоступен. Обнови PWA.');
     const plan=window.smartReplan(date,{silent:true,goal:planIntent.goal,reportedWake:planIntent.reportedWake});
     const summary=replanSummary(plan);
     const now=new Date(),clockMin=now.getHours()*60+now.getMinutes();
     const upcoming=itemList(date).filter(t=>t.status!=='Буфер'&&!S.done[date]?.[t.id]&&baseMinutes(t.end)>clockMin)
       .sort((a,b)=>baseMinutes(a.start)-baseMinutes(b.start)).slice(0,5)
       .map(t=>t.start+'–'+t.end+' '+String(t.name).slice(0,65));
     A.proposals=[];
     A.history.push({role:'assistant',model:'JARVIS · план обновлён',content:
       'Изменил расписание на сегодня: '+summary+'. '+
       (upcoming.length?'Ближайшие дела:\n'+upcoming.map(t=>'• '+t).join('\n')+'\n':'')+
       'Фиксированные события и время сна сохранены. Прошедшее не отмечено выполненным. ↶ Отменить перепланирование можно прямо здесь.'});
     A.status='✦ План на сегодня сохранён';
     // Do not ask Qwen to restate completed local actions: it cannot verify them,
     // and calling it adds cost, confusion and contradictory claims.
   }else{
     let agentOk=false;const img=A.image||'';A.image='';if(window.JarvisTools&&typeof window.JarvisTools.run==='function'){try{const res=await runAgent(message,img);A.history.push({role:'assistant',model:'JARVIS · агент',content:res.answer||'Готово.'});A.lastUsage=res.usage||null;A.proposals=[];A.status='';agentOk=true;}catch(ae){if(img){A.history.push({role:'assistant',model:'JARVIS',content:'Не удалось отправить изображение: текущая модель/эндпоинт не подтвердили поддержку vision.'});agentOk=true;}else{A.status='Агент недоступен, отвечаю без инструментов';}}}if(!agentOk){const tasks=itemList(date).filter(t=>t.status!=='Буфер');
     const now=new Date(),nowMin=now.getHours()*60+now.getMinutes();
     // Current, upcoming and fixed activities first. Never send the entire PLANS array.
     const relevant=tasks.slice().sort((a,b)=>{
       const score=t=>(anchor(t)?-300:0)+(S.done[date]?.[t.id]?300:0)+Math.abs(baseMinutes(t.start)-nowMin);
       return score(a)-score(b);
     }).slice(0,30);
     const compactTasks=relevant.map(t=>({id:t.id,name:t.name.slice(0,60),start:t.start,end:t.end,
       cat:t.cat,status:t.status,fixed:anchor(t,date),done:!!S.done[date]?.[t.id]}));
     const habits=(typeof currentHabits==='function'?currentHabits(date):[]).slice(0,18)
       .map(h=>({name:String(h.name).slice(0,65),done:!!S.habits[date]?.[h.id]}));
     const memCtx=(window.JarvisMemory?window.JarvisMemory.relevantFor(message):[]).map(x=>'• '+x.content).join('\n');
     const toolCtx=window.JarvisTools?window.JarvisTools.contextFor(message):'';
     const enriched=[message,toolCtx,memCtx?('[Память]\n'+memCtx):''].filter(Boolean).join('\n\n').slice(0,1600);
     const data=await call('/api/ai/chat',{method:'POST',body:{message:enriched,tier:forceTier||(A.mode==='auto'?'flash':A.mode||'flash'),purpose,
       date,wake:wakeTime(date),weekday:indexDay(date),tasks:compactTasks,habits,
       recentActions:(A.actionLog||[]).slice(-5).map(x=>({type:x.type,date:x.params?.date||'',timestamp:x.timestamp})),
       history:prior},signal:A.abort&&A.abort.signal});
     A.lastUsage=data.usage||null;
     A.history.push({role:'assistant',model:data.model||'JARVIS',content:data.answer||'Я подготовил изменения.'});
     A.proposals=Array.isArray(data.proposals)?data.proposals:[];}
     // Even in autopilot, destructive or completed-state changes always require a click.
     // New task suggestions are shown for confirmation too: avoid unintended additions.
   }
 }catch(e){if(e&&e.name==='AbortError')A.history.push({role:'assistant',model:'JARVIS',content:'Остановлено.'});else A.history.push({role:'assistant',model:'JARVIS',content:'Не удалось выполнить запрос: '+e.message})}
 finally{A.abort=null;A.busy=false;try{document.body.classList.remove('ai-busy')}catch(e){}persistHistory();render()}
}

async function enablePush(){
 if(!A.connected){status('Подключи сервер');return}
 if(!('serviceWorker' in navigator)||!('PushManager' in window)||!('Notification' in window)){status('Web Push недоступен в этом режиме. Добавь сайт на экран Домой в Safari.');return}
 try{
  const perm=await Notification.requestPermission();if(perm!=='granted'){status('Доступ к уведомлениям не разрешён');return}
  let {publicKey}=await call('/api/push/key');if(!publicKey){status('Настрой VAPID_PUBLIC_KEY и VAPID_PRIVATE_KEY в Cloudflare Worker');return}
  const key=Uint8Array.from(atob(publicKey.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
  const reg=await navigator.serviceWorker.ready;let sub=await reg.pushManager.getSubscription();if(!sub)sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key});
  await call('/api/push/subscribe',{method:'POST',body:{subscription:sub.toJSON()}});A.pushEnabled=true;persistA();status('Web Push включён на этом iPhone. Теперь создай напоминания для нужного дня.');
 }catch(e){status('Не удалось подключить Push: '+e.message)}
}
async function pushSchedule(){let date=ui.date,items=itemList(date).filter(t=>t.status==='Обязательно'&&!S.done[date]?.[t.id]).map(t=>({taskId:t.id,title:t.name,remindAt:new Date(date+'T'+t.start+':00').getTime()-10*60000}));
 let r=await call('/api/reminders',{method:'POST',body:{day:date,items}});status(`Запланировано ${r.scheduled} серверных напоминаний на ${date}. Они сработают примерно за 10 минут до дела.`);
}
async function updateInsights(){A.insights=await call('/api/analytics');A.status='';render()}

/* ── Action Engine ── */
A.actionLog = [];
A.undoStack = [];
A.suppressedWarnings = {};

const ACTION_SCHEMA = {
  add:         { params:{title:'s',date:'d',start:'t',durationMin:'n',cat:'c'}, auth:'confirm', label:'＋ Добавить', icon:'➕' },
  move:        { params:{taskId:'s',date:'d',start:'t'}, auth:'confirm', label:'↷ Перенести', icon:'↷' },
  delete:      { params:{taskId:'s',date:'d'}, auth:'always', label:'✕ Удалить', icon:'✕' },
  complete:    { params:{taskId:'s',date:'d'}, auth:'always', label:'✓ Выполнить', icon:'✓' },
  replan:      { params:{date:'d'}, auth:'auto', label:'✦ Перепланировать', icon:'✦' },
  update:      { params:{taskId:'s',date:'d',updates:'o'}, auth:'confirm', label:'↻ Обновить', icon:'↻' },
  create_habit:{ params:{name:'s',mode:'s'}, auth:'confirm', label:'＋ Привычка', icon:'🧴' },
};

function capState(){
  return JSON.parse(JSON.stringify({
    extras:S.extras||[], dayAdjust:S.dayAdjust||{}, customHabits:S.customHabits||[],
    done:S.done||{}, pending:S.pending||{}, events:S.events||[]
  }));
}

function resState(st){
  S.extras=st.extras; S.dayAdjust=st.dayAdjust; S.customHabits=st.customHabits;
  S.done=st.done; S.pending=st.pending; if(Array.isArray(st.events))S.events=st.events;
  persist(); render();
}

function valAction(action){
  const sc=ACTION_SCHEMA[action.type];
  if(!sc) return 'Неизвестное действие: '+action.type;
  for(const [k,t] of Object.entries(sc.params)){
    const v=action.params?.[k];
    if(v===undefined) return `Нет параметра: ${k}`;
    if(t==='d'&&!/^\d{4}-\d{2}-\d{2}$/.test(v)) return `Неверная дата: ${k}=${v}`;
    if(t==='t'&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) return `Неверное время: ${k}=${v}`;
    if(t==='n'&&(typeof v!=='number'||v<5||v>480)) return `Длительность 5-480: ${k}=${v}`;
    if(t==='o'&&(!v||typeof v!=='object'||Array.isArray(v)||!Object.keys(v).length)) return `Некорректные изменения: ${k}`;
    if(t==='s'&&(typeof v!=='string'||!v.trim())) return `Пустая строка: ${k}`;
  }
  if(A.autonomy==='off'&&sc.auth==='auto') return 'Автономность выключена';
  return null;
}

function uuid(){ try{return 'x_ai_'+crypto.randomUUID()}catch(e){return 'x_ai_'+Date.now().toString(36)+Math.random().toString(36).slice(2,8)} }

function execAction(action, source='user'){
  const validation=valAction(action);if(validation){status('Действие не применено: '+validation);return null;}
  const id='act_'+Date.now().toString(36)+Math.random().toString(36).slice(2,7);
  const before=capState();
  const p=action.params;
  const result={actionId:id, type:action.type, params:JSON.parse(JSON.stringify(action.params)), before, after:null, source, timestamp:new Date().toISOString(), undone:false};
  try{
    switch(action.type){
      case 'add':{
        const dur=Math.min(480,Math.max(5,Number(p.durationMin)||40));
        const end=baseMinutes(p.start)+dur;
        if(end>23*60+30)throw Error('Задача выходит за допустимый конец дня');
        const clash=aiCollision(p.date,null,p.start,hhmm(end));
        if(clash)throw Error('Время пересекается с делом «'+clash.name+'»');
        S.extras.push({id:uuid(), name:p.title, start:p.start,
          end:hhmm(end), cat:p.cat||'Организация', status:'План',
          note:'AI. '+(p.reason||''), fromDate:p.date, repeat:'once'});
        break;
      }
      case 'move':{
        const list=itemList(p.date);
        const task=list.find(t=>t.id===p.taskId);
        if(!task) throw Error('Задача не найдена');
        if(anchor(task,p.date)) throw Error('Нельзя перенести закреплённое');
        const destEnd=baseMinutes(p.start)+Math.min(300,Math.max(5,baseMinutes(task.end)-baseMinutes(task.start)));
        if(destEnd>23*60+30)throw Error('Задача выходит за допустимый конец дня');
        const clash=aiCollision(p.date,p.taskId,p.start,hhmm(destEnd));
        if(clash)throw Error('Время пересекается с делом «'+clash.name+'»');
        (S.dayAdjust[p.date]||={})[p.taskId]={start:p.start,end:hhmm(destEnd)};
        break;
      }
      case 'update':{
        const task=itemList(p.date).find(t=>t.id===p.taskId);
        if(!task)throw Error('Задача не найдена');
        if(anchor(task,p.date))throw Error('Закреплённое событие нельзя менять через AI');
        const allow=['name','note','cat','status','start','end'];
        const updates=Object.fromEntries(Object.entries(p.updates||{}).filter(([k])=>allow.includes(k)));
        if(!Object.keys(updates).length)throw Error('Нет допустимых изменений');
        if(updates.start&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(updates.start))throw Error('Неверное время');
        if(updates.end&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(updates.end))throw Error('Неверное время');
        if(['start','end'].some(k=>k in updates)){
          const nextStart=updates.start||task.start,nextEnd=updates.end||task.end;
          if(baseMinutes(nextEnd)<=baseMinutes(nextStart)||baseMinutes(nextEnd)>23*60+30)throw Error('Недопустимое время задачи');
          const conflict=aiCollision(p.date,p.taskId,nextStart,nextEnd);
          if(conflict)throw Error('Время пересекается с делом «'+conflict.name+'»');
        }
        (S.dayAdjust[p.date]||={})[p.taskId]={...(S.dayAdjust[p.date]?.[p.taskId]||{}),...updates};
        break;
      }
      case 'delete':{
        const task=itemList(p.date).find(t=>t.id===p.taskId);
        if(!task) throw Error('Задача не найдена');
        if(anchor(task,p.date)) throw Error('Нельзя удалить закреплённое');
        (S.dayAdjust[p.date]||={})[p.taskId]={omit:true};
        break;
      }
      case 'complete':{
        const task=itemList(p.date).find(t=>t.id===p.taskId);
        if(!task)throw Error('Задача не найдена');
        if(S.done[p.date]?.[p.taskId])throw Error('Задача уже выполнена');
        (S.done[p.date]||={})[p.taskId]=true;
        (S.events||=[]).push({eid:'ev_'+uuid(),type:'complete',date:p.date,taskId:task.id,
          title:task.name,category:task.cat,plannedStart:task.start,at:new Date().toISOString(),source:'ai_confirmed'});
        break;
      }
      case 'replan':{
        if(typeof smartReplan==='function') smartReplan(p.date, {silent:true});
        break;
      }
      case 'create_habit':{
        S.customHabits.push({id:uuid(), name:p.name, sub:p.sub||'',
          mode:p.mode||'daily', interval:Math.min(90,Math.max(1,Number(p.interval)||2)),
          days:Array.isArray(p.days)?p.days.filter(v=>Number.isInteger(v)&&v>=0&&v<=6).slice(0,7):[0,1,2,3,4,5,6], fromDate:ui.date});
        break;
      }
      default: throw Error('Неизвестный тип: '+action.type);
    }
  }catch(e){
    status('Ошибка: '+e.message); return null;
  }
  result.after=capState();
  A.actionLog.push(result);
  if(!source.startsWith('auto')) A.undoStack.unshift(result);
  if(A.actionLog.length>200) A.actionLog=A.actionLog.slice(-200);
  persist(); render();
  return result;
}

function undoLastAction(){
  if(!A.undoStack.length){ status('Нет действий для отмены'); return; }
  const act=A.undoStack[0];
  if(JSON.stringify(capState())!==JSON.stringify(act.after)){
    status('После действия расписание изменилось. Для защиты новых изменений откат не выполнен.');return;
  }
  resState(act.before);
  act.undone=true;
  A.undoStack.shift();
  status('Отменено: '+(ACTION_SCHEMA[act.type]?.label||act.type));
}

function undoAction(actionId){
  const idx=A.undoStack.map(a=>a.actionId).indexOf(actionId);
  if(idx<0){ status('Действие уже отменено или недоступно'); return; }
  if(idx!==0){status('Сначала отмени более поздние действия, чтобы не потерять изменения.');return;}
  const act=A.undoStack[idx];
  if(JSON.stringify(capState())!==JSON.stringify(act.after)){
    status('После действия данные изменились. Для безопасности автоматический откат не выполнен.');return;
  }
  resState(act.before);
  act.undone=true;
  A.undoStack.splice(idx,1);
  status('Отменено: '+(ACTION_SCHEMA[act.type]?.label||act.type));
}

/* ── Autopilot Engine ── */
function autoPermitted(type){
  if(A.autonomy!=='auto') return false;
  const sc=ACTION_SCHEMA[type];
  return sc && (sc.auth==='auto'||sc.auth==='confirm');
}

function tryAutoAction(action){
  const sc=ACTION_SCHEMA[action.type];
  if(!sc) return null;
  if(A.autonomy==='auto'&&sc.auth!=='always'){
    const err=valAction(action);
    if(!err) return execAction(action,'autopilot');
  }
  return null;
}

/* ── Event-driven Automation ── */
function onWakeChanged(s){
  if(A.autonomy==='auto'&&typeof smartReplan==='function'){
    window.smartReplan(s,{silent:true});
    A.status='Автопилот обновил гибкий план дня. Отменить можно в разделе «План».';
  }
}

function onTaskCompleted(s,id){
  const dd=(a,b)=>Math.round((Date.parse(a+'T12:00:00')-Date.parse(b+'T12:00:00'))/86400000);
  const deadlines=S.extras.filter(t=>t.deadlineDate&&dd(t.deadlineDate,s)<=3&&dd(t.deadlineDate,s)>=0);
  if(deadlines.length&&!A.suppressedWarnings[s+deadlines[0].deadlineDate]){
    A.suppressedWarnings[s+deadlines[0].deadlineDate]=true;
    status('⏰ Дедлайн: '+deadlines[0].name+' до '+deadlines[0].deadlineDate+'. Проверь план.');
  }
}

function onAppOpened(){
  const s=today();
  const lastActive=A.lastActiveDate;
  A.lastActiveDate=s;
  if(lastActive&&lastActive!==s&&A.autonomy==='auto'){
    const pending=S.pending?.[s]||[];
    for(const p of pending.filter(x=>x.required)){
      if(S.dayAdjust[s]&&S.dayAdjust[s][p.id]) delete S.dayAdjust[s][p.id];
    }
    if(pending.length) status('Есть незавершённые дела. Проверь план перед переносом.');
  }
  const prev=A._lastWake;
  A._lastWake=wakeTime(s);
  if(prev&&prev!==A._lastWake) onWakeChanged(s);
}

// Wire automation to existing scheduler events
document.addEventListener('change',e=>{
  if(e.target.id==='wakeSlider') setTimeout(()=>onWakeChanged(ui.date),100);
});
document.addEventListener('change',e=>{
  if(e.target.matches('input[data-id][data-date]')&&e.target.checked)
    setTimeout(()=>onTaskCompleted(e.target.dataset.date,e.target.dataset.id),50);
});
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='visible') onAppOpened();
});

/* ── Action History UI ── */
function actionHistoryHTML(){
  if(!A.actionLog.length) return '<p class="ai-tiny">История действий пуста. Действия появятся после выполнения задач через AI или автопилот.</p>';
  let html='<div class="ai-action-log">';
  for(let i=Math.min(20,A.actionLog.length)-1;i>=0;i--){
    const a=A.actionLog[i],sc=ACTION_SCHEMA[a.type];
    html+=`<div class="ai-action-entry ${a.undone?'undone':''}">
      <span class="ai-action-icon">${sc?.icon||'•'}</span>
      <span class="ai-action-desc">${sc?.label||a.type}${a.params?.title?' '+esc(a.params.title):''}
        <small>${a.source||'user'} · ${a.timestamp.slice(11,19)}</small></span>
      ${!a.undone&&A.undoStack.includes(a)?`<button class="btn tight" data-ai="undoAction" data-id="${a.actionId}">↶</button>`:''}
    </div>`;
  }
  return html+'</div>';
}

// Event listeners are namespaced so the v2 scheduler remains untouched.
document.addEventListener('submit',e=>{if(e.target.id==='aiChatForm'){e.preventDefault();const field=document.querySelector('#aiPrompt');const val=field?.value.trim();if(val){A.draft='';sendChat(val)}} });
document.addEventListener('input',e=>{if(e.target&&e.target.id==='aiPrompt')A.draft=e.target.value||'';},false);
document.addEventListener('change',e=>{if(!e.target||e.target.id!=='aiAttach')return;const f=e.target.files&&e.target.files[0];try{e.target.value=''}catch(err){}if(!f)return;if(/^image\//.test(f.type||'')){if(f.size>2000000){try{toast('Изображение больше 2 МБ')}catch(err){};return}const rd=new FileReader();rd.onload=()=>{A.image=String(rd.result||'');render();};rd.onerror=()=>{try{toast('Не удалось прочитать изображение')}catch(err){}};rd.readAsDataURL(f);return;}if(f.size>80000){try{toast('Файл больше 80 КБ')}catch(err){};return}if(!/\.(txt|md|json|csv)$/i.test(f.name)&&!/^(text\/|application\/json)/.test(f.type||'')){try{toast('Поддерживаются текстовые файлы (.txt,.md,.json,.csv) и изображения')}catch(err){};return}f.text().then(txt=>{const block='\n\n[Файл '+f.name+']\n'+String(txt).slice(0,60000);A.draft=(A.draft||'')+block;const ta=document.querySelector('#aiPrompt');if(ta)ta.value=A.draft;try{toast('Файл добавлен в сообщение')}catch(err){}}).catch(()=>{try{toast('Не удалось прочитать файл')}catch(err){}});},false);
document.addEventListener('change',e=>{if(e.target.id==='aiAutoBrief'){A.autoBrief=e.target.checked;persistA();status(A.autoBrief?'Ежедневный обзор включён; будет запускаться только при подключении.':'Ежедневный обзор выключен.');}
 if(e.target.id==='aiAutoSync'){
 if(e.target.checked&&!A.cloudVersion){e.target.checked=false;status('Сначала нажми «Сохранить на сервер», затем включи автосинхронизацию.');return}
 A.sync=e.target.checked;persistA();status(A.sync?'Автосинхронизация включена.':'Автосинхронизация выключена.');
 }});
document.addEventListener('click',async e=>{const el=e.target.closest('[data-ai]');if(!el)return;e.preventDefault();const op=el.dataset.ai;
 try{
  if(op==='toggleConfig'){A.showConfig=!A.showConfig;render()}
 else if(op==='chats'){openChats();return}
 else if(op==='memory'){if(window.JarvisMemory)window.JarvisMemory.openUI();return}
  else if(op==='connect')await connect();
  else if(op==='hideToken'){if(confirm('Удалить сохранённый токен с этого устройства?')){A.token='';A.connected=false;A.sync=false;persistA();status('Токен очищен')}}
  else if(op==='mode'){A.mode=el.dataset.mode;persistA();render()}
   else if(op==='autonomy'){A.autonomy=el.dataset.value;persistA();status('Режим автономности: '+{'off':'Выключен','assist':'Помощник','auto':'Автопилот'}[A.autonomy]||A.autonomy);render()}
  else if(op==='quick')await sendChat(el.dataset.query,el.dataset.purpose||'chat');
  else if(op==='stop'){aiStop();return}
  else if(op==='mic'){aiMic();return}
  else if(op==='speak'){aiSpeak();return}
  else if(op==='attach'){aiAttach();return}
  else if(op==='dropImage'){A.image='';render();return}
  else if(op==='apply')applySuggestion(Number(el.dataset.index));
  else if(op==='reject'){A.proposals.splice(Number(el.dataset.index),1);render()}
  else if(op==='cloudInfo'){let d=await call('/api/snapshot');A.cloudVersion=d.version||0;status(`Облачная версия: ${A.cloudVersion}. Последнее обновление: ${d.updatedAt||'ещё нет'}`)}
  else if(op==='pushSnapshot'){if(!confirm('Сохранить текущие локальные данные в личную базу? Это отправит расписание, привычки и историю выполнения на Cloudflare.'))return;await saveCloud();}
  else if(op==='pullSnapshot')await restoreCloud();
  else if(op==='sendEvents')await sendEvents();
  else if(op==='openPush'){try{ui.tab='more';ui.moreTab='settings';render();window.scrollTo(0,0)}catch(e){}}
  else if(op==='enablePush')await enablePush();
  else if(op==='schedulePush')await pushSchedule();
  else if(op==='testPush'){let r=await call('/api/push/test',{method:'POST',body:{}});status(r.note||'Тест запланирован')}
  else if(op==='insights')await updateInsights();
  else if(op==='undoAction')undoAction(el.dataset.id);
   else if(op==='undoLast')undoLastAction();
   else if(op==='undoPlan'){if(typeof window.revertPlan==='function'){window.revertPlan(today());A.history.push({role:'assistant',model:'JARVIS',content:'Вернул прежнее расписание на сегодня. Новые действия после перепланирования сохранены.'});persistHistory();A.status='↶ Перепланирование отменено';render()}}
   else if(op==='briefNow')await sendChat('Дай краткий разумный план на остаток дня с учётом моего расписания и реальных данных.','daily_brief','flash');
 }catch(err){status('Ошибка: '+err.message)}
});
// Expose AI state, view and chat entry point for testing and global render()
window.aiState = A;
window.JarvisCloudRestore = { buildCloudRestore, RESTORE_LOCAL_KEYS };
window.restoreCloud = restoreCloud;
window.aiView = aiView;
window.sendChat = sendChat;
// Restore current view on version upgrade; never touch old task records.
render();
if(A.url&&A.token){call('/api/status').then(async d=>{A.connected=!!d.connected;if(A.connected){const remote=await call('/api/snapshot');A.cloudVersion=remote.version||0;try{const old=await call('/api/chat/history');if(!A.history.length)A.history=(old.messages||[]).slice(-20).map(m=>({role:m.role,model:m.model,content:m.content}))}catch(_){}A.status='Подключено к личному серверу';render();if(d.aiConfigured)await maybeBrief()}}).catch(()=>{A.connected=false;render()})}
})();
