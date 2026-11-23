/* JARVIS Routine 3.2 — verify manual task saves before changing real data.
   Loaded after the legacy inline handler, but registered in capture phase so
   a conflicting task never reaches the save handler without a choice. */
(() => {
  'use strict';
  const toMin = value => {
    if(!/^\d{2}:\d{2}$/.test(value||'')) return NaN;
    const [h,m]=value.split(':').map(Number);
    return h<24&&m<60 ? h*60+m : NaN;
  };
  const toHM = n => `${String(Math.floor(n/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`;
  const escapeText = value => String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const relevant = item => item && item.status!=='Буфер' && item.cat!=='Буфер' && !item.deleted;
  function occupied(date,excludeId){
    return itemList(date).filter(t=>t.id!==excludeId && relevant(t))
      .map(t=>({...t,begin:toMin(t.start),finish:toMin(t.end)}))
      .filter(t=>Number.isFinite(t.begin)&&Number.isFinite(t.finish)&&t.finish>t.begin);
  }
  function conflicts(date,excludeId,start,end){
    const begin=toMin(start),finish=toMin(end);
    if(!Number.isFinite(begin)||!Number.isFinite(finish)||begin>=finish)return [];
    return occupied(date,excludeId).filter(t=>{
      if(isContainerTask(t)&&begin>=t.begin&&finish<=t.finish)return false;
      return begin<t.finish && finish>t.begin;
    });
  }
  function freeSlot(date,excludeId,start,end){
    const begin=toMin(start),finish=toMin(end),length=finish-begin;
    if(!Number.isFinite(length)||length<=0||length>720)return null;
    const blocks=occupied(date,excludeId);
    let earliest=Math.max(6*60,begin);
    if(date===today()){
      const now=new Date();
      earliest=Math.max(earliest,Math.ceil((now.getHours()*60+now.getMinutes())/5)*5);
    }
    for(let candidate=Math.ceil(earliest/5)*5;candidate+length<=23*60+30;candidate+=5){
      if(!blocks.some(t=>candidate<t.finish && candidate+length>t.begin))
        return {start:toHM(candidate),end:toHM(candidate+length)};
    }
    return null;
  }
  function isProtectedTask(t){
    return !!t && (t.fixed===true || ['Университет','Сон','Дорога','Спорт'].includes(t.cat) || /^(Сон|Университет|Дорога|Спорт)/.test(String(t.cat||'')));
  }
  function isContainerTask(t){
    try{return !!(t&&(t.isContainer||(typeof S!=='undefined'&&S.containers&&S.containers[t.id])))}catch(e){return false}
  }
  function slotWithinBlock(date,parentId,start,end){
    try{
      const parent=itemList(date).find(t=>t.id===parentId);
      if(!parent)return null;
      const b=toMin(parent.start),f=toMin(parent.end),len=toMin(end)-toMin(start);
      if(!Number.isFinite(b)||!Number.isFinite(f)||!(len>0))return null;
      for(let c=Math.ceil(b/5)*5;c+len<=f;c+=5){
        if(!itemList(date).some(t=>t.id!==parentId&&relevant(t)&&t.parentId===parentId&&c<toMin(t.end)&&c+len>toMin(t.start)))
          return {start:toHM(c),end:toHM(c+len)};
      }
    }catch(e){}
    return null;
  }
  function overlayConflictText(items){return items.map(t=>`${t.start}–${t.end} · ${t.name}`).join('; ')}
  function showNotice(form,heading,detail,items=[],opts={}){
    let region=form.querySelector('#taskConflictWarning');
    if(!region){region=document.createElement('div');region.id='taskConflictWarning';region.className='task-conflict-note';region.setAttribute('role','alert');form.appendChild(region);}
    const after=opts.afterStart?`<button type="button" data-ux-conflict="after" class="primary">${escapeText(opts.afterLabel||('После неё, '+opts.afterStart))}</button>`:'';
    const nest=opts.nest?`<button type="button" data-ux-conflict="nest">${escapeText('Внутрь «'+opts.nest.name+'»')}</button>`:'';
    const actions=opts.protected
      ? `<button type="button" data-ux-conflict="find" class="primary">Подобрать время</button><button type="button" data-ux-conflict="back">Изменить вручную</button>`
      : `${after}${nest}<button type="button" data-ux-conflict="find">Подобрать время</button><button type="button" data-ux-conflict="anyway">Оставить пересечение</button><button type="button" data-ux-conflict="back">Изменить</button>`;
    region.innerHTML=`<strong>${escapeText(heading)}</strong><div>${escapeText(detail)}</div>`+
      (items.length?`<ul class="task-conflict-list">${items.slice(0,5).map(t=>`<li>${escapeText(t.start)}–${escapeText(t.end)} · ${escapeText(t.name)}</li>`).join('')}</ul>`:'')+
      `<div class="task-conflict-actions">${actions}</div>`;
    form.dataset.conflictProtected=opts.protected?'1':'0';
    if(opts.afterStart){form.dataset.afterStart=opts.afterStart;form.dataset.afterEnd=opts.afterEnd||'';}
    if(opts.nest){form.dataset.nestId=opts.nest.id;form.dataset.nestName=opts.nest.name;}
    region.scrollIntoView?.({block:'nearest',behavior:'smooth'});
  }
  document.addEventListener('input',e=>{
    const form=e.target.closest?.('#taskform');
    if(form){delete form.dataset.allowOverlap;form.querySelector('#taskConflictWarning')?.remove();}
  },true);
  document.addEventListener('submit',e=>{
    const form=e.target;
    if(form?.getAttribute('id')!=='taskform')return;
    if(form.dataset.allowOverlap==='yes'){delete form.dataset.allowOverlap;return;}
    const data=Object.fromEntries(new FormData(form).entries());
    const date=data.fromDate||ui.date;
    const begin=toMin(data.start),finish=toMin(data.end);
    if(!Number.isFinite(begin)||!Number.isFinite(finish)||begin>=finish){
      e.preventDefault();e.stopImmediatePropagation();
      showNotice(form,'Проверь время','Конец дела должен быть позже начала. Дела через полночь пока не поддерживаются.');
      return;
    }
    const all=occupied(date,data.id);
    const parent=data.parentId?all.find(t=>t.id===data.parentId):null;
    let overlap=[],nest=null;
    if(parent){
      if(!isContainerTask(parent)){
        e.preventDefault();e.stopImmediatePropagation();
        showNotice(form,'Блок ещё не контейнер','Сначала явно сделайте «'+parent.name+'» блоком-контейнером, затем добавляйте внутрь.');
        return;
      }
      if(begin<toMin(parent.start)||finish>toMin(parent.end)){
        e.preventDefault();e.stopImmediatePropagation();
        showNotice(form,'Не помещается в блок',`«${parent.name}» идёт ${parent.start}–${parent.end}. Дочернее дело должно целиком помещаться внутрь.`,[]);
        return;
      }
      overlap=all.filter(t=>t.id!==parent.id&&begin<t.finish&&finish>t.begin);
    }else{
      const container=all.find(t=>isContainerTask(t)&&begin>=t.begin&&finish<=t.finish);
      overlap=all.filter(t=>(!container||t.id!==container.id)&&begin<t.finish&&finish>t.begin);
      if(!overlap.length)return; // inside a container, or free: allowed
      nest=all.filter(t=>!isProtectedTask(t)&&!isContainerTask(t)&&begin>=t.begin&&finish<=t.finish)
        .sort((a,b)=>(a.finish-a.begin)-(b.finish-b.begin))[0]||null;
    }
    if(!overlap.length)return;
    e.preventDefault();e.stopImmediatePropagation();
    const protectedHit=overlap.filter(isProtectedTask);
    const afterEnd=Math.max(...overlap.map(t=>t.finish));
    const dur=finish-begin;
    const opts={protected:protectedHit.length>0,nest};
    if(afterEnd+dur<=23*60+30){opts.afterStart=toHM(afterEnd);opts.afterEnd=toHM(afterEnd+dur);}
    if(protectedHit.length){
      showNotice(form,'Защищённый блок',`На ${date} нельзя ставить дело поверх занятия, сна, дороги или тренировки. Выбери другое время.`,protectedHit,opts);
    }else{
      showNotice(form,'Время уже занято',`На ${date} пересекается ${overlap.length} дел(а). Можно поставить после, внутрь блока, подобрать время или оставить пересечение осознанно.`,overlap,opts);
    }
  },true);
  document.addEventListener('click',e=>{
    const control=e.target.closest?.('[data-ux-conflict]');if(!control)return;
    e.preventDefault();e.stopImmediatePropagation();
    const form=control.closest('#taskform');if(!form)return;
    const action=control.dataset.uxConflict;
    const date=form.elements.fromDate?.value||ui.date;
    if(action==='back'){form.querySelector('#taskConflictWarning')?.remove();return;}
    if(action==='after'){
      const start=form.dataset.afterStart,end=form.dataset.afterEnd;
      if(!start||!end){form.querySelector('#taskConflictWarning')?.remove();return;}
      form.elements.start.value=start;form.elements.end.value=end;
      form.querySelector('#taskConflictWarning')?.remove();
      form.requestSubmit();
      return;
    }
    if(action==='nest'){
      if(form.dataset.conflictProtected==='1')return;
      const id=form.dataset.nestId,name=form.dataset.nestName||'блок';
      if(!id)return;
      if(!confirm('Сделать «'+name+'» блоком-контейнером и добавить дело внутрь?'))return;
      try{S.containers=S.containers||{};S.containers[id]=true;persist()}catch(err){}
      form.elements.parentId.value=id;
      form.querySelector('#taskConflictWarning')?.remove();
      form.requestSubmit();
      return;
    }
    if(action==='find'){
      const parentId=form.elements.parentId?.value||'';
      const slot=parentId?slotWithinBlock(date,parentId,form.elements.start.value,form.elements.end.value):freeSlot(date,form.elements.id.value,form.elements.start.value,form.elements.end.value);
      if(!slot){showNotice(form,'Свободного окна не найдено',parentId?'Внутри этого блока не осталось места. Увеличьте блок или выберите другое время.':'Для выбранной длительности до 23:30 свободного места нет. Уменьши длительность или перенеси дело на другой день.');return;}
      form.elements.start.value=slot.start;
      form.elements.end.value=slot.end;
      form.querySelector('#taskConflictWarning')?.remove();
      form.requestSubmit();
      return;
    }
    if(action==='anyway'&&form.dataset.conflictProtected!=='1'){
      form.dataset.allowOverlap='yes';
      form.requestSubmit();
    }
  },true);
  // Manual theme override; system preference remains default.
  const THEME_KEY='jarvis_ui_theme';
  function applyTheme(mode){
    const choice=['auto','light','dark'].includes(mode)?mode:'auto';
    if(choice==='auto')delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme=choice;
    try{localStorage.setItem(THEME_KEY,choice)}catch{}
  }
  try{applyTheme(localStorage.getItem(THEME_KEY)||'auto')}catch{}
  document.addEventListener('click',e=>{
    const target=e.target.closest?.('[data-ux-theme]');if(!target)return;
    e.preventDefault();e.stopImmediatePropagation();
    applyTheme(target.dataset.uxTheme);
    const root=target.parentElement;
    if(root)for(const b of root.querySelectorAll('[data-ux-theme]'))b.setAttribute('aria-pressed',String(b===target));
  },true);
  window.jarvisTaskConflict={conflicts,freeSlot};
})();
