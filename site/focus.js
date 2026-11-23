/* JARVIS Routine v42 · Focus Mode, timeboxing and actual-time tracking.
   Time comes from timestamps (survives iOS backgrounding and PWA suspension):
   the 1s interval only repaints, it never accumulates seconds.
   Storage keys:
     jarvis_focus_v1      current session (survives reload / force close)
     jarvis_focus_last_v1 last completed session (for undo)
     jarvis_focus_log_v1  fallback log if S is unavailable during boot */
(function () {
  'use strict';
  const Core = window.JarvisFocusCore;
  if (!Core) return;

  const KEY = 'jarvis_focus_v1';
  const LAST = 'jarvis_focus_last_v1';
  const LOG = 'jarvis_focus_log_v1';
  const MAX_LOG = 400;

  const read = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
  const write = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const hhmm = (m) => Core.formatHM(m);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let session = read(KEY);
  let ticker = null;

  const el = () => document.querySelector('#focusRoot');
  const appReady = () => typeof itemList === 'function' && typeof S === 'object';

  function findTask(taskId, date) {
    if (!appReady() || !taskId) return null;
    try { return itemList(date || ui.date).find((t) => String(t.id) === String(taskId)) || null; } catch { return null; }
  }

  function nowMin() { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); }

  function sessionFromTask(task, plannedMin) {
    return Core.normalize({
      id: 'f_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      taskId: task ? task.id : '',
      date: ui.date,
      title: task ? task.name : 'Фокус',
      plannedMin: plannedMin || 25,
      accMs: 0,
      running: false,
      createdAt: Date.now(),
    }, Date.now());
  }

  function persistSession() { write(KEY, session); }

  function logSession(finished) {
    const entry = {
      id: finished.id, taskId: finished.taskId, date: finished.date, title: finished.title,
      plannedMin: finished.plannedMin, actualMs: finished.actualMs, finishedAt: finished.finishedAt,
    };
    if (appReady()) {
      S.focusSessions = Array.isArray(S.focusSessions) ? S.focusSessions : [];
      S.focusSessions.push(entry);
      if (S.focusSessions.length > MAX_LOG) S.focusSessions = S.focusSessions.slice(-MAX_LOG);
      try { persist(); } catch {}
    } else {
      const log = read(LOG) || [];
      log.push(entry);
      write(LOG, log.slice(-MAX_LOG));
    }
    write(LAST, entry);
    return entry;
  }

  function markDone(entry, done) {
    if (!appReady() || !entry || !entry.taskId) return;
    S.done[entry.date] = S.done[entry.date] || {};
    S.done[entry.date][entry.taskId] = done;
    try { persist(); } catch {}
  }

  function renderOverlay() {
    const host = el();
    if (!host) return;
    if (!session) { host.innerHTML = ''; return; }
    const now = Date.now();
    const elapsed = Core.elapsedMs(session, now);
    const planned = session.plannedMin * 60000;
    const remaining = Math.max(0, planned - elapsed);
    const progress = planned ? Math.min(1, elapsed / planned) : 0;
    const circumference = 2 * Math.PI * 100;
    const offset = circumference * (1 - progress);
    const over = elapsed > planned;
    host.innerHTML = `
      <div class="focus-screen ${session.running ? 'running' : ''}" role="dialog" aria-modal="true" aria-label="Фокус-сессия">
        <div class="focus-head">
          <span class="chip">${session.running ? '◉ идёт' : '❙❙ пауза'}</span>
          <button class="focus-quit" data-focus="quit">Свернуть</button>
        </div>
        <div class="focus-body">
          <div class="focus-task">${esc(session.title)}</div>
          <div class="focus-sub">${esc(session.date)} · план ${session.plannedMin} мин${over ? ' · сверх плана' : ''}</div>
          <div class="focus-ring">
            <svg viewBox="0 0 216 216" aria-hidden="true">
              <defs><linearGradient id="jarvisFocusRing" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stop-color="var(--accent)"/><stop offset="100%" stop-color="var(--accent-2)"/>
              </linearGradient></defs>
              <circle class="track" cx="108" cy="108" r="100"/>
              <circle class="bar" cx="108" cy="108" r="100"
                stroke-dasharray="${circumference.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}"/>
            </svg>
            <b class="focus-clock" id="focusClock">${Core.formatClock(over ? elapsed : remaining)}</b>
          </div>
          <div class="focus-stats">
            <div class="focus-stat"><b>${Math.round(elapsed / 60000)}</b><small>минут факт</small></div>
            <div class="focus-stat"><b>${session.plannedMin}</b><small>минут план</small></div>
          </div>
        </div>
        <div class="focus-actions">
          <button class="btn primary" data-focus="toggle">${session.running ? 'Пауза' : 'Продолжить'}</button>
          <button class="btn" data-focus="done">Готово</button>
        </div>
        <div class="focus-secondary">
          <button class="focus-quit" data-focus="stop">Стоп без отметки</button>
        </div>
      </div>`;
  }

  function paint() {
    const clock = document.querySelector('#focusClock');
    if (!clock || !session) return;
    const elapsed = Core.elapsedMs(session, Date.now());
    const planned = session.plannedMin * 60000;
    const over = elapsed > planned;
    clock.textContent = Core.formatClock(over ? elapsed : Math.max(0, planned - elapsed));
    const bar = document.querySelector('#focusRoot .focus-ring .bar');
    if (bar) {
      const circumference = 2 * Math.PI * 100;
      bar.setAttribute('stroke-dashoffset', (circumference * (1 - Math.min(1, elapsed / planned))).toFixed(1));
    }
    const fact = document.querySelector('#focusRoot .focus-stat b');
    if (fact) fact.textContent = String(Math.round(elapsed / 60000));
    if (over && session.running) {
      document.querySelector('#focusRoot .focus-screen')?.classList.add('running');
    }
  }

  function startTicker() {
    stopTicker();
    if (!session || !session.running) return;
    ticker = setInterval(paint, 1000);
  }
  function stopTicker() { if (ticker) { clearInterval(ticker); ticker = null; } }

  function open(task, plannedMin) {
    if (!task) { if (typeof toast === 'function') toast('Дело не найдено'); return; }
    if (session && session.running && session.taskId !== task.id) {
      if (!confirm('Идёт другая фокус-сессия. Сохранить её и начать новую?')) return;
      logSession(Core.finish(session, Date.now()));
      session = null;
      persistSession();
    }
    if (!session || session.taskId !== task.id) session = sessionFromTask(task, plannedMin);
    persistSession();
    renderOverlay();
    startTicker();
    render();
  }

  function openForTaskId(taskId, plannedMin) {
    const task = findTask(taskId, ui.date);
    if (!task) { if (typeof toast === 'function') toast('Дело не найдено'); return; }
    if (session && session.taskId === String(task.id)) { renderOverlay(); startTicker(); return; }
    let minutes = plannedMin;
    if (!minutes) {
      try { minutes = Math.max(10, Math.min(120, clock(task.end) - clock(task.start))); } catch { minutes = 25; }
    }
    open(task, minutes);
  }

  function toggle() {
    if (!session) return;
    session = session.running ? Core.pause(session, Date.now()) : Core.resume(session, Date.now());
    persistSession(); renderOverlay(); startTicker(); render();
  }

  function complete(marked) {
    if (!session) return;
    const finished = logSession(Core.finish(session, Date.now()));
    if (marked) markDone(finished, true);
    session = null;
    persistSession(); stopTicker(); renderOverlay(); render();
    const mins = Math.round((finished.actualMs || 0) / 60000);
    if (typeof toast === 'function') {
      toast(`${marked ? 'Готово' : 'Сессия сохранена'} · ${mins || 1} мин${marked ? ' · можно вернуть галочку' : ''}`);
    }
  }

  function quit() { session = null; persistSession(); stopTicker(); renderOverlay(); render(); }

  function undoLast() {
    const last = read(LAST);
    if (!last) { if (typeof toast === 'function') toast('Нечего отменять'); return false; }
    markDone(last, false);
    if (appReady() && Array.isArray(S.focusSessions)) {
      S.focusSessions = S.focusSessions.filter((s) => String(s.id) !== String(last.id));
      try { persist(); } catch {}
    }
    write(LAST, null);
    render();
    if (typeof toast === 'function') toast('Отметка фокуса отменена');
    return true;
  }

  /* ── Timeboxing ── */
  const TB_DURATIONS = [25, 50, 90];

  function busyFor(date) {
    if (!appReady()) return [];
    try {
      return itemList(date)
        .filter((t) => t && t.cat !== 'Буфер' && t.status !== 'Буфер')
        .map((t) => ({ start: t.start, end: t.end }));
    } catch { return []; }
  }

  function windowsFor(date, minutes) {
    const isToday = date === today();
    const from = isToday ? Math.max(nowMin(), Core.parseHM(wakeTime(date)) || Core.DAY_START) : (Core.parseHM(wakeTime(date)) || Core.DAY_START);
    const until = Core.parseHM('23:30');
    return Core.freeWindows(busyFor(date), { minutes, from: hhmm(from), until: hhmm(until), buffer: 5, step: 5, limit: 4 });
  }

  function openTimebox(date) {
    openTimeboxWith(date || ui.date, Number(window.jarvisTimeboxMinutes) || 50);
  }

  function createTimebox(date, start, end, minutes, custom) {
    if (!appReady()) return null;
    const id = 'x_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const item = {
      id, name: custom ? 'Новое дело' : `Фокус-блок · ${minutes} мин`,
      start, end, cat: 'Организация', status: 'План',
      note: custom ? '' : 'Выделенное время (timeboxing)',
      fromDate: date, repeat: 'once',
    };
    S.extras.push(item);
    try { persist(); } catch {}
    if (typeof modalClose === 'function') modalClose();
    render();
    if (typeof toast === 'function') toast(`Окно ${start}–${end} закреплено`);
    return item;
  }

  /* ── delegation ── */
  document.addEventListener('click', (e) => {
    const tb = e.target.closest && e.target.closest('[data-focus-tb]');
    if (tb) {
      e.preventDefault(); e.stopPropagation();
      const kind = tb.dataset.focusTb;
      const d = window.jarvisTimeboxDate || ui.date;
      if (kind === 'dur') { const m = Number(tb.dataset.min); openTimeboxWith(d, m); return; }
      if (kind === 'pick') { createTimebox(d, tb.dataset.start, tb.dataset.end, Number(tb.dataset.min), false); return; }
      if (kind === 'task') {
        if (typeof modalClose === 'function') modalClose();
        if (typeof openEdit === 'function') openEdit(null);
        return;
      }
    }
    const hit = e.target.closest && e.target.closest('[data-focus]');
    if (!hit) return;
    e.preventDefault(); e.stopPropagation();
    const op = hit.dataset.focus;
    if (op === 'start') openForTaskId(hit.dataset.id);
    else if (op === 'timebox') openTimebox(ui.date);
    else if (op === 'toggle') toggle();
    else if (op === 'done') complete(true);
    else if (op === 'stop') complete(false);
    else if (op === 'quit') quit();
  }, true);

  function openTimeboxWith(date, minutes) {
    const d = date;
    const windows = windowsFor(d, minutes);
    const box = document.querySelector('#modalbox');
    box.innerHTML = `
      <div class="modalhead"><h2>Выделить время</h2><button class="iconbtn" data-action="close">×</button></div>
      <p class="tagline">${esc(dateTitle(d))} · свободные окна с учётом сна, пар и защищённых дел.</p>
      <div class="filter-row" role="group" aria-label="Длительность">
        ${TB_DURATIONS.map((m) => `<button data-focus-tb="dur" data-min="${m}" class="${m === minutes ? 'active' : ''}">${m} мин</button>`).join('')}
      </div>
      ${windows.length ? `<div class="tb-list">${windows.map((w) => `
        <button class="tb-option" data-focus-tb="pick" data-start="${w.start}" data-end="${w.end}" data-min="${minutes}">
          <b>${w.start}</b><span><span>${w.end}</span><small>свободно · ${minutes} мин</small></span>
        </button>`).join('')}</div>`
      : `<div class="card compact"><b>Свободного окна на ${minutes} мин нет</b><p class="tagline">Попробуй короче или перенеси гибкое дело.</p></div>`}
      <div class="row" style="gap:8px;margin-top:8px"><button class="btn ghost" data-focus-tb="task">Создать своё дело</button></div>`;
    document.querySelector('#modalback').classList.add('show');
    document.querySelector('#modalback').setAttribute('aria-hidden', 'false');
    window.jarvisTimeboxDate = d;
    window.jarvisTimeboxMinutes = minutes;
  }

  /* ── lifecycle ── */
  function boot() {
    if (!document.querySelector('#focusRoot')) {
      const host = document.createElement('div');
      host.id = 'focusRoot';
      document.body.append(host);
    }
    if (session) {
      // Restore after reload / reinstall: recompute from timestamps.
      session = Core.normalize(session, Date.now());
      renderOverlay();
      startTicker();
    }
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') { paint(); startTicker(); }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.JarvisFocus = {
    get session() { return session; },
    open, openForTaskId, toggle, complete, quit, undoLast,
    openTimebox, createTimebox, windowsFor, busyFor,
    _elapsed: () => (session ? Core.elapsedMs(session, Date.now()) : 0),
  };
})();