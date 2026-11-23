/* JARVIS Routine v44.0 — Intelligent Planning layer.
 *
 * One decision path over the EXISTING engine:
 *   smart.js  buildSmartPlan / smartReplan / revertPlan  (goals: gentle|balanced|
 *             productive|low; returns exact changes and keeps an undo snapshot)
 *   flex.js   previewLate / previewEnergy / applyPreview  (flexible policy)
 *
 * No second scheduler. It reads the current day, proposes real free windows and
 * up to three genuinely different validated plans, previews exact before→after
 * changes, applies only after confirmation and keeps a reversible undo.
 *
 * PRIVACY: local state only. No network, no personal data shipped. */
(function (root, factory) {
  const api = factory(root);
  root.JarvisPlanner = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const UI = () => (typeof ui !== 'undefined' ? ui : null);
  const ST = () => (typeof S !== 'undefined' ? S : null);
  const todayISO = () => (typeof today === 'function' ? today() : '');
  const curDay = () => (UI() && UI().date) || todayISO();
  const esc = x => String(x == null ? '' : x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hhmm = m => (typeof niceTime === 'function' ? niceTime(m) : '');
  const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
  const rows = s => { try { return typeof itemList === 'function' ? (itemList(s) || []) : []; } catch (e) { return []; } };
  const baseRows = s => { try { return typeof baseItemList === 'function' ? (baseItemList(s) || []) : rows(s); } catch (e) { return rows(s); } };
  const isFixed = (t, s) => (typeof anchorTask === 'function' ? anchorTask(t, s) : false);
  const isDone = (s, t) => (typeof done === 'function' ? !!done(s, t.id) : false);
  const isLive = t => t && t.status !== 'Буфер' && t.cat !== 'Буфер';
  const isToday = s => s === todayISO();
  const durationOf = t => Math.max(5, clock(t.end) - clock(t.start));
  const isWorkTask = t => /^(Код|Математика|Университет|Карьера)$/.test(t.cat) || /python|код|матем|проект|учёб|курсов|контрольн/i.test(t.name);
  const isMandatory = t => t.status === 'Обязательно' || ['Питание', 'Гигиена', 'Сон', 'Перерыв'].includes(t.cat);
  const shiftDate = (s, n) => (typeof shift === 'function' ? shift(s, n) : s);
  const indexDay = s => (typeof indexDay === 'function' ? indexDay(s) : 0);
  const DAY_END = 23 * 60 + 30;
  /* Confirmed planning rules from shared memory (e.g. avoid evening for a task). */
  function rules() { try { return (root.JarvisMemory && root.JarvisMemory.avoidEvening) ? root.JarvisMemory.avoidEvening() : []; } catch (e) { return []; } }
  /* FLIP: animate task cards from their old to new layout after a replan. */
  function flipTasks(mutate) {
    const before = new Map();
    try { document.querySelectorAll('.task-row[data-task-id]').forEach(el => before.set(el.dataset.taskId, el.getBoundingClientRect())); } catch (e) {}
    mutate();
    try {
      requestAnimationFrame(() => {
        document.querySelectorAll('.task-row[data-task-id]').forEach(el => {
          const b = before.get(el.dataset.taskId); if (!b) return;
          const a = el.getBoundingClientRect();
          const dx = b.left - a.left, dy = b.top - a.top;
          if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
          el.animate([{ transform: 'translate(' + dx + 'px,' + dy + 'px)' }, { transform: 'none' }], { duration: 320, easing: 'cubic-bezier(.22,1,.36,1)' });
        });
      });
    } catch (e) {}
  }

  function busyIntervals(s) {
    return rows(s).filter(t => isLive(t) && !isDone(s, t.id))
      .map(t => ({ start: clock(t.start), end: clock(t.end), name: t.name, fixed: isFixed(t, s) }))
      .filter(x => x.end > x.start).sort((a, b) => a.start - b.start);
  }

  function freeWindows(s, minMin) {
    s = s || curDay(); minMin = Math.max(5, Number(minMin) || 10);
    const start = Math.max(clock(wakeTime(s)), isToday(s) ? nowMin() : 0);
    const busy = busyIntervals(s); const out = []; let cur = start;
    for (const b of busy) {
      if (b.end <= cur) continue;
      if (b.start > cur) out.push({ start: cur, end: Math.min(b.start, DAY_END) });
      cur = Math.max(cur, b.end); if (cur >= DAY_END) break;
    }
    if (cur < DAY_END) out.push({ start: cur, end: DAY_END });
    return out.filter(w => w.end - w.start >= minMin)
      .map(w => ({ start: w.start, end: w.end, minutes: w.end - w.start, label: hhmm(w.start) + '–' + hhmm(w.end) }));
  }

  function whatNow(s) {
    s = s || curDay();
    const m = nowMin();
    const list = rows(s).filter(t => isLive(t) && !isDone(s, t.id));
    const cur = isToday(s) ? list.find(t => clock(t.start) <= m && clock(t.end) > m) : null;
    const next = (isToday(s) ? list.filter(t => clock(t.end) > m).sort((a, b) => clock(a.start) - clock(b.start)).find(t => t !== cur) : list.slice().sort((a, b) => clock(a.start) - clock(b.start))[0]) || null;
    const win = freeWindows(s, 10)[0];
    let text;
    if (cur) text = 'Сейчас: ' + cur.name + ' — до ' + cur.end + '.';
    else if (win && next && win.end <= clock(next.start)) text = 'Есть ' + win.minutes + ' мин до «' + next.name + '» (' + next.start + '). Можно начать приоритетное дело или короткий фокус.';
    else if (next) text = 'Ближайшее: ' + next.name + ' в ' + next.start + '–' + next.end + '.';
    else if (win) text = 'Свободно ' + win.minutes + ' мин (' + win.label + ').';
    else text = 'На сегодня всё расписано — можно отдыхать.';
    return { cur, next, window: win, text };
  }

  function insight(s) {
    s = s || curDay();
    const st = ST(); if (!st) return null;
    if (st._insightLater === s) return null;
    if (!(typeof scheduleReady === 'function' ? scheduleReady() : true)) return null;
    const m = nowMin();
    const list = rows(s).filter(t => isLive(t) && !isDone(s, t.id));
    const nextFixed = isToday(s) ? list.filter(t => isFixed(t, s) && clock(t.start) > m).sort((a, b) => clock(a.start) - clock(b.start))[0] : null;
    const win = freeWindows(s, 25)[0];
    if (win && (!nextFixed || win.end <= clock(nextFixed.start))) {
      const until = nextFixed ? ' до «' + nextFixed.name + '»' : '';
      return { kind: 'window', title: 'Есть ' + win.minutes + ' свободных минут' + until, text: 'Хорошее окно для короткого фокус-блока или приоритетного дела.', action: 'optimize' };
    }
    try {
      if (typeof root.buildSmartPlan === 'function') {
        const plan = root.buildSmartPlan(s, {});
        if (plan && plan.overload > 0) return { kind: 'overload', title: 'День перегружен примерно на ' + Math.round(plan.overload) + ' мин', text: 'Можно перенести или сократить второстепенное и сохранить обязательное.', action: 'optimize' };
      }
    } catch (e) {}
    return null;
  }

  function buildPreview(s, opts) {
    s = s || curDay();
    if (typeof root.buildSmartPlan !== 'function') return null;
    const plan = root.buildSmartPlan(s, Object.assign({ avoidEvening: rules() }, opts || {}));
    const changes = [];
    for (const x of plan.moved || []) changes.push({ kind: 'move', name: x.name, from: x.from != null ? hhmm(x.from) : '', to: x.to != null ? hhmm(x.to) : '', why: x.reason || 'Перенесено в свободное окно' });
    for (const x of plan.transfers || []) changes.push({ kind: 'transfer', name: (x.task && x.task.name) || '', to: x.date, at: x.start, why: 'Перенесено на другой день' });
    for (const x of plan.expired || []) changes.push({ kind: 'expire', name: (x.t && x.t.name) || '', why: x.reason || 'Время прошло' });
    for (const x of plan.skipped || []) changes.push({ kind: 'skip', name: (x.t && x.t.name) || '', why: x.reason || 'Не поместилось' });
    for (const x of plan.released || []) changes.push({ kind: 'release', name: (x.t && x.t.name) || '', why: x.reason || 'Освобождено время' });
    return { plan, changes, overload: plan.overload || 0, fixed: plan.fixed || 0, placed: plan.placed || 0 };
  }

  function summaryOf(pv, s) {
    const base = baseRows(s).filter(t => isLive(t) && !isDone(s, t.id));
    const res = pv.plan.result || {};
    let workMin = 0, freeMin = 0, req = 0, reqKept = 0;
    for (const t of base) {
      const o = res[t.id]; const dur = durationOf(t);
      const planned = (o && o.start && o.end) ? Math.max(5, clock(o.end) - clock(o.start)) : dur;
      if (t.status === 'Обязательно') { req++; if (!(o && o.omit)) reqKept++; }
      if (o && o.omit) freeMin += dur; else if (isWorkTask(t) && !isMandatory(t) && !isFixed(t, s)) workMin += planned;
    }
    return { changes: pv.changes.length, moves: (pv.plan.moved || []).length + (pv.plan.transfers || []).length, omitted: (pv.plan.expired || []).length + (pv.plan.skipped || []).length + (pv.plan.released || []).length, workMin, freeMin, req, reqKept };
  }

  const LABELS = { gentle: 'Бережный', balanced: 'Сбалансированный', productive: 'Продуктивный', low: 'Щадящий' };
  function buildVariants(s) {
    const out = [], seen = new Set();
    for (const g of ['gentle', 'balanced', 'productive']) {
      const pv = buildPreview(s, { goal: g }); if (!pv) continue;
      const sig = JSON.stringify(pv.changes);
      if (seen.has(sig)) continue; seen.add(sig);
      out.push({ goal: g, label: LABELS[g], pv, summary: summaryOf(pv, s) });
    }
    return out;
  }

  let _sel = null; // { s, goal, variants }
  function dialog(html) {
    const mb = document.getElementById('modalbox'), back = document.getElementById('modalback');
    if (!mb || !back) return false;
    mb.innerHTML = html; back.classList.add('show'); back.setAttribute('aria-hidden', 'false');
    return true;
  }
  function close() { _pending = null; if (typeof modalClose === 'function') modalClose(); }

  function changeRows(changes) {
    if (!changes || !changes.length) return '<p class="tagline">Дополнительные перестановки не нужны — план уже реалистичен.</p>';
    return changes.map(c => {
      const when = c.kind === 'move' ? (c.from ? c.from + ' → ' + c.to : '') : (c.kind === 'transfer' ? 'на ' + c.date + ' ' + (c.at || '') : '');
      return `<div class="plan-change"><div class="plan-change-top"><b>${esc(c.name)}</b>${when ? `<span>${esc(when)}</span>` : ''}</div><small>${esc(c.why)}</small></div>`;
    }).join('');
  }
  function summaryLine(S) {
    const parts = [];
    parts.push(S.changes + ' изм.');
    if (S.moves) parts.push(S.moves + ' перенос');
    if (S.omitted) parts.push(S.omitted + ' снято');
    parts.push('гибкая работа ' + S.workMin + ' мин');
    parts.push('свободно ' + S.freeMin + ' мин');
    if (S.req) parts.push('обязательных ' + S.reqKept + '/' + S.req);
    return parts.join(' · ');
  }

  function renderOptimize() {
    if (!_sel) return;
    const v = _sel.variants.find(x => x.goal === _sel.goal) || _sel.variants[0];
    const tabs = _sel.variants.length > 1
      ? `<div class="variant-tabs" role="tablist">${_sel.variants.map(x => `<button role="tab" aria-selected="${x.goal === v.goal}" data-plan="variant" data-goal="${x.goal}" class="${x.goal === v.goal ? 'sel' : ''}">${esc(x.label)}</button>`).join('')}</div>`
      : '';
    dialog(`<div class="modalhead"><h2>Оптимизировать день</h2><button class="iconbtn" data-plan="cancel" aria-label="Закрыть">×</button></div>
      <p class="tagline">Выбери вариант. Фиксированные события, сон и выполненные дела не двигаются.</p>
      ${tabs}
      <p class="variant-summary">${esc(summaryLine(v.summary))}</p>
      ${v.pv.overload > 0 ? `<p class="wakeconflict">Не хватает примерно ${Math.round(v.pv.overload)} минут — часть гибких дел будет перенесена или сокращена.</p>` : ''}
      <div class="card compact plan-changes">${changeRows(v.pv.changes)}</div>
      <div class="plan-actions"><button class="btn primary" data-plan="apply">Применить</button><button class="btn" data-plan="cancel">Отмена</button></div>`);
  }

  function previewOptimize(s, opts) {
    s = s || curDay();
    const goal = (opts && opts.goal) || 'balanced';
    if (goal === 'low') {
      const pv = buildPreview(s, { goal: 'low' });
      if (!pv) { try { toast('Планировщик недоступен'); } catch (e) {} return null; }
      _sel = { s, goal: 'low', variants: [{ goal: 'low', label: LABELS.low, pv, summary: summaryOf(pv, s) }] };
      renderOptimize(); return pv;
    }
    const variants = buildVariants(s);
    if (!variants.length) { try { toast('Планировщик недоступен'); } catch (e) {} return null; }
    _sel = { s, goal: variants.some(v => v.goal === 'balanced') ? 'balanced' : variants[0].goal, variants };
    renderOptimize();
    return variants.find(v => v.goal === _sel.goal).pv;
  }

  function applyOptimize(s, opts) {
    s = s || curDay();
    const goal = (opts && opts.goal) || (_sel && _sel.goal) || 'balanced';
    try {
      if (typeof root.smartReplan !== 'function') { toast('Планировщик недоступен'); return false; }
      const st = ST(); if (st) delete st._plannerUndo;
      flipTasks(() => root.smartReplan(s, { silent: true, goal, avoidEvening: rules() }));
      if (root.JarvisQuick && typeof root.JarvisQuick.toastAction === 'function') root.JarvisQuick.toastAction('План применён', 'Отменить', () => undo(s));
      else { try { toast('План применён. Можно отменить.'); } catch (e) {} }
      return true;
    } catch (e) { try { toast('Не удалось применить план'); } catch (e2) {} return false; }
  }

  /* ── custom single actions (move / add / free evening) ── */
  function snapshot(s) {
    const st = ST(); if (!st) return null;
    return { s, adjust: JSON.parse(JSON.stringify((st.dayAdjust && st.dayAdjust[s]) || {})), extras: JSON.parse(JSON.stringify(st.extras || [])) };
  }
  function restore(snap) {
    const st = ST(); if (!st || !snap) return;
    if (!st.dayAdjust) st.dayAdjust = {};
    st.dayAdjust[snap.s] = snap.adjust; st.extras = snap.extras;
    try { persist(); } catch (e) {} try { render(); } catch (e) {}
  }
  function undo(s) {
    s = s || curDay();
    const st = ST();
    if (st && st._plannerUndo && st._plannerUndo.s === s) { const snap = st._plannerUndo; delete st._plannerUndo; restore(snap); return true; }
    if (typeof root.revertPlan === 'function') { root.revertPlan(s); return true; }
    try { toast('Нечего отменять'); } catch (e) {} return false;
  }
  let _pending = null; // { s, run }
  function commitAction() {
    if (!_pending) return;
    const st = ST(); if (!st) return;
    const s = _pending.s, run = _pending.run;
    _pending = null;
    st._plannerUndo = snapshot(s);
    try { run(st); } catch (e) { try { toast('Не удалось применить'); } catch (e2) {} return; }
    try { persist(); } catch (e) {}
    try { render(); } catch (e) {}
    if (root.JarvisQuick && typeof root.JarvisQuick.toastAction === 'function') root.JarvisQuick.toastAction('Применено', 'Отменить', () => undo(s));
    else { try { toast('Применено. Можно отменить.'); } catch (e) {} }
  }

  function findTask(s, q) {
    const n = String(q || '').toLowerCase().replace(/[«»"]/g, '').trim();
    if (!n) return null;
    const list = rows(s).filter(t => isLive(t) && !isDone(s, t.id));
    return list.find(t => t.name.toLowerCase() === n) || list.find(t => t.name.toLowerCase().includes(n)) || null;
  }
  function resolveTarget(when, s) {
    const w = String(when || '').toLowerCase();
    if (/послезавтра/.test(w)) return shiftDate(s, 2);
    if (/завтра/.test(w)) return shiftDate(s, 1);
    const days = { 'понедельник': 0, 'вторник': 1, 'среда': 2, 'среду': 2, 'четверг': 3, 'пятниц': 4, 'суббот': 5, 'воскрес': 6 };
    for (const k in days) if (w.includes(k)) { let d = days[k] - indexDay(s); if (d <= 0) d += 7; return shiftDate(s, d); }
    return shiftDate(s, 1);
  }
  function dateTitle(s) { try { return typeof dateTitleText === 'function' ? dateTitleText(s) : s; } catch (e) { return s; } }

  function command(text) {
    const t = String(text || '').toLowerCase();
    const s = curDay();
    try { if (root.JarvisActions && root.JarvisActions.tryLocal) { const r = root.JarvisActions.tryLocal(t); if (r) return { kind: 'answer', text: r }; } } catch (e) {}
    if (/отмен/.test(t) && /(последн|изменен|перепланир|перенос)/.test(t)) { undo(s); return { kind: 'answer', text: 'Отменил последнее изменение, сохранив последующие.' }; }
    if (/почему/.test(t) && /(перенос|предлож|план|сдвин)/.test(t)) return { kind: 'answer', text: explainLast() };
    if (/что\s+(?:мне\s+)?(?:лучше\s+)?(?:сделать\s+)?(?:сейчас|дальше)|что\s+делать|чем\s+заняться/.test(t)) return { kind: 'answer', ...whatNow(s) };
    if (/свободн|окно|когда\s+.*(?:можно|свобод)|покажи\s+время/.test(t)) return { kind: 'windows', windows: freeWindows(s, 10) };
    if (/не\s+трогай.*(?:универ|пары|трениров|зал)/.test(t)) return { kind: 'answer', text: 'Университет, тренировка и другие фиксированные события уже защищены: планировщик их не двигает. Могу перепланировать только гибкие дела.' };

    const mv = t.match(/перенеси\s+(.+?)\s+на\s+(завтра|послезавтра|понедельник|вторник|среду|среда|четверг|пятниц\w*|суббот\w*|воскрес\w*)/);
    if (mv) return moveCommand(s, mv[1].trim(), mv[2]);

    if (/освобод/.test(t) && /вечер/.test(t)) return freeEveningCommand(s);
    if (/необязательн/.test(t) && /выходн/.test(t)) return { kind: 'answer', text: 'Перенос пачкой на выходные пока не поддерживается. Могу освободить вечер сегодня или перенести конкретное дело — назови его.' };

    const add = t.match(/добав(?:ь|ить)\s+(.+)/);
    if (add) return addCommand(s, add[1]);

    const only = t.match(/только\s+(\d+)\s*мин/);
    if (only) { previewOptimize(s, { goal: 'low' }); return { kind: 'answer', text: 'Готовлю щадящий план: обязательное сохраняю, гибкую нагрузку сокращаю до короткого блока (' + Math.min(25, Number(only[1])) + ' мин).' }; }

    if (/мало\s+сил|устал|нет\s+сил|отдохн|низк.*энерг/.test(t)) { previewOptimize(s, { goal: 'low' }); return { kind: 'answer', text: 'Готовлю щадящий план на день: обязательное и сон не трогаю, оставляю один короткий блок. Проверь и примени.' }; }
    if (/проспал|поздно\s+встал|опозд/.test(t)) { previewOptimize(s, { goal: 'balanced' }); return { kind: 'answer', text: 'Готовлю план после опоздания: фиксированные события на месте, гибкие перенесу в реальные свободные окна.' }; }
    if (/перепланир|оптимизир|пересобер|перестро|распланир|перераспредели/.test(t)) { previewOptimize(s); return { kind: 'answer', text: 'Подготовил варианты плана — выбери подходящий и проверь изменения.' }; }
    return { kind: 'unknown' };
  }

  let _lastChanges = null;
  function explainLast() {
    if (!_lastChanges || !_lastChanges.length) return 'Пока не было предложений о переносе. Скажи «перепланируй день» — покажу изменения с причиной.';
    const top = _lastChanges.slice(0, 3).map(c => '• ' + (c.name || '') + (c.from ? ' (' + c.from + '→' + c.to + ')' : '') + ' — ' + (c.why || 'перенос в свободное окно')).join('\n');
    return 'Причины последнего предложения:\n' + top + '\nФиксированные события и сон не двигались.';
  }

  function moveCommand(s, q, when) {
    const task = findTask(s, q);
    if (!task) return { kind: 'answer', text: 'Не нашёл «' + q + '» в расписании сегодня. Уточни название.' };
    const target = resolveTarget(when, s), dur = durationOf(task);
    const win = freeWindows(target, dur)[0];
    if (!win) return { kind: 'answer', text: 'На ' + target + ' нет свободного окна на ' + dur + ' мин. Могу сократить задачу или перенести на другой день.' };
    const start = hhmm(win.start), end = hhmm(win.start + dur);
    _lastChanges = [{ name: task.name, from: task.start, to: start, why: 'перенос на ' + target + ' в свободное окно' }];
    _pending = { s, run: st => { (st.dayAdjust[s] || (st.dayAdjust[s] = {}))[task.id] = { omit: true }; st.extras = st.extras || []; st.extras.push({ id: 'x_mv_' + s.replace(/-/g, '') + '_' + String(task.id).replace(/[^\w]/g, '_'), name: task.name, cat: task.cat, status: task.status, note: task.note || '', start, end, fromDate: target, repeat: 'once' }); } };
    dialog(`<div class="modalhead"><h2>Перенести задачу</h2><button class="iconbtn" data-plan="cancel" aria-label="Закрыть">×</button></div><div class="card compact plan-changes"><div class="plan-change"><div class="plan-change-top"><b>${esc(task.name)}</b><span>${esc(task.start)}–${esc(task.end)} → ${esc(target)} ${esc(start)}</span></div><small>Перенос на другой день; обязательные события не затрагиваются</small></div></div><div class="plan-actions"><button class="btn primary" data-plan="applyAction">Применить</button><button class="btn" data-plan="cancel">Отмена</button></div>`);
    return { kind: 'answer', text: 'Подготовил перенос «' + task.name + '» на ' + target + ' ' + start + '. Проверь и нажми «Применить».' };
  }

  function addCommand(s, rest) {
    const r = String(rest || '');
    let mins = 60;
    if (/полчас/.test(r)) mins = 30;
    else if (/(\d+)\s*час/.test(r)) mins = Math.min(240, Number(r.match(/(\d+)\s*час/)[1]) * 60);
    else if (/(\d+)\s*мин/.test(r)) mins = Math.min(240, Number(r.match(/(\d+)\s*мин/)[1]));
    else if (/час/.test(r)) mins = 60;
    const target = /завтра/.test(r) ? shiftDate(s, 1) : s;
    const evening = /вечер/.test(r);
    let name = r.replace(/добавь|добавить|полчаса|(\d+)\s*час\w*|(\d+)\s*мин\w*|час\w*|вечером|утром|днём|сегодня|завтра|на\s+/gi, ' ').replace(/\s+/g, ' ').trim() || 'Дело';
    name = name.charAt(0).toUpperCase() + name.slice(1);
    const wins = freeWindows(target, mins).filter(w => !evening || w.start >= 18 * 60);
    let win = wins[0] || freeWindows(target, mins)[0];
    let used = mins;
    if (!win) {
      // No full window: offer the largest real gap (>=15 min) instead of inventing time.
      const all = freeWindows(target, 15).filter(w => !evening || w.start >= 18 * 60);
      all.sort((a, b) => b.minutes - a.minutes);
      if (all[0]) { win = all[0]; used = Math.min(win.minutes, mins); }
    }
    if (!win) return { kind: 'answer', text: 'На ' + target + ' нет свободного окна на ' + mins + ' мин. Уточни длительность или день.' };
    const start = hhmm(win.start), end = hhmm(win.start + used);
    _lastChanges = [{ name, from: '', to: start, why: 'новый блок ' + used + ' мин на ' + target }];
    _pending = { s, run: st => { st.extras = st.extras || []; st.extras.push({ id: 'x_ad_' + target.replace(/-/g, '') + '_' + Date.now().toString(36), name, cat: isWorkTask({ name, cat: '' }) ? 'Код' : 'Организация', status: 'Гибко', note: '', start, end, fromDate: target, repeat: 'once' }); } };
    dialog(`<div class="modalhead"><h2>Добавить блок</h2><button class="iconbtn" data-plan="cancel" aria-label="Закрыть">×</button></div><div class="card compact plan-changes"><div class="plan-change"><div class="plan-change-top"><b>${esc(name)}</b><span>${esc(target)} ${esc(start)}–${esc(end)}</span></div><small>${used} мин в свободном окне${used < mins ? ' (сократил с ' + mins + ' мин — больше нет)' : ''}</small></div></div><div class="plan-actions"><button class="btn primary" data-plan="applyAction">Применить</button><button class="btn" data-plan="cancel">Отмена</button></div>`);
    return { kind: 'answer', text: 'Подготовил блок «' + name + '» на ' + target + ' ' + start + '–' + end + (used < mins ? ' (сократил до ' + used + ' мин)' : '') + '. Проверь и нажми «Применить».' };
  }

  function freeEveningCommand(s) {
    const tasks = rows(s).filter(t => isLive(t) && !isDone(s, t.id) && !isFixed(t, s) && !isMandatory(t) && clock(t.start) >= 18 * 60);
    if (!tasks.length) return { kind: 'answer', text: 'После 18:00 нет гибких дел — вечер уже свободен.' };
    _lastChanges = tasks.map(t => ({ name: t.name, from: t.start, to: '', why: 'освобождение вечера' }));
    _pending = { s, run: st => { const adj = st.dayAdjust[s] || (st.dayAdjust[s] = {}); for (const t of tasks) adj[t.id] = { omit: true }; } };
    dialog(`<div class="modalhead"><h2>Освободить вечер</h2><button class="iconbtn" data-plan="cancel" aria-label="Закрыть">×</button></div><p class="tagline">Снять гибкие дела после 18:00. Обязательное и фиксированное останется.</p><div class="card compact plan-changes">${changeRows(_lastChanges)}</div><div class="plan-actions"><button class="btn primary" data-plan="applyAction">Применить</button><button class="btn" data-plan="cancel">Отмена</button></div>`);
    return { kind: 'answer', text: 'Подготовил освобождение вечера: ' + tasks.length + ' гибких дел. Проверь и нажми «Применить».' };
  }

  /* ── UI wiring (browser only) ── */
  if (typeof document !== 'undefined' && typeof root.todayView === 'function') {
    const prevToday = root.todayView;
    root.todayView = function () {
      const html = prevToday.apply(this, arguments);
      const s = (UI() && UI().date) || todayISO();
      const ins = insight(s);
      if (!ins) return html;
      const card = `<section class="card insight-card" aria-label="Рекомендация JARVIS"><div class="insight-top"><span class="spark" aria-hidden="true">✦</span><b>${esc(ins.title)}</b></div><p class="tagline">${esc(ins.text)}</p><div class="insight-actions"><button class="btn tight primary" data-opt="optimize">Оптимизировать</button><button class="btn tight" data-opt="later">Позже</button></div></section>`;
      const marker = '<section class="card goals-card"';
      if (html.includes(marker)) return html.replace(marker, card + marker);
      const alt = '<div class="filter-row"';
      return html.includes(alt) ? html.replace(alt, card + alt) : html.replace('<div class="subhead">', card + '<div class="subhead">');
    };
  }
  if (typeof document !== 'undefined' && typeof root.plannerView === 'function') {
    const prevPlanner = root.plannerView;
    root.plannerView = function () {
      const html = prevPlanner.apply(this, arguments);
      const action = '<div class="planner-actions"><button class="btn tight primary" data-opt="optimize">✦ Оптимизировать день</button><button class="btn tight" data-opt="free">Свободное время</button></div>';
      const marker = '<section class="jr-date-nav"';
      if (html.includes(marker)) return html.replace(marker, action + marker);
      return html.replace('<div class="subhead">', action + '<div class="subhead">');
    };
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('click', function (e) {
      const el = e.target.closest && e.target.closest('[data-plan]');
      if (el) {
        e.preventDefault();
        const a = el.dataset.plan;
        if (a === 'variant') { if (_sel && el.dataset.goal) { _sel.goal = el.dataset.goal; renderOptimize(); } }
        else if (a === 'apply') { const ok = applyOptimize(_sel && _sel.s, { goal: _sel && _sel.goal }); close(); if (ok) { try { render(); } catch (err) {} } }
        else if (a === 'applyAction') { commitAction(); close(); }
        else close();
        return;
      }
      const opt = e.target.closest && e.target.closest('[data-opt]');
      if (!opt) return;
      e.preventDefault(); e.stopPropagation();
      const s = curDay(); const a = opt.dataset.opt;
      if (a === 'optimize') previewOptimize(s);
      else if (a === 'free') {
        const w = freeWindows(s, 10);
        dialog(`<div class="modalhead"><h2>Свободное время</h2><button class="iconbtn" data-plan="cancel" aria-label="Закрыть">×</button></div>${w.length ? w.map(x => `<div class="plan-change"><div class="plan-change-top"><b>${esc(x.label)}</b><span>${x.minutes} мин</span></div></div>`).join('') : '<p class="tagline">Свободных окон от 10 минут нет.</p>'}<div class="plan-actions"><button class="btn" data-plan="cancel">Закрыть</button></div>`);
      }
      else if (a === 'later') { const st = ST(); if (st) { st._insightLater = s; try { persist(); } catch (err) {} } try { render(); } catch (err) {} }
    });
  }

  /* Include the insight on the first paint even though this module loads last. */
  try { if (typeof root.render === 'function') root.render(); } catch (e) {}
  try { root.JarvisFlip = flipTasks; } catch (e) {}

  return { VERSION: '44.0', curDay, freeWindows, whatNow, insight, buildPreview, buildVariants, previewOptimize, applyOptimize, undo, command };
});
