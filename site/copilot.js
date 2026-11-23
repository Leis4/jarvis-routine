/* JARVIS Routine v47.0 — semantic action layer + site awareness.
 *
 * Qwen/JARVIS can control the app through explicit, allowlisted actions instead
 * of blind DOM clicking. Navigation/UI state changes are executed through the
 * real controllers; schedule/memory writes still go through the existing
 * Preview → Apply → Undo contract.
 *
 * Also exposes read tools (real data only) on the shared JarvisTools registry.
 *
 * PRIVACY: local state only. No network. */
(function (root) {
  'use strict';
  const esc = x => String(x == null ? '' : x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function ctx() {
    const ui = root.ui || {};
    const modal = document.getElementById('modalback');
    const goals = (root.JarvisGoals && root.JarvisGoals.goalsFor) ? root.JarvisGoals.goalsFor(ui.date) : [];
    return {
      tab: ui.tab || 'today',
      moreTab: ui.moreTab || null,
      date: ui.date || (root.today ? root.today() : ''),
      timezone: 'Europe/Moscow',
      modal: !!(modal && modal.classList.contains('show')),
      selectedTask: ui._selTask || null,
      wallpaper: (ui.wallpaper && ui.wallpaper.mode) || 'aura',
      motion: ui.motion || 'full',
      goals: Array.isArray(goals) ? goals.length : 0,
      scheduleLoaded: (typeof root.scheduleReady === 'function') ? !!root.scheduleReady() : true,
      online: (typeof navigator !== 'undefined' && 'onLine' in navigator) ? !!navigator.onLine : true,
    };
  }
  function ctxText() {
    const c = ctx();
    return 'Экран: ' + c.tab + (c.moreTab ? '/' + c.moreTab : '') + '. Дата: ' + c.date + '. Модалка: ' + (c.modal ? 'открыта' : 'нет') + '. Фон: ' + c.wallpaper + '. Анимации: ' + c.motion + '.';
  }

  function ensureUI() { if (!root.ui) return false; if (!root.ui.wallpaper) root.ui.wallpaper = { mode: 'aura', intensity: 'mid' }; return true; }
  function navigate(tab) { if (!ensureUI() || !['today', 'planner', 'ai', 'more'].includes(tab)) return false; root.ui.tab = tab; root.render(); return true; }
  function openDate(d) { if (!ensureUI() || !/^\d{4}-\d{2}-\d{2}$/.test(String(d))) return false; root.ui.date = d; root.ui.week = root.monday(d); root.ui.tab = 'planner'; root.render(); return true; }
  function openTask(id) {
    if (!ensureUI() || !id || typeof root.itemList !== 'function') return false;
    const t = root.itemList(root.ui.date).find(x => x.id === id); if (!t) return false;
    root.ui._selTask = id; root.ui.tab = 'today'; root.render();
    const det = document.getElementById('detail_' + id); if (det && !det.classList.contains('open')) det.classList.add('open');
    const el = document.querySelector('.task-row[data-task-id="' + id + '"]'); if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center' });
    return true;
  }
  function openHabits() { if (!ensureUI()) return false; root.ui.tab = 'more'; root.ui.moreTab = 'more-habits'; root.render(); return true; }
  function openFocus() { if (!ensureUI()) return false; root.ui.tab = 'more'; root.ui.moreTab = 'focus'; root.render(); return true; }
  function openSettings() { if (!ensureUI()) return false; root.ui.tab = 'more'; root.ui.moreTab = 'settings'; root.render(); return true; }
  function openMemory() { if (root.JarvisMemory && root.JarvisMemory.openUI) { root.JarvisMemory.openUI(); return true; } return false; }
  function selectWallpaper(mode) {
    if (!ensureUI() || !['aura', 'fluid', 'still'].includes(mode)) return false;
    root.ui.wallpaper = { ...(root.ui.wallpaper || {}), mode };
    try { localStorage.setItem('jarvis_ui_wallpaper', JSON.stringify(root.ui.wallpaper)); } catch (e) {}
    if (root.JarvisWallpaper) root.JarvisWallpaper.apply();
    root.render(); return true;
  }
  function setMotion(level) {
    if (!ensureUI() || !['full', 'moderate', 'minimal'].includes(level)) return false;
    root.ui.motion = level;
    try { localStorage.setItem('jarvis_ui_motion', level); } catch (e) {}
    document.documentElement.dataset.motion = level;
    if (root.JarvisWallpaper) root.JarvisWallpaper.apply();
    root.render(); return true;
  }
  function closeSheet() { if (typeof root.modalClose === 'function') { root.modalClose(); return true; } return false; }

  function resolveDay(t) {
    if (!root.today || !root.shift) return null;
    const base = root.today();
    if (/послезавтра/.test(t)) return root.shift(base, 2);
    if (/завтра/.test(t)) return root.shift(base, 1);
    if (/сегодня/.test(t)) return base;
    const days = { 'понедельник': 0, 'вторник': 1, 'среда': 2, 'среду': 2, 'четверг': 3, 'пятниц': 4, 'суббот': 5, 'воскрес': 6 };
    for (const k in days) if (t.includes(k)) { let d = days[k] - root.indexDay(base); if (d <= 0) d += 7; return root.shift(base, d); }
    return null;
  }

  function tryLocal(t) {
    if (!t) return null;
    if (/закрой.*(панель|окно|меню|шторк)/.test(t)) { return closeSheet() ? 'Закрыл панель.' : null; }
    if (/что\s+(?:у\s+меня\s+)?(?:на\s+)?экране|что\s+открыт|где\s+я\s+сейчас|какой\s+экран/.test(t)) return ctxText();
    if (/включи|поставь|сделай|переключи/.test(t)) {
      if (/(fluid|жидк|волн)/.test(t)) { return selectWallpaper('fluid') ? 'Включил фон FLUID.' : null; }
      if (/(aura|аврор|облак)/.test(t)) { return selectWallpaper('aura') ? 'Включил фон AURA.' : null; }
      if (/(still|статич|без\s+анимац)/.test(t)) { return selectWallpaper('still') ? 'Включил STILL.' : null; }
    }
    if (/памят/.test(t) && /(открой|покажи|где)/.test(t)) { return openMemory() ? 'Открыл память.' : null; }
    if (/настройк/.test(t) && /(открой|покажи|где)/.test(t)) { return openSettings() ? 'Открыл настройки.' : null; }
    if (/привычк/.test(t) && /(открой|покажи|где|какие)/.test(t)) { return openHabits() ? 'Открыл привычки.' : null; }
    if (/фокус/.test(t) && /(открой|покажи|запусти|где)/.test(t)) { return openFocus() ? 'Открыл фокус.' : null; }
    if (/(открой|покажи|перейди|переключи)/.test(t)) {
      const d = resolveDay(t);
      if (d) return openDate(d) ? 'Открыл ' + d + '.' : null;
      if (/\bплан\b|расписан/.test(t)) return navigate('planner') ? 'Открыл план.' : null;
      if (/\bсегодня\b|главн/.test(t)) return navigate('today') ? 'Открыл «Сегодня».' : null;
    }
    return null;
  }

  root.JarvisActions = { VERSION: '47.0', get_ui_context: ctx, navigate, open_date: openDate, open_task: openTask, open_habits: openHabits, open_focus: openFocus, open_settings: openSettings, open_memory: openMemory, select_wallpaper: selectWallpaper, set_motion_level: setMotion, close_active_sheet: closeSheet, tryLocal };

  /* Shared read tools (real data only). */
  function toolDay(a) { const d = a && a.date; return (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) ? d : ((root.ui && root.ui.date) || (root.today ? root.today() : '')); }
  function notLoaded() { return typeof root.scheduleReady === 'function' ? !root.scheduleReady() : false; }
  function taskRow(t, d) { return { id: t.id, name: t.name, start: t.start, end: t.end, status: t.status, cat: t.cat, done: root.done ? !!root.done(d, t.id) : false }; }
  const tools = {
    get_ui_context: () => ctx(),
    get_current_time: () => ({ now: new Date().toISOString(), timezone: 'Europe/Moscow' }),
    get_today: a => { if (notLoaded()) return { not_loaded: true }; const d = toolDay(a); return root.JarvisPlanner ? { date: d, ...root.JarvisPlanner.whatNow(d) } : { date: d }; },
    get_schedule: a => { if (notLoaded()) return { not_loaded: true }; const d = toolDay(a); return (root.itemList ? root.itemList(d) : []).slice(0, 40).map(t => taskRow(t, d)); },
    get_tasks: a => {
      if (notLoaded()) return { not_loaded: true };
      const d = toolDay(a); let list = root.itemList ? root.itemList(d) : [];
      if (a && a.status) list = list.filter(t => t.status === a.status);
      if (a && a.cat) list = list.filter(t => t.cat === a.cat);
      if (a && a.checkable) list = list.filter(t => t.status !== 'Буфер');
      return list.slice(0, 60).map(t => taskRow(t, d));
    },
    get_goals: a => { const d = toolDay(a); return root.JarvisGoals ? root.JarvisGoals.goalsFor(d) : []; },
    get_habits: a => { if (notLoaded()) return { not_loaded: true }; const d = toolDay(a); const list = (typeof root.currentHabits === 'function') ? root.currentHabits(d) : []; return list.slice(0, 40).map(h => ({ id: h.id, name: h.name, done: root.habitDone ? !!root.habitDone(d, h.id) : false })); },
    get_progress: a => { const d = toolDay(a); return root.progress ? root.progress(d) : null; },
    find_free_time: a => { if (notLoaded()) return { not_loaded: true }; const d = toolDay(a); const m = Math.max(5, Math.min(240, Number(a && a.minutes) || 15)); return root.JarvisPlanner ? root.JarvisPlanner.freeWindows(d, m) : []; },
    search_memory: a => (root.JarvisMemory ? root.JarvisMemory.search((a && a.q) || '') : []),
    search_chats: async a => (root.JarvisChatStore ? await root.JarvisChatStore.search((a && a.q) || '') : []),
    get_planning_rules: () => (root.JarvisMemory ? root.JarvisMemory.list().filter(e => e.type === 'planning_rule') : []),
  };
  const schemas = {
    get_ui_context: { description: 'Current JARVIS screen state', parameters: { type: 'object', properties: {}, additionalProperties: false } },
    get_schedule: { description: 'Tasks for a date', parameters: { type: 'object', properties: { date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } }, additionalProperties: false } },
    get_tasks: { description: 'Tasks filtered by status/category', parameters: { type: 'object', properties: { date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, status: { type: 'string' }, cat: { type: 'string' }, checkable: { type: 'boolean' } }, additionalProperties: false } },
    get_goals: { description: 'Day goals', parameters: { type: 'object', properties: { date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } }, additionalProperties: false } },
    get_habits: { description: 'Scheduled habits and completion', parameters: { type: 'object', properties: { date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } }, additionalProperties: false } },
    get_progress: { description: 'Required-task progress', parameters: { type: 'object', properties: { date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } }, additionalProperties: false } },
    find_free_time: { description: 'Free windows of at least N minutes', parameters: { type: 'object', properties: { date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, minutes: { type: 'integer', minimum: 5, maximum: 240 } }, additionalProperties: false } },
    search_memory: { description: 'Search confirmed memory', parameters: { type: 'object', properties: { q: { type: 'string' } }, additionalProperties: false } },
    search_chats: { description: 'Search chat messages', parameters: { type: 'object', properties: { q: { type: 'string' } }, additionalProperties: false } },
    get_planning_rules: { description: 'Confirmed planning rules', parameters: { type: 'object', properties: {}, additionalProperties: false } },
  };
  async function run(name, args) {
    if (!Object.prototype.hasOwnProperty.call(tools, name)) return { ok: false, error: 'unknown_tool' };
    try { const result = await tools[name](args || {}); return { ok: true, tool: name, result }; } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  }
  root.JarvisTools = Object.assign(root.JarvisTools || {}, tools, { run, schemas });
})(typeof globalThis !== 'undefined' ? globalThis : this);
