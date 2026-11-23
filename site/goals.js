/* JARVIS Routine v43.2 — "Мои 2–3 цели дня".
   A small, self-contained layer over the existing planner. The user picks 2–3
   concrete goals for the day from the real schedule or as a custom line. Goals
   are ordered (priority), reversible, capped at three, and never auto-completed.
   Completion reuses the canonical S.done map, so a goal linked to a schedule
   task and that task's row stay in sync.

   PRIVACY: ships no personal data. Goals live only in the user's local state
   (S.goals), never in site/ files, Git, or any public output. */
(function (root, factory) {
  const api = factory(root);
  root.JarvisGoals = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const MAX_GOALS = 3;

  /* ── pure helpers (unit-tested in Node, no DOM, no globals) ── */
  function normalizeText(x) { return String(x == null ? '' : x).replace(/\s+/g, ' ').trim().slice(0, 80); }
  function cleanList(list) {
    if (!Array.isArray(list)) return [];
    const seen = new Set(), out = [];
    for (const g of list) {
      if (!g || typeof g !== 'object' || typeof g.id !== 'string' || !g.id) continue;
      if (seen.has(g.id)) continue;
      seen.add(g.id);
      out.push({ id: g.id, taskId: typeof g.taskId === 'string' && g.taskId ? g.taskId : null, text: normalizeText(g.text) });
      if (out.length >= MAX_GOALS) break;
    }
    return out;
  }
  function addGoal(list, entry) {
    const base = cleanList(list);
    if (!entry || typeof entry.id !== 'string' || !entry.id) return base;
    if (base.some(g => g.id === entry.id)) return base;
    if (base.length >= MAX_GOALS) return base;
    return base.concat([{ id: entry.id, taskId: typeof entry.taskId === 'string' && entry.taskId ? entry.taskId : null, text: normalizeText(entry.text) }]);
  }
  function removeGoal(list, id) { return cleanList(list).filter(g => g.id !== id); }
  function moveGoal(list, id, dir) {
    const l = cleanList(list);
    const i = l.findIndex(g => g.id === id);
    if (i < 0) return l;
    const j = dir < 0 ? i - 1 : i + 1;
    if (j < 0 || j >= l.length) return l;
    const out = l.slice(), tmp = out[i];
    out[i] = out[j]; out[j] = tmp;
    return out;
  }

  /* ── app-global accessors (declared with let/const in the page shell) ── */
  const UI = () => (typeof ui !== 'undefined' && ui) ? ui : null;
  const ST = () => (typeof S !== 'undefined' && S) ? S : null;
  const todayISO = () => (typeof today === 'function') ? today() : '';
  const esc = x => String(x == null ? '' : x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isCheckable = t => (typeof root.isCheckable === 'function') ? root.isCheckable(t) : (t && t.status !== 'Буфер');
  const isDone = (s, id) => (typeof root.done === 'function') ? !!root.done(s, id) : false;
  const listTasks = s => (typeof root.itemList === 'function') ? (root.itemList(s) || []) : [];
  const clockMin = t => (typeof root.clock === 'function') ? root.clock(t) : 0;

  function store() { const st = ST(); if (!st) return null; if (!st.goals || typeof st.goals !== 'object' || Array.isArray(st.goals)) st.goals = {}; return st.goals; }
  function goalsFor(s) { const gs = store(); return gs ? cleanList(gs[s]) : []; }
  function setGoalsFor(s, list) { const gs = store(); if (gs) gs[s] = cleanList(list); }
  function goalText(s, g) {
    if (g.taskId) { const t = listTasks(s).find(x => x && x.id === g.taskId); if (t) return t.name; }
    return g.text;
  }

  /* ── rendering ── */
  let customOpen = false;

  function candidates(s, chosen) {
    return listTasks(s)
      .filter(t => t && t.id && isCheckable(t) && !chosen.has(t.id))
      .sort((a, b) => clockMin(a.start) - clockMin(b.start))
      .slice(0, 4);
  }

  function cardHTML(s) {
    if (!ST()) return '';
    const list = goalsFor(s);
    const doneN = list.filter(g => isDone(s, g.id)).length;
    const rows = list.map((g, i) => `<li class="goal-row ${isDone(s, g.id) ? 'done' : ''}">
        <input type="checkbox" class="task-check" aria-label="Цель: ${esc(goalText(s, g))}" data-date="${esc(s)}" data-id="${esc(g.id)}" ${isDone(s, g.id) ? 'checked' : ''}>
        <span class="goal-order" aria-hidden="true">${i + 1}</span>
        <span class="goal-text">${esc(goalText(s, g))}</span>
        <span class="goal-tools">
          <button class="goal-tool" data-goal="up" data-id="${esc(g.id)}" aria-label="Повысить приоритет" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="goal-tool" data-goal="down" data-id="${esc(g.id)}" aria-label="Понизить приоритет" ${i === list.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="goal-tool" data-goal="remove" data-id="${esc(g.id)}" aria-label="Убрать цель из дня">✕</button>
        </span>
      </li>`).join('');
    const chosen = new Set(list.map(g => g.id));
    const cands = list.length >= MAX_GOALS ? [] : candidates(s, chosen);
    let addZone = '';
    if (list.length >= MAX_GOALS) {
      addZone = '<p class="goal-hint">Три цели — достаточно на сегодня. Сними или замени одну, чтобы изменить план.</p>';
    } else {
      addZone = (cands.length ? `<div class="goal-candidates">${cands.map(t => `<button class="goal-chip" data-goal="pick" data-id="${esc(t.id)}">＋ ${esc(t.name)}</button>`).join('')}</div>` : '')
        + (customOpen
          ? '<div class="goal-custom"><input id="goalCustomInput" maxlength="80" inputmode="text" placeholder="Своя цель" aria-label="Своя цель"><button class="btn tight primary" data-goal="save">ОК</button><button class="btn tight" data-goal="cancel">Отмена</button></div>'
          : '<button class="btn tight" data-goal="custom">✎ Своя цель</button>');
    }
    const empty = list.length ? '' : '<p class="goal-hint">Выбери 2–3 главных дела на сегодня.</p>';
    return `<section class="card goals-card" id="goalsCard" aria-label="Мои цели дня">
      <details class="goals-details" ${list.length ? 'open' : ''}>
      <summary class="goals-head"><span class="eyebrow">МОИ ЦЕЛИ ДНЯ</span><span class="goals-count">${doneN}/${list.length || MAX_GOALS}${list.length ? '' : ' · выбрать'}</span></summary>
      <div class="goals-body">${empty}${rows ? `<ul class="goals-list">${rows}</ul>` : ''}${addZone}</div>
      </details>
    </section>`;
  }

  function inject(html, s) {
    const card = cardHTML(s);
    if (!card) return html;
    const marker = '<div class="filter-row"';
    return html.includes(marker) ? html.replace(marker, card + marker) : html;
  }

  /* ── wiring (browser only) ── */
  function styles() {
    if (typeof document === 'undefined' || document.getElementById('goalsStyles')) return;
    const st = document.createElement('style');
    st.id = 'goalsStyles';
    st.textContent = '.goals-card{margin:8px 0}'
      + '.goals-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}'
      + '.goals-count{color:var(--sub);font-size:12px;font-variant-numeric:tabular-nums}'
      + '.goal-hint{color:var(--sub);font-size:12px;margin:2px 0 6px;line-height:1.4}'
      + '.goals-list{list-style:none;display:flex;flex-direction:column;gap:2px;padding:0;margin:0}'
      + '.goal-row{display:flex;align-items:center;gap:8px;min-height:44px;padding:2px 0}'
      + '.goal-row.done .goal-text{text-decoration:line-through;color:var(--muted)}'
      + '.goal-order{width:16px;text-align:center;color:var(--muted);font-size:12px;font-weight:700;flex:none}'
      + '.goal-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px}'
      + '.goal-tools{display:flex;gap:2px;flex:none}'
      + '.goal-tool{width:34px;height:34px;min-width:34px;min-height:34px;border-radius:9px;color:var(--sub);font-size:14px}'
      + '.goal-tool:disabled{opacity:.25}'
      + '.goal-candidates{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:6px 0 2px}'
      + '.goal-chip{display:block;min-width:0;border:1px solid var(--line);border-radius:11px;padding:7px 10px;font-size:12px;line-height:20px;color:var(--text);background:var(--bg2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left}'
      + '.goal-custom{display:flex;gap:6px;margin-top:6px;align-items:center}'
      + '.goal-custom input{flex:1;min-width:0;background:var(--bg2);border:1px solid var(--line);border-radius:10px;padding:8px 10px;color:var(--text);min-height:40px}';
    document.head.appendChild(st);
  }

  function apply(s, list, opts) {
    setGoalsFor(s, list);
    if (!opts || !opts.keepCustom) customOpen = false;
    try { if (typeof root.persist === 'function') root.persist(); } catch (e) {}
    try { if (typeof root.render === 'function') root.render(); } catch (e) {}
  }

  if (typeof document !== 'undefined' && typeof root.todayView === 'function') {
    styles();
    const prev = root.todayView;
    root.todayView = function () {
      const s = (UI() && UI().date) || todayISO();
      return inject(prev.apply(this, arguments), s);
    };
    document.addEventListener('click', function (e) {
      const el = e.target.closest && e.target.closest('[data-goal]');
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      const s = (UI() && UI().date) || todayISO();
      const a = el.dataset.goal;
      let list = goalsFor(s);
      if (a === 'pick') list = addGoal(list, { id: el.dataset.id, taskId: el.dataset.id, text: '' });
      else if (a === 'custom') { customOpen = true; apply(s, list, { keepCustom: true }); return; }
      else if (a === 'cancel') { customOpen = false; }
      else if (a === 'save') {
        const inp = document.getElementById('goalCustomInput');
        const text = inp ? inp.value : '';
        const entry = { id: 'g_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), taskId: null, text };
        const next = addGoal(list, entry);
        if (next.length === list.length && !text.trim()) { customOpen = false; apply(s, list); return; }
        list = next;
      }
      else if (a === 'remove') list = removeGoal(list, el.dataset.id);
      else if (a === 'up') list = moveGoal(list, el.dataset.id, -1);
      else if (a === 'down') list = moveGoal(list, el.dataset.id, 1);
      apply(s, list);
    });
  }

  return {
    VERSION: '43.2',
    MAX_GOALS, cleanList, addGoal, removeGoal, moveGoal,
    goalsFor, setGoalsFor, cardHTML, _inject: inject, _resetCustom: () => { customOpen = false; },
  };
});
