/** JARVIS Routine 3.0 – private one-user Cloudflare Worker API.
 * API key is stored ONLY in Worker Secrets. All mutations authenticate and validate inputs.
 * SQL via bound D1, no generic SQL endpoints, no arbitrary provider URL.
 */
import { buildPushPayload } from '@block65/webcrypto-web-push';

const MODELS = { flash: 'qwen3.7-flash', plus: 'qwen3.7-plus', max: 'qwen3.7-max' };
const ENDPOINTS = new Set([
  'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  'https://dashscope.aliyuncs.com/compatible-mode/v1',
  'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
  'https://openrouter.ai/api/v1',
  'https://api.aitunnel.ru/v1',
  'https://ru-api.aitunnel.ru/v1',
]);
const encoder = new TextEncoder();
function reply(data, status=200, extra={}) { return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...extra}}); }
function fail(status,msg){return reply({error:msg},status)}
function validDate(x){
 if(typeof x!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(x))return false;
 const [year,month,day]=x.split('-').map(Number);
 if(year<1000||month<1||month>12||day<1||day>31)return false;
 const utc=new Date(Date.UTC(year,month-1,day));
 return utc.getUTCFullYear()===year&&utc.getUTCMonth()===month-1&&utc.getUTCDate()===day;
}
function validTime(x){if(typeof x!=='string'||!/^\d\d:\d\d$/.test(x))return false;const [h,m]=x.split(':').map(Number);return h<24&&m<60;}
function cleanText(x,max=1000){return typeof x==='string'?x.trim().slice(0,max):''}
function iso(){return new Date().toISOString()}
async function sha(x){return new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(x)))}
async function authorized(req,env){
 const bearer=(req.headers.get('Authorization')||'').match(/^Bearer\s+(\S+)$/i)?.[1]||'';
 if(!env.APP_ACCESS_TOKEN||bearer.length<24||bearer.length>200)return false;
 const [a,b]=await Promise.all([sha(bearer),sha(env.APP_ACCESS_TOKEN)]);
 let diff=0;for(let i=0;i<a.length;i++)diff|=a[i]^b[i];return diff===0;
}
function originAllowed(req,env){const origin=req.headers.get('Origin');return !origin||origin===env.ALLOWED_ORIGIN;}
function withCors(response,req,env){
 const origin=req.headers.get('Origin'),h=new Headers(response.headers);
 if(origin&&origin===env.ALLOWED_ORIGIN){h.set('Access-Control-Allow-Origin',origin);h.set('Access-Control-Allow-Headers','Authorization,Content-Type');h.set('Access-Control-Allow-Methods','GET,POST,DELETE,OPTIONS');h.set('Vary','Origin')}
 h.set('X-Content-Type-Options','nosniff');h.set('Referrer-Policy','no-referrer');return new Response(response.body,{status:response.status,headers:h});
}
async function jsonBody(req,max=1600000){
 const ct=req.headers.get('Content-Type')||'';if(!ct.toLowerCase().includes('application/json'))throw Error('Требуется Content-Type: application/json');
 const n=Number(req.headers.get('Content-Length')||0);if(n>max)throw Error('Запрос слишком большой');
 const raw=await req.text();if(raw.length>max)throw Error('Запрос слишком большой');return JSON.parse(raw);
}
function requestDay(){return new Date().toISOString().slice(0,10)}
async function aiBudget(env,tier){
 const day=requestDay();const month=day.slice(0,7)+'%';
 const daily=await env.DB.prepare('SELECT requests,max_calls FROM request_usage WHERE day=?').bind(day).first();
 const requests=Number(daily?.requests||0),max=Number(daily?.max_calls||0);
 const monthMax=await env.DB.prepare("SELECT COUNT(*) AS n FROM ai_usage WHERE model=? AND created_at LIKE ?").bind(MODELS.max,month).first();
 if(requests>=25)throw Error('Дневной лимит AI-запросов достигнут (25).');
 if(tier==='max'&&(max>=1||Number(monthMax?.n||0)>=4))throw Error('Лимит Max: 1 в день и 4 в месяц.');
}
function chooseTier(body){const t=body.tier;if(t==='max'||t==='plus'||t==='flash')return t;
 const intent=cleanText(body.message,1200).toLowerCase();
 if(body.purpose==='explain')return 'flash';
 if(body.purpose==='weekly_review'||/стратег|глубок.*анализ.*недел/i.test(intent))return 'plus';
 if(body.purpose==='schedule'||/(переплан|расписан|перенес|поставь|дедлайн|местами|сдвинь|успеть к|проснулся|потратил|оптимизиру|перестрой|остаток)/i.test(intent))return 'plus';
 return 'flash';
}
function normalizeTasks(rows){if(!Array.isArray(rows))return [];
 return rows.slice(0,65).filter(t=>t&&typeof t==='object').map(t=>({id:cleanText(t.id,90),name:cleanText(t.name,100),start:validTime(t.start)?t.start:null,end:validTime(t.end)?t.end:null,cat:cleanText(t.cat,40),status:cleanText(t.status,40),fixed:!!t.fixed,done:!!t.done}));
}
function safeProposals(proposals){if(!Array.isArray(proposals))return [];
 return proposals.slice(0,8).flatMap(p=>{
  if(!p||typeof p!=='object')return [];
  const action=p.action;
  if(action==='create_habit'){
   const name=cleanText(p.name,100),mode=['daily','weekly','everyN'].includes(p.mode)?p.mode:'daily';
   if(!name)return [];
   return [{action,name,mode,interval:Math.min(90,Math.max(1,Number(p.interval)||2)),
     days:Array.isArray(p.days)?p.days.filter(x=>Number.isInteger(x)&&x>=0&&x<=6).slice(0,7):[0,1,2,3,4,5,6],
     reason:cleanText(p.reason,190)}];
  }
  if(!['add','move','update','delete','complete'].includes(action)||!validDate(p.date))return [];
  const taskId=cleanText(p.taskId,90),title=cleanText(p.title,130),reason=cleanText(p.reason,190);
  if(['move','update','delete','complete'].includes(action)&&!taskId)return [];
  if(action==='add'||action==='move'){
   if(!validTime(p.start)||(action==='add'&&!title))return [];
   const durationMin=Math.min(180,Math.max(10,Number(p.durationMin)||40));
   return [{action,date:p.date,start:p.start,durationMin,taskId,title,
    cat:cleanText(p.cat,40)||'Организация',reason}];
  }
  if(action==='update'){
   if(!p.updates||typeof p.updates!=='object'||Array.isArray(p.updates))return [];
   const updates={};
   for(const key of ['name','note','cat','status']){
    if(typeof p.updates[key]==='string'&&p.updates[key].trim())updates[key]=cleanText(p.updates[key],key==='name'?130:180);
   }
   for(const key of ['start','end']){
    if(validTime(p.updates[key]))updates[key]=p.updates[key];
   }
   if(!Object.keys(updates).length)return [];
   return [{action,date:p.date,taskId,updates,reason}];
  }
  return [{action,date:p.date,taskId,title,reason}];
 });
}
function textContent(content){
 if(typeof content==='string')return content.trim();
 if(Array.isArray(content))return content.map(part=>typeof part==='string'?part:(part?.type==='text'&&typeof part.text==='string'?part.text:'')).filter(Boolean).join('\n').trim();
 return '';
}
function parseAI(content){
 const t=textContent(content);
 if(!t)return null;
 const raw=t.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
 try{
  const o=JSON.parse(raw);
  if(!o||typeof o!=='object'||Array.isArray(o))return {answer:cleanText(t,3500),proposals:[]};
  const answer=cleanText(o.answer||o.reply||o.message,3500);
  if(!answer&&!Array.isArray(o.proposals))return {answer:cleanText(t,3500),proposals:[]};
  return {answer:answer||'Я подготовил предложения. Проверь их перед применением.',proposals:safeProposals(o.proposals)};
 }catch(_){
  // A truncated structured reply is NOT plain prose. Retry instead of showing
  // an opening brace or a partially generated JSON object to the user.
  const looksStructured=/^\s*(?:\{ |\{|\[|```\s*json\b)/i.test(t);
  if(looksStructured)return null;
  return {answer:cleanText(t,3500),proposals:[]};
 }
}
// Only final content is shown; reasoning_content is deliberately never exposed.
function finalMessage(data){
 const choice=data?.choices?.[0];
 const direct=parseAI(choice?.message?.content);
 if(direct)return direct;
 // Some compatible gateways return final text under output_text.
 return parseAI(data?.output_text);
}

const SYSTEM_PLAIN=`Ты интерфейс JARVIS Routine. Пиши по-русски 2–4 короткие фразы без JSON. У тебя есть контекст текущего расписания, привычек и последних действий приложения. Описывай только подтверждённые данные. Если действие уже выполнено локальным движком и указано в контексте — признавай результат. Не утверждай, что JARVIS вообще не умеет работать с расписанием. Новые действия без подтверждения не называй выполненными.`;
const SYSTEM_JSON=`Ты AI-интерфейс JARVIS Routine, подключённый к реальному расписанию и привычкам. Кратко отвечай по-русски и используй только переданный контекст. Можешь ПРЕДЛАГАТЬ действия с задачами; приложение выполняет их только после подтверждения пользователя. Не утверждай, что оно не имеет доступа к расписанию. Не говори «добавил», «удалил», «завершил» до подтверждения. Не выдумывай выполненные дела и статистику.
Фиксированные пары, зал, встречи и сон защищены. Изменения защищённых событий не предлагай. Для удаления, завершения, переноса и редактирования используй точный taskId из контекста.
Выводи только JSON {"answer":"краткое сообщение о предложении либо ответ на вопрос","proposals":[]}.
Действия в proposals (0–5 штук):
- add: {"action":"add","date":"YYYY-MM-DD","start":"HH:MM","durationMin":40,"title":"...","cat":"...","reason":"..."}
- move: {"action":"move","date":"YYYY-MM-DD","taskId":"...","start":"HH:MM","reason":"..."}
- update: {"action":"update","date":"YYYY-MM-DD","taskId":"...","updates":{"name":"..."},"reason":"..."}. updates: только name/note/cat/status/start/end.
- complete/delete: {"action":"complete","date":"YYYY-MM-DD","taskId":"..."} либо delete.
- create_habit: {"action":"create_habit","name":"...","mode":"daily","reason":"..."} (mode: daily, weekly, everyN; days=[0..6]).
Если пользователь просто беседует или спрашивает, proposals оставь пустым. Никакого произвольного кода или команд.`;
async function talk(req,env){
 const b=await jsonBody(req,150000);const message=cleanText(b.message,1600);if(!message)return fail(400,'Напиши сообщение');
 const providerKey=env.AITUNNEL_API_KEY||env.QWEN_API_KEY; // Совместимость со старыми установками
 if(!providerKey)return fail(503,'Добавь AITUNNEL_API_KEY в Cloudflare Worker Secrets');
 const tier=chooseTier(b);await aiBudget(env,tier);
 // Explanations and briefs are plain prose: asking for JSON there only wastes output tokens.
 const systemPrompt=(b.purpose==='explain'||b.purpose==='daily_brief')?SYSTEM_PLAIN:SYSTEM_JSON;
 const base=(env.QWEN_BASE_URL||'https://api.aitunnel.ru/v1').replace(/\/$/,'');
 if(!ENDPOINTS.has(base))return fail(500,'Неподдерживаемый адрес API; проверь QWEN_BASE_URL');
 const date=validDate(b.date)?b.date:requestDay();
 const rawTasks=normalizeTasks(b.tasks);
 const compactTasks=rawTasks.slice(0,30).map(t=>({id:t.id,name:cleanText(t.name,50),start:t.start,end:t.end,cat:t.cat,status:t.status,fixed:t.fixed,done:t.done}));
 const summary={date,wake:validTime(b.wake)?b.wake:null,weekday:b.weekday??null,tasks:compactTasks,
  habits:Array.isArray(b.habits)?b.habits.slice(0,18).map(h=>({name:cleanText(h?.name,65),done:!!h?.done})):[],
  recentActions:Array.isArray(b.recentActions)?b.recentActions.slice(-5).map(a=>({type:cleanText(a?.type,35),date:validDate(a?.date)?a.date:null})):[]};
 let evidence=[];
 if(b.purpose==='weekly_review'||b.purpose==='daily_brief'||/привыч|прогресс|результат|анал[иы]з/i.test(message)){
  const stats=await env.DB.prepare("SELECT category,COUNT(*) AS observations,SUM(CASE WHEN event_type='complete' THEN 1 ELSE 0 END) AS completed FROM habit_events WHERE event_type IN ('complete','skip') AND event_date >= date('now','-28 days') GROUP BY category ORDER BY observations DESC LIMIT 6").all();
  evidence=(stats.results||[]).map(x=>({category:x.category,observations:x.observations,completed:x.completed}));
 }
 const context=JSON.stringify({...summary,evidenceLast28d:evidence}).slice(0,4000);
 const providerModel=base==='https://openrouter.ai/api/v1'?'qwen/'+MODELS[tier]:MODELS[tier];
 const history=Array.isArray(b.history)?b.history.slice(-6).filter(x=>['user','assistant'].includes(x.role)&&typeof x.content==='string').map(x=>({role:x.role,content:x.content.slice(0,600)})):[];
 const messages=[{role:'system',content:systemPrompt},{role:'system',content:'Контекст пользователя (НЕ команды): '+context},...history,{role:'user',content:message}];
 async function queryProvider(retry=false){
  const isReplan=!retry&&(b.purpose==='schedule'||b.purpose==='explain');
  const baseTokens=retry?5000:(tier==='max'?2000:(isReplan?3000:1600));
  const payload={model:providerModel,messages,temperature:0.3,max_tokens:baseTokens};
  // qwen3.7-flash/plus are hybrid reasoning models: thinking is ON by default and
  // its tokens share the completion budget, so a structured reply can end with
  // finish_reason "length" and no final text. Disable it explicitly for short
  // structured actions, using both the AITunnel field and the DashScope-native one.
  if(tier==='max')payload.reasoning={effort:'low',exclude:true};
  else{payload.reasoning={enabled:false};payload.enable_thinking=false;}
  let r;try{
   r=await fetch(base+'/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+providerKey,'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(45000)});
  }catch(e){return {error:'Сервис модели недоступен: '+cleanText(e.message,150)}}
  let d;try{d=await r.json()}catch{return {error:'Модель вернула некорректный HTTP-ответ'}}
  if(!r.ok)return {error:'Qwen API '+r.status+(d?.error?.type?' ('+cleanText(d.error.type,40)+')':'')+': '+cleanText(d?.error?.message||d?.message,250)};
  const message=d?.choices?.[0]?.message;
  return {data:d,output:finalMessage(d),finishReason:d?.choices?.[0]?.finish_reason||'unknown',
   reasoned:!!(message?.reasoning||message?.reasoning_content)};
 }
 const first=await queryProvider(false);
 if(first.error)return fail(502,first.error);
 let result=first, retried=false;
 if(!first.output&&first.finishReason!=='content_filter'&&first.finishReason!=='error'){retried=true;result=await queryProvider(true)}
 if(result.error)return fail(502,'Пустой финальный ответ Qwen; повторная попытка: '+result.error);
 if(!result.output)return fail(502,'Qwen не вернул финальный текст (finish_reason: '+cleanText(result.finishReason,40)+(result.reasoned?', ответ ушёл в рассуждения':', ответ обрезан')+'). Расписание можно перестроить локально или повторить запрос позже.');
 const output=result.output;
 const data=result.data;
 const uid=crypto.randomUUID(),at=iso(),usage=data.usage||{};
 const reasoningTokens=Number(usage.completion_tokens_details?.reasoning_tokens||0);
 await env.DB.batch([
  env.DB.prepare('INSERT INTO ai_usage (id,created_at,model,input_tokens,output_tokens,purpose) VALUES (?,?,?,?,?,?)').bind(uid,at,MODELS[tier],Number(usage.prompt_tokens||0),Number(usage.completion_tokens||0),cleanText(b.purpose,50)||'chat'),
  env.DB.prepare('INSERT INTO chat_messages (id,created_at,role,model,content) VALUES (?,?,?,?,?)').bind(crypto.randomUUID(),at,'user',providerModel,message),
  env.DB.prepare('INSERT INTO chat_messages (id,created_at,role,model,content) VALUES (?,?,?,?,?)').bind(crypto.randomUUID(),at,'assistant',providerModel,output.answer),
  env.DB.prepare('INSERT INTO request_usage (day,requests,max_calls) VALUES (?,1,?) ON CONFLICT(day) DO UPDATE SET requests=requests+1, max_calls=max_calls+?').bind(requestDay(),tier==='max'?1:0,tier==='max'?1:0),
 ]);
 return reply({...output,model:providerModel,retried,usage:{inputTokens:Number(usage.prompt_tokens||0),outputTokens:Number(usage.completion_tokens||0),reasoningTokens}});
}
const AGENT_TOOL_NAMES = new Set(['get_ui_context','get_current_time','get_today','get_schedule','get_tasks','get_goals','get_habits','get_progress','find_free_time','get_planning_rules','search_memory','search_chats','navigate','open_date','open_task','open_habits','open_focus','open_settings','open_memory','select_wallpaper','set_motion_level','propose_day_replan','propose_task_move','propose_memory']);
function sanitizeAgentMessages(msgs){
 if(!Array.isArray(msgs))return null;
 const out=[];
 for(const m of msgs.slice(-30)){
  if(!m||typeof m!=='object')return null;
  const role=m.role;
  if(!['system','user','assistant','tool'].includes(role))return null;
  if(role==='tool'){
   if(typeof m.tool_call_id!=='string'||!m.tool_call_id)return null;
   out.push({role:'tool',tool_call_id:m.tool_call_id.slice(0,80),content:typeof m.content==='string'?m.content.slice(0,6000):''});
   continue;
  }
  if(role==='assistant'&&Array.isArray(m.tool_calls)){
   const tcs=m.tool_calls.slice(0,8).map(tc=>({id:String(tc.id||'').slice(0,80),type:'function',function:{name:String(tc.function&&tc.function.name||'').slice(0,60),arguments:String(tc.function&&tc.function.arguments||'{}').slice(0,4000)}})).filter(tc=>tc.id&&tc.function.name);
   out.push({role:'assistant',content:typeof m.content==='string'?m.content.slice(0,4000):null,tool_calls:tcs});
   continue;
  }
  let content;
  if(typeof m.content==='string')content=m.content.slice(0,4000);
  else if(Array.isArray(m.content)){
   content=m.content.slice(0,3).map(p=>{
    if(p&&p.type==='text'&&typeof p.text==='string')return {type:'text',text:p.text.slice(0,4000)};
    if(p&&p.type==='image_url'&&p.image_url&&typeof p.image_url.url==='string'&&/^data:image\/(png|jpe?g|webp);base64,/.test(p.image_url.url))return {type:'image_url',image_url:{url:p.image_url.url.slice(0,1500000)}};
    return null;
   }).filter(Boolean);
  } else return null;
  out.push({role,content});
 }
 return out.length?out:null;
}
function sanitizeAgentTools(tools){
 if(!Array.isArray(tools))return [];
 return tools.slice(0,24).map(t=>{
  if(!t||t.type!=='function'||!t.function||typeof t.function.name!=='string')return null;
  const name=t.function.name.trim();
  if(!AGENT_TOOL_NAMES.has(name))return null;
  const params=t.function.parameters&&typeof t.function.parameters==='object'?t.function.parameters:{type:'object',properties:{}};
  return {type:'function',function:{name,description:String(t.function.description||'').slice(0,300),parameters:params}};
 }).filter(Boolean);
}
async function agent(req,env){
 const b=await jsonBody(req,5000000);
 const messages=sanitizeAgentMessages(b.messages);
 if(!messages)return fail(400,'messages некорректны');
 const tools=sanitizeAgentTools(b.tools);
 const providerKey=env.AITUNNEL_API_KEY||env.QWEN_API_KEY;
 if(!providerKey)return fail(503,'Добавь AITUNNEL_API_KEY в Cloudflare Worker Secrets');
 const tier=['flash','plus','max'].includes(b.tier)?b.tier:'flash';
 await aiBudget(env,tier);
 const base=(env.QWEN_BASE_URL||'https://api.aitunnel.ru/v1').replace(/\/$/,'');
 if(!ENDPOINTS.has(base))return fail(500,'Неподдерживаемый адрес API; проверь QWEN_BASE_URL');
 const providerModel=base==='https://openrouter.ai/api/v1'?'qwen/'+MODELS[tier]:MODELS[tier];
 const allTools=[...tools];
 if(b.webSearch)allTools.push({type:'aitunnel:web_search',parameters:{max_results:5,max_uses:2,max_total_results:10,search_context_size:'medium'}});
 const payload={model:providerModel,messages,temperature:0.3,max_tokens:tier==='max'?2500:1800};
 if(allTools.length){payload.tools=allTools;payload.tool_choice='auto';payload.parallel_tool_calls=true;payload.max_tool_calls=Math.min(10,Math.max(1,Number(b.maxToolCalls)||6));}
 if(tier==='max')payload.reasoning={effort:'low',exclude:true};else{payload.reasoning={enabled:false};payload.enable_thinking=false;}
 let r;try{r=await fetch(base+'/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+providerKey,'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(60000)});}catch(e){return fail(502,'Сервис модели недоступен: '+cleanText(e.message,150));}
 let d;try{d=await r.json()}catch{return fail(502,'Модель вернула некорректный HTTP-ответ');}
 if(!r.ok)return fail(502,'Qwen API '+r.status+(d?.error?.type?' ('+cleanText(d.error.type,40)+')':'')+': '+cleanText(d?.error?.message||d?.message,250));
 const choice=(d.choices&&d.choices[0])||{};const msg=choice.message||{};const usage=d.usage||{};
 const at=iso();
 try{await env.DB.batch([
  env.DB.prepare('INSERT INTO ai_usage (id,created_at,model,input_tokens,output_tokens,purpose) VALUES (?,?,?,?,?,?)').bind(crypto.randomUUID(),at,MODELS[tier],Number(usage.prompt_tokens||0),Number(usage.completion_tokens||0),'agent'),
  env.DB.prepare('INSERT INTO request_usage (day,requests,max_calls) VALUES (?,1,?) ON CONFLICT(day) DO UPDATE SET requests=requests+1, max_calls=max_calls+?').bind(requestDay(),tier==='max'?1:0,tier==='max'?1:0),
 ]);}catch(e){}
 return reply({
  message:{role:'assistant',content:typeof msg.content==='string'?msg.content:null,tool_calls:Array.isArray(msg.tool_calls)?msg.tool_calls:null},
  annotations:Array.isArray(msg.annotations)?msg.annotations.slice(0,8):null,
  reasoning_details:msg.reasoning_details||null,
  finishReason:choice.finish_reason||'unknown',
  usage:{inputTokens:Number(usage.prompt_tokens||0),outputTokens:Number(usage.completion_tokens||0),reasoningTokens:Number(usage.completion_tokens_details?.reasoning_tokens||0),webSearchRequests:Number(usage.server_tool_use?.web_search_requests||0)},
  model:providerModel
 });
}
async function writeEvents(req,env){const b=await jsonBody(req,250000);if(!Array.isArray(b.events))return fail(400,'events[] обязателен');const events=b.events.slice(0,250);
 const stmts=events.filter(e=>e&&typeof e==='object'&&validDate(e.date)).map(e=>{
  const id=cleanText(e.eid,120)||crypto.randomUUID();
  return env.DB.prepare('INSERT OR IGNORE INTO habit_events (id,event_type,event_date,category,task_id,wake,planned_start,actual_start,duration_min,payload,received_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
   .bind(id,cleanText(e.type,50),e.date,cleanText(e.category,70),cleanText(e.taskId,100),cleanText(e.wake,15),cleanText(e.plannedStart,15),cleanText(e.actualStart,15),Math.min(1000,Math.max(0,Number(e.actualDuration)||0)),JSON.stringify(e).slice(0,2500),iso());
 });
 for(let i=0;i<stmts.length;i+=50)await env.DB.batch(stmts.slice(i,i+50));return reply({stored:stmts.length});
}
async function saveSnapshot(req,env){const b=await jsonBody(req,1200000);
 if(!b.state||typeof b.state!=='object'||Array.isArray(b.state))return fail(400,'state должен быть объектом');
 const state=JSON.stringify(b.state);if(state.length>950000)return fail(413,'История превысила лимит: экспортируй JSON, затем сократи журнал.');
 // Never use a SELECT-version followed by unconditional UPSERT: parallel clients can both
 // read the same version and overwrite each other. One conditional SQL write is the CAS.
 const expected=b.expectedVersion;
 if(!Number.isSafeInteger(expected)||expected<0)return fail(400,'expectedVersion должен быть целым неотрицательным числом');
 const stamp=iso();
 const write=expected===0
  ?await env.DB.prepare('INSERT OR IGNORE INTO snapshots (id,version,payload,updated_at) VALUES (1,1,?,?)').bind(state,stamp).run()
  :await env.DB.prepare('UPDATE snapshots SET version=version+1,payload=?,updated_at=? WHERE id=1 AND version=?').bind(state,stamp,expected).run();
 if(Number(write?.meta?.changes||0)===1)return reply({ok:true,version:expected+1});
 const latest=await env.DB.prepare('SELECT version FROM snapshots WHERE id=1').first();
 return reply({error:'Cloud conflict: облачная версия изменена; локальные данные не перезаписаны',version:Number(latest?.version||0)},409);
}
/* ── Private schedule template (privacy migration) ──────────────────────────────
   The personal schedule is no longer embedded in public static HTML. It is stored
   once in D1 and read only through this authenticated endpoint. Reads and writes
   are separate routes; nothing here can delete user data. */
const TIME_RE=/^([01]\d|2[0-3]):[0-5]\d$/;
function validateScheduleTemplate(t){
 if(!t||typeof t!=='object'||Array.isArray(t))return 'payload должен быть объектом';
 const plans=t.plans;
 if(!Array.isArray(plans)||plans.length<1||plans.length>4)return 'plans должен содержать 1–4 недели';
 const ids=new Set();let total=0;
 for(const week of plans){
  if(!Array.isArray(week)||week.length<1||week.length>7)return 'каждая неделя должна содержать 1–7 дней';
  for(const day of week){
   if(!Array.isArray(day)||day.length>64)return 'день содержит слишком много блоков';
   for(const item of day){
    if(!item||typeof item!=='object'||Array.isArray(item))return 'блок должен быть объектом';
    const id=cleanText(item.id,80);
    if(!id)return 'у блока должен быть идентификатор';
    if(ids.has(id))return 'идентификаторы блоков должны быть уникальны';
    ids.add(id);
    if(!TIME_RE.test(String(item.start||''))||!TIME_RE.test(String(item.end||'')))return 'некорректное время блока';
    if(!cleanText(item.name,200))return 'у блока должно быть название';
    if(++total>1200)return 'слишком много блоков';
   }
  }
 }
 if(!total)return 'шаблон не может быть пустым: пустой шаблон заменил бы реальное расписание';
 const habits=t.habits;
 if(!Array.isArray(habits)||habits.length>64)return 'habits должен быть массивом (не более 64)';
 for(const h of habits){
  if(!h||typeof h!=='object')return 'некорректная привычка';
  if(!cleanText(h.id,40)||!cleanText(h.name,120))return 'у привычки должны быть id и название';
  if(!Array.isArray(h.days))return 'у привычки должен быть список дней';
 }
 return null;
}
async function saveScheduleTemplate(req,env){
 const b=await jsonBody(req,400000);
 const invalid=validateScheduleTemplate(b.payload);
 if(invalid)return fail(400,invalid);
 const payload={plans:b.payload.plans,habits:b.payload.habits};
 const state=JSON.stringify(payload);
 if(state.length>350000)return fail(413,'Шаблон превысил лимит хранилища');
 const expected=b.expectedVersion;
 if(!Number.isSafeInteger(expected)||expected<0)return fail(400,'expectedVersion должен быть целым неотрицательным числом');
 const stamp=iso();
 const write=expected===0
  ?await env.DB.prepare('INSERT OR IGNORE INTO schedule_template (id,version,payload,updated_at) VALUES (1,1,?,?)').bind(state,stamp).run()
  :await env.DB.prepare('UPDATE schedule_template SET version=version+1,payload=?,updated_at=? WHERE id=1 AND version=?').bind(state,stamp,expected).run();
 if(Number(write?.meta?.changes||0)===1)return reply({ok:true,version:expected+1,blocks:payload.plans.reduce((n,w)=>n+w.reduce((m,d)=>m+d.length,0),0)});
 const latest=await env.DB.prepare('SELECT version FROM schedule_template WHERE id=1').first();
 return reply({error:'Шаблон уже изменён другим клиентом; данные не перезаписаны',version:Number(latest?.version||0)},409);
}
async function analytics(env){
 const [byCat,byHour,counters,usage]=await Promise.all([
  env.DB.prepare("SELECT category,COUNT(*) AS total,SUM(CASE WHEN event_type='complete' THEN 1 ELSE 0 END) AS completed FROM habit_events WHERE event_type IN ('complete','skip') GROUP BY category ORDER BY total DESC LIMIT 12").all(),
  env.DB.prepare("SELECT substr(COALESCE(NULLIF(actual_start,''),planned_start),1,2) AS hour,COUNT(*) AS total,SUM(CASE WHEN event_type='complete' THEN 1 ELSE 0 END) AS completed FROM habit_events WHERE event_type IN ('complete','skip') GROUP BY 1 ORDER BY total DESC LIMIT 24").all(),
  env.DB.prepare('SELECT COUNT(*) AS n,COUNT(DISTINCT event_date) AS days FROM habit_events').first(),
  env.DB.prepare("SELECT model,COUNT(*) AS requests,SUM(input_tokens) AS input_tokens,SUM(output_tokens) AS output_tokens FROM ai_usage GROUP BY model ORDER BY model").all(),
 ]);
 return reply({events:counters?.n||0,days:counters?.days||0,categories:byCat.results||[],hours:byHour.results||[],usage:usage.results||[],note:'Статистика основана только на записях; отсутствие отметки не доказывает пропуск.'});
}
function safePushHost(raw){
 try{const u=new URL(raw);const h=u.hostname.toLowerCase();return u.protocol==='https:'&&(h==='fcm.googleapis.com'||h==='updates.push.services.mozilla.com'||h.endsWith('.push.apple.com')||h.endsWith('.notify.windows.com'))}catch{return false}
}
function validatePushSubscription(sub){
 if(!sub||typeof sub!=='object'||typeof sub.endpoint!=='string'||sub.endpoint.length>1200||!safePushHost(sub.endpoint))return false;
 if(!sub.keys||!/^[a-zA-Z0-9_-]+$/.test(sub.keys.p256dh||'')||!/^[a-zA-Z0-9_-]+$/.test(sub.keys.auth||''))return false;
 return sub.keys.p256dh.length>=80&&sub.keys.auth.length>=20;
}
async function savePush(req,env){let b=await jsonBody(req,12000),s=b.subscription;
 if(!validatePushSubscription(s))return fail(400,'Некорректная push-подписка');
 const device=cleanText(b.device,64)||'unknown';
 await env.DB.prepare('INSERT OR REPLACE INTO push_subscriptions (endpoint,subscription,created_at) VALUES (?,?,?)').bind(s.endpoint,JSON.stringify({...s,device}),iso()).run();return reply({ok:true,device});
}
async function saveReminders(req,env){let b=await jsonBody(req,40000);if(!validDate(b.day)||!Array.isArray(b.items))return fail(400,'day + items[] обязательны');
 const items=b.items.slice(0,35),now=Date.now(),max=now+45*86400000;
 const entries=items.filter(t=>t&&typeof t==='object'&&typeof t.remindAt==='number'&&t.remindAt>now-60000&&t.remindAt<max&&cleanText(t.title,180)).map(t=>({id:crypto.randomUUID(),taskId:cleanText(t.taskId,90),title:cleanText(t.title,120),remindAt:Math.round(t.remindAt)}));
 // Deletion and insertions must be one transaction: a failed insertion must not
 // erase the user's existing pending reminders for the same day.
 const remove=env.DB.prepare('DELETE FROM reminders WHERE day=? AND sent_at IS NULL').bind(b.day);
 const stmts=entries.map(t=>env.DB.prepare('INSERT INTO reminders (id,task_id,day,title,remind_at) VALUES (?,?,?,?,?)').bind(t.id,t.taskId,b.day,t.title,t.remindAt));
 await env.DB.batch([remove,...stmts]);return reply({ok:true,scheduled:stmts.length});
}
async function doPush(env,onlyId){
 if(!env.VAPID_SERVER_PUBLIC_KEY||!env.VAPID_SERVER_PRIVATE_KEY||!env.VAPID_SUBJECT)return {accepted:0,statuses:[]};
 const due=onlyId
  ? await env.DB.prepare('SELECT * FROM reminders WHERE id=? AND sent_at IS NULL LIMIT 1').bind(onlyId).all()
  : await env.DB.prepare('SELECT * FROM reminders WHERE sent_at IS NULL AND remind_at <= ? AND remind_at > ? ORDER BY remind_at LIMIT 12').bind(Date.now(),Date.now()-86400000).all();
 const subs=await env.DB.prepare('SELECT * FROM push_subscriptions LIMIT 5').all();
 const vapid={subject:env.VAPID_SUBJECT,publicKey:env.VAPID_SERVER_PUBLIC_KEY,privateKey:env.VAPID_SERVER_PRIVATE_KEY};
 if(!(subs.results||[]).length)return {accepted:0,statuses:[]}; // no recipient is not a delivered reminder
 let accepted=0;const statuses=[];
 for(const r of due.results||[]){
  let errors=[],delivered=0;
  const url='./?date='+encodeURIComponent(r.day||'')+'&task='+encodeURIComponent(r.task_id||'');
  for(const s of subs.results||[]){try{
    let sub=JSON.parse(s.subscription);let payload=await buildPushPayload({data:JSON.stringify({title:'JARVIS Routine',body:r.title,url}),options:{ttl:600}},sub,vapid);
    if(!safePushHost(sub.endpoint))throw Error('push endpoint not allowed');
    const result=await fetch(sub.endpoint,payload);
    statuses.push(result.status);
    if([404,410].includes(result.status)){await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').bind(s.endpoint).run();continue}
    if(!result.ok)errors.push('push '+result.status);
    else delivered++;
   }catch(e){errors.push(cleanText(e.message,60))}
  }
  // Preserve failed reminders as pending so Cron can retry when service recovers.
  // sent_at means at least one push gateway accepted the request, not physical device delivery.
  if(delivered){accepted++;await env.DB.prepare('UPDATE reminders SET sent_at=?,error=? WHERE id=?').bind(Date.now(),errors.slice(0,2).join('; ')||null,r.id).run();}
  else await env.DB.prepare('UPDATE reminders SET error=? WHERE id=?').bind(errors.slice(0,2).join('; ')||'Нет действующей push-подписки',r.id).run();
 }
 return {accepted,statuses};
}
async function pushStatus(req,env){
 const device=cleanText(new URL(req.url).searchParams.get('device'),64)||'unknown';
 const subs=await env.DB.prepare('SELECT subscription FROM push_subscriptions LIMIT 20').all();
 let mine=false;const devices=[];
 for(const row of subs.results||[]){try{const s=JSON.parse(row.subscription);if(s.device)devices.push(s.device);if(s.device===device||!s.device||s.device==='unknown')mine=true}catch(e){}}
 const q=await env.DB.prepare('SELECT COUNT(*) AS n,MIN(remind_at) AS next FROM reminders WHERE sent_at IS NULL').first();
 return reply({pushConfigured:!!(env.VAPID_SERVER_PUBLIC_KEY&&env.VAPID_SERVER_PRIVATE_KEY),subscriptions:(subs.results||[]).length,deviceSubscribed:mine,devices:devices.slice(0,5),pending:(q&&q.n)||0,nearestReminder:(q&&q.next)||null});
}
async function dropPush(req,env){const b=await jsonBody(req,4000);if(!b||typeof b.endpoint!=='string'||!b.endpoint.startsWith('https://'))return fail(400,'endpoint обязателен');await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').bind(b.endpoint).run();return reply({ok:true})}
async function api(req,env){
 const p=new URL(req.url).pathname,m=req.method;
 if(p==='/api/health'&&m==='GET')return reply({ok:true,version:'3.0.0',modelRouting:true,db:!!env.DB});
 if(!originAllowed(req,env))return fail(403,'Этот сайт не разрешён');
 if(!await authorized(req,env))return fail(401,'Неверный токен доступа');
 if(p==='/api/status'&&m==='GET')return reply({ok:true,connected:true,aiConfigured:!!(env.AITUNNEL_API_KEY||env.QWEN_API_KEY),pushConfigured:!!env.VAPID_SERVER_PUBLIC_KEY,version:'3.0.0'});
 if(p==='/api/snapshot'&&m==='GET'){let a=await env.DB.prepare('SELECT version,payload,updated_at FROM snapshots WHERE id=1').first();return reply({version:a?.version||0,state:a?JSON.parse(a.payload):null,updatedAt:a?.updated_at||null})}
 if(p==='/api/snapshot'&&m==='POST')return saveSnapshot(req,env);
 if(p==='/api/schedule-template'&&m==='GET'){
  const row=await env.DB.prepare('SELECT version,payload,updated_at FROM schedule_template WHERE id=1').first();
  if(!row)return fail(404,'Шаблон расписания ещё не опубликован на сервере');
  let payload;try{payload=JSON.parse(row.payload)}catch{return fail(500,'Повреждённое хранилище шаблона')}
  return reply({version:Number(row.version)||1,payload,updatedAt:row.updated_at||null});
 }
 if(p==='/api/schedule-template'&&m==='POST')return saveScheduleTemplate(req,env);
 if(p==='/api/events'&&m==='POST')return writeEvents(req,env);
 if(p==='/api/analytics'&&m==='GET')return analytics(env);
 if(p==='/api/ai/chat'&&m==='POST')return talk(req,env);
 if(p==='/api/ai/agent'&&m==='POST')return agent(req,env);
 if(p==='/api/chat/history'&&m==='GET'){let r=await env.DB.prepare('SELECT role,model,content,created_at FROM chat_messages ORDER BY created_at DESC LIMIT 30').all();return reply({messages:(r.results||[]).reverse()})}
 if(p==='/api/push/key'&&m==='GET')return reply({publicKey:env.VAPID_SERVER_PUBLIC_KEY||null});
 if(p==='/api/push/subscribe'&&m==='POST')return savePush(req,env);
 if(p==='/api/push/unsubscribe'&&m==='POST')return dropPush(req,env);
 if(p==='/api/push/status'&&m==='GET')return pushStatus(req,env);
 if(p==='/api/reminders'&&m==='POST')return saveReminders(req,env);
 if(p==='/api/push/test'&&m==='POST'){
  const day=requestDay(),id=crypto.randomUUID();
  await env.DB.prepare('INSERT INTO reminders (id,day,title,remind_at) VALUES (?,?,?,?)').bind(id,day,'Тестовое уведомление: связь настроена',Date.now()).run();
  const r=await doPush(env,id);
  return reply({queued:false,accepted:r.accepted>0,sent:r.accepted,providerStatuses:r.statuses.slice(0,5),correlationId:id,note:r.accepted>0?'Push-провайдер принял тестовое уведомление. Это подтверждение отправки, не гарантия доставки на экран.':'Нет действующей подписки или VAPID не настроен.'});
 }
 return fail(404,'Маршрут не найден');
}
export default {
 async fetch(req,env){if(req.method==='OPTIONS'){
   if(!originAllowed(req,env))return fail(403,'Origin не разрешён');
   return withCors(new Response(null,{status:204}),req,env);
  }
  try{return withCors(await api(req,env),req,env)}
  catch(e){const msg=cleanText(e?.message||String(e),180);return withCors(fail(/(лимит|исчерпан|достигнут)/i.test(msg)?429:/(некоррект|слишком большой|JSON|Требуется|ожидал)/i.test(msg)?400:500,msg),req,env)}
 },
 async scheduled(_evt,env,ctx){ctx.waitUntil(doPush(env))}
};
