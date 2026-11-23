/* JARVIS Routine v45.1 — shared structured memory + local read tools.
 *
 * One memory shared by JARVIS Actions and Qwen Chat:
 *   preference | planning_rule | goal | project | decision | lesson
 *
 * Stored locally (localStorage, versioned). Only CONFIRMED entries are used for
 * context/planning. Long chat history is NOT copied here: this is durable facts,
 * not a transcript. The planner reads confirmed planning rules (e.g. "вечером
 * Python тяжело" -> avoid evening for that task).
 *
 * PRIVACY: local only. No network. No personal data shipped. */
(function (root, factory) {
  const api = factory(root);
  root.JarvisMemory = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const KEY = 'jarvis_memory_v1';
  const TYPES = {
    preference: 'Предпочтение',
    planning_rule: 'Правило планирования',
    goal: 'Цель',
    project: 'Проект',
    decision: 'Решение',
    lesson: 'Вывод',
  };
  const esc = x => String(x == null ? '' : x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const now = () => Date.now();
  const uid = () => 'm_' + now().toString(36) + Math.random().toString(36).slice(2, 6);

  function read() {
    try {
      const o = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (o && Array.isArray(o.entries)) return o;
    } catch (e) {}
    return { version: 1, entries: [] };
  }
  function write(store) {
    try { localStorage.setItem(KEY, JSON.stringify(store)); return true; } catch (e) { return false; }
  }
  function clean(e) {
    if (!e || typeof e !== 'object') return null;
    const content = String(e.content || '').replace(/\s+/g, ' ').trim().slice(0, 400);
    if (!content) return null;
    const type = TYPES[e.type] ? e.type : 'lesson';
    return {
      id: typeof e.id === 'string' && e.id ? e.id : uid(),
      type,
      content,
      source: String(e.source || 'user').slice(0, 40),
      createdAt: Number(e.createdAt) || now(),
      updatedAt: Number(e.updatedAt) || Number(e.createdAt) || now(),
      confirmed: e.confirmed !== false,
    };
  }
  function list() { return read().entries.map(clean).filter(Boolean); }
  function add(entry) {
    const e = clean({ ...entry, id: uid(), createdAt: now(), updatedAt: now() });
    if (!e) return null;
    const st = read();
    // Deduplicate near-identical confirmed entries of the same type.
    const dup = st.entries.find(x => x.type === e.type && String(x.content).toLowerCase() === e.content.toLowerCase());
    if (dup) return dup;
    st.entries.push(e);
    write(st);
    return e;
  }
  function update(id, patch) {
    const st = read();
    const i = st.entries.findIndex(e => e.id === id);
    if (i < 0) return false;
    st.entries[i] = clean({ ...st.entries[i], ...patch, id, updatedAt: now() });
    write(st);
    return true;
  }
  function remove(id) {
    const st = read();
    const before = st.entries.length;
    st.entries = st.entries.filter(e => e.id !== id);
    write(st);
    return st.entries.length !== before;
  }
  function search(q) {
    const s = String(q || '').toLowerCase().trim();
    const all = list();
    if (!s) return all;
    return all.filter(e => e.content.toLowerCase().includes(s) || TYPES[e.type].toLowerCase().includes(s));
  }
  function relevantFor(text, limit) {
    limit = limit || 4;
    const words = String(text || '').toLowerCase().match(/[a-zа-яё0-9]{4,}/gi) || [];
    if (!words.length) return [];
    const uniq = Array.from(new Set(words)).slice(0, 12);
    return list().filter(e => e.confirmed).map(e => {
      const c = e.content.toLowerCase();
      const score = uniq.reduce((n, w) => n + (c.includes(w) ? 1 : 0), 0);
      return { e, score };
    }).filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map(x => x.e);
  }
  /* Confirmed planning rules that map to a real task name -> avoid evening. */
  function avoidEvening() {
    const names = [];
    try { if (typeof itemList === 'function') itemList(typeof today === 'function' ? today() : '').forEach(t => names.push(String(t.name || ''))); } catch (e) {}
    const out = new Set();
    for (const e of list()) {
      if (!e.confirmed || e.type !== 'planning_rule') continue;
      if (!/вечер/i.test(e.content)) continue;
      const c = e.content.toLowerCase();
      for (const n of names) {
        const key = n.split(/[;,–—]/)[0].trim().split(/[\s/]+/)[0].toLowerCase();
        if (key.length >= 4 && c.includes(key)) out.add(key);
      }
    }
    return Array.from(out);
  }

  /* ── UI ── */
  function dialog(html) {
    const mb = document.getElementById('modalbox'), back = document.getElementById('modalback');
    if (!mb || !back) return false;
    mb.innerHTML = html; back.classList.add('show'); back.setAttribute('aria-hidden', 'false');
    return true;
  }
  function close() { if (typeof modalClose === 'function') modalClose(); }
  function options(sel) { return Object.entries(TYPES).map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${esc(v)}</option>`).join(''); }
  function row(e) {
    return `<div class="mem-row"><div class="mem-body"><span class="mem-type">${esc(TYPES[e.type])}</span><b>${esc(e.content)}</b><small>${new Date(e.updatedAt).toLocaleDateString('ru-RU')} · ${esc(e.source)}${e.confirmed ? '' : ' · не подтверждено'}</small></div><i class="ch" data-mem="edit" data-id="${esc(e.id)}" role="button" aria-label="Изменить">✎</i><i class="ch" data-mem="del" data-id="${esc(e.id)}" role="button" aria-label="Удалить">✕</i></div>`;
  }
  function openUI(filterType) {
    const all = list().sort((a, b) => b.updatedAt - a.updatedAt);
    const rows = (filterType ? all.filter(e => e.type === filterType) : all).map(row).join('');
    dialog(`<div class="modalhead"><h2>Память JARVIS</h2><button class="iconbtn" data-mem="close" aria-label="Закрыть">×</button></div>
      <p class="tagline">Подтверждённые факты и правила, общие для действий и Qwen. История чатов здесь не хранится.</p>
      <div class="mem-actions"><input class="field" id="memSearch" placeholder="Поиск по памяти…" autocomplete="off"><select class="field" id="memType">${`<option value="">Все типы</option>`}${options(filterType)}</select></div>
      <div class="mem-list">${rows || '<p class="tagline">Пока пусто. Добавь предпочтение или правило ниже.</p>'}</div>
      <div class="mem-add"><select class="field" id="memNewType">${options('preference')}</select><textarea class="field" id="memNewText" rows="2" maxlength="400" placeholder="Например: вечером Python даётся тяжело — лучше утром"></textarea><button class="btn primary" data-mem="add">Сохранить</button></div>`);
    const s = document.getElementById('memSearch');
    if (s) s.addEventListener('input', () => { const q = s.value.toLowerCase(); Array.from(document.querySelectorAll('.mem-row')).forEach(r => { r.style.display = !q || r.textContent.toLowerCase().includes(q) ? '' : 'none'; }); });
    const t = document.getElementById('memType');
    if (t) t.addEventListener('change', () => openUI(t.value));
  }
  function proposeRemember(text, type) {
    const content = String(text || '').replace(/^(запомни|запомнить|сохрани|запиши)[:,]?\s*/i, '').trim();
    if (!content) { try { toast('Что запомнить?'); } catch (e) {} return; }
    const defType = /вечер|утр|расписан|план|перенос|фокус|блок/i.test(content) ? 'planning_rule' : (type || 'preference');
    dialog(`<div class="modalhead"><h2>Запомнить</h2><button class="iconbtn" data-mem="close" aria-label="Закрыть">×</button></div>
      <p class="tagline">JARVIS сохранит это как подтверждённый факт общей памяти.</p>
      <select class="field" id="memProposeType">${options(defType)}</select>
      <textarea class="field" id="memProposeText" rows="3" maxlength="400">${esc(content)}</textarea>
      <div class="plan-actions"><button class="btn primary" data-mem="confirm">Сохранить</button><button class="btn" data-mem="close">Отмена</button></div>`);
  }
  function isRememberIntent(text) { return /^(запомни|запомнить|сохрани в память|запиши в память)/i.test(String(text || '').trim()); }

  if (typeof document !== 'undefined') {
    document.addEventListener('click', e => {
      const el = e.target.closest && e.target.closest('[data-mem]');
      if (!el) return;
      e.preventDefault();
      const a = el.dataset.mem, id = el.dataset.id;
      if (a === 'close') { close(); return; }
      if (a === 'add') {
        const type = (document.getElementById('memNewType') || {}).value || 'preference';
        const text = (document.getElementById('memNewText') || {}).value || '';
        if (!String(text).trim()) { try { toast('Введи текст'); } catch (e2) {} return; }
        add({ type, content: text, source: 'user' }); openUI(); try { render(); } catch (e2) {}
        return;
      }
      if (a === 'confirm') {
        const type = (document.getElementById('memProposeType') || {}).value || 'preference';
        const text = (document.getElementById('memProposeText') || {}).value || '';
        add({ type, content: text, source: 'qwen' }); close();
        try { toast('Сохранено в память'); } catch (e2) {}
        try { render(); } catch (e2) {}
        return;
      }
      if (a === 'edit') {
        const all = list(); const en = all.find(x => x.id === id); if (!en) return;
        const text = prompt('Изменить запись', en.content); if (text == null) return;
        update(id, { content: text }); openUI(); try { render(); } catch (e2) {}
        return;
      }
      if (a === 'del') {
        if (!confirm('Удалить запись памяти?')) return;
        remove(id); openUI(); try { render(); } catch (e2) {}
        return;
      }
    });
  }

  /* ── local read tools (client-side tool contract, no native function calling) ── */
  function toolsContext(text) {
    const s = (typeof ui !== 'undefined' && ui && ui.date) || (typeof today === 'function' ? today() : '');
    const t = String(text || '').toLowerCase();
    const has = re => re.test(t);
    const parts = [];
    try {
      if (has(/расписан|план|сейчас|свобод|окно|занят|день/)) {
        const now = (root.JarvisPlanner && root.JarvisPlanner.whatNow) ? root.JarvisPlanner.whatNow(s) : null;
        if (now) parts.push('Сейчас/далее: ' + String(now.text).slice(0, 180));
        const w = (root.JarvisPlanner && root.JarvisPlanner.freeWindows) ? root.JarvisPlanner.freeWindows(s, 15).slice(0, 3) : [];
        if (w.length) parts.push('Свободно: ' + w.map(x => x.label + ' (' + x.minutes + ' мин)').join(', '));
      }
      if (has(/привычк/)) {
        const H = (typeof HABITS !== 'undefined' ? HABITS : []);
        const d = H.filter(h => typeof habitDone === 'function' && habitDone(s, h.id)).length;
        parts.push('Привычки: ' + d + ' из ' + H.length + ' выполнено.');
      }
      if (has(/цел/)) {
        const g = (root.JarvisGoals && root.JarvisGoals.goalsFor) ? root.JarvisGoals.goalsFor(s) : [];
        if (g.length) parts.push('Цели дня: ' + g.map(x => x.text).slice(0, 3).join('; '));
      }
      if (has(/прогресс|статист|выполн/)) {
        const pr = typeof progress === 'function' ? progress(s) : null;
        if (pr) parts.push('Прогресс: ' + pr.a + ' из ' + pr.b + ' обязательных.');
      }
    } catch (e) {}
    return parts.length ? ('[Контекст JARVIS] ' + parts.join(' | ')).slice(0, 700) : '';
  }
  try { root.JarvisTools = { contextFor: toolsContext }; } catch (e) {}

  return { VERSION: '45.1', TYPES, list, add, update, remove, search, relevantFor, avoidEvening, openUI, proposeRemember, isRememberIntent, contextFor: toolsContext };
});
