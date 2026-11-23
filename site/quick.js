/* JARVIS Routine v43 · Quick add + command palette (UI layer, no framework).
   Depends on: site/parse-ru.js (JarvisParse), site/ux-fixes.js (jarvisTaskConflict),
   the app globals from index.html (S, ui, itemList, persist, render, toast, ...).

   Flow for every quick action, as required:
     text -> parse -> preview -> conflict detection -> free-slot proposal
          -> validation -> persistence -> render -> undo */
(function (root) {
  'use strict';
  if (typeof document === 'undefined') return;
  const P = root.JarvisParse;
  if (!P) return;

  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const tryv = (fn, fallback) => { try { return fn(); } catch (e) { return fallback; } };

  /* The app lives in the global scope of index.html's classic script. Reading it
     through a function keeps this module loadable before or after that script. */
  function refs() {
    return {
      S: tryv(() => S, null),
      ui: tryv(() => ui, null),
      itemList: tryv(() => itemList, null),
      today: tryv(() => today, null),
      nowMinutes: tryv(() => nowMinutes, null),
      niceTime: tryv(() => niceTime, null),
      minutesHM: tryv(() => minutesHM, null),
      wakeTime: tryv(() => wakeTime, null),
      persist: tryv(() => persist, null),
      render: tryv(() => render, null),
      toast: tryv(() => toast, null),
      shift: tryv(() => shift, null),
      openEdit: tryv(() => openEdit, null),
      freeSlots: tryv(() => freeSlots, null),
    };
  }

  function plan(text, baseDate) {
    const r = refs();
    const date0 = baseDate || (r.today && r.today()) || new Date().toISOString().slice(0, 10);
    const nowMin = (r.nowMinutes && r.nowMinutes()) || 0;
    const p = P.parse(text, { today: date0, nowMinutes: nowMin });
    const date = p.date || date0;
    const dur = Math.max(5, Math.min(300, p.durationMin || (p.repeat && p.repeat.repeat === 'everyN' ? 5 : 30)));
    let start = p.time;
    let end = null;

    if (p.relative && p.relative.kind === 'shift') {
      const base = Math.max(nowMin + p.relative.minutes, r.minutesHM && r.wakeTime ? r.minutesHM(r.wakeTime(date)) : 0);
      start = r.niceTime ? r.niceTime(base) : null;
    }
    if (p.after) {
      const items = r.itemList ? r.itemList(date) : [];
      const slot = P.resolveAfter(p, items, { buffer: 10, wakeMinutes: r.minutesHM && r.wakeTime ? r.minutesHM(r.wakeTime(date)) : null });
      if (slot) { start = slot.start; end = slot.end; }
      else p.warnings.push('Не нашёл в расписании «' + (p.after.kind === 'classes' ? 'пары' : p.after.kind === 'gym' ? 'тренировку' : 'это событие') + '» — время поставлю по умолчанию.');
    }
    if (!start) {
      const base = Math.max(nowMin + 30, r.minutesHM && r.wakeTime ? r.minutesHM(r.wakeTime(date)) : 9 * 60);
      start = r.niceTime ? r.niceTime(Math.min(base, 23 * 60)) : '18:00';
    }
    if (!end) end = r.niceTime ? r.niceTime((r.minutesHM ? r.minutesHM(start) : 0) + dur) : '18:30';

    const C = root.jarvisTaskConflict;
    const conflict = C && r.itemList ? C.conflicts(date, '', start, end) : [];
    const slot = conflict.length && C ? C.freeSlot(date, '', start, end) : null;

    return {
      title: (p.title || 'Новое дело').slice(0, 200),
      date, start, end, durationMin: dur, repeat: p.repeat,
      conflict, slot, warnings: p.warnings.slice(), confident: p.confident, raw: p,
    };
  }

  function commit(pl, opts) {
    const r = refs();
    const S = r.S;
    if (!S || !pl) return { error: 'unavailable' };
    const o = opts || {};
    const C = root.jarvisTaskConflict;
    // Final check at the trust boundary: never persist an overlap with a real block.
    if (!o.allowOverlap && C && C.conflicts(pl.date, '', pl.start, pl.end).length) return { error: 'conflict' };
    const id = 'x_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const item = {
      id, name: pl.title, start: pl.start, end: pl.end,
      cat: o.cat || (/мусор|уборк|пылесос|посуд|стирк|быт/i.test(pl.title) ? 'Быт' : 'Организация'), status: o.status || 'Обязательно',
      note: o.note || 'Быстрый ввод', fromDate: pl.date, fixedTime: true,
      ...(pl.repeat || { repeat: 'once' }),
    };
    S.extras.push(item);
    const ok = r.persist ? r.persist() : true;
    if (!ok) { S.extras = S.extras.filter(x => x.id !== id); return { error: 'storage' }; }
    if (r.render) r.render();
    return { item, undo: () => { S.extras = S.extras.filter(x => x.id !== id); if (r.persist) r.persist(); if (r.render) r.render(); } };
  }

  function toastAction(msg, label, fn) {
    const el = document.createElement('div');
    el.className = 'toast toast-action';
    el.innerHTML = `<span>${esc(msg)}</span><button type="button" class="toast-btn">${esc(label)}</button>`;
    el.querySelector('button').addEventListener('click', () => { try { fn(); } catch (e) {} el.remove(); });
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 6500);
  }

  /* ── Quick add panel ─────────────────────────────────────────────── */

  let panel = null, input = null, preview = null, currentPlan = null;

  /* The VM test harness provides a stub document; never assume a real DOM. */
  function domReady() {
    try {
      const el = document.createElement('div');
      return typeof el.addEventListener === 'function' && typeof el.querySelector === 'function' && typeof el.closest === 'function';
    } catch (e) { return false; }
  }

  function buildQuick() {
    if (panel) return true;
    if (!domReady() || !document.body || typeof document.body.appendChild !== 'function') return false;
    const fab = document.createElement('button');
    fab.type = 'button'; fab.id = 'quickFab'; fab.className = 'quick-fab';
    fab.setAttribute('aria-label', 'Быстрое добавление дела');
    fab.innerHTML = '<span aria-hidden="true">＋</span>';

    panel = document.createElement('div');
    panel.id = 'quickPanel'; panel.className = 'quick-panel'; panel.hidden = true;
    panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Быстрое добавление');
    panel.innerHTML = `<form id="quickForm">
      <div class="quick-head"><b>Быстрое добавление</b><button type="button" class="iconbtn" data-quick="close" aria-label="Закрыть">×</button></div>
      <input id="quickInput" class="field" placeholder="Python завтра 18:00 на 45 минут" autocomplete="off" enterkeyhint="done">
      <div id="quickPreview" class="quick-preview"></div>
      <div class="quick-actions"><button class="btn primary" type="submit">Добавить</button><button class="btn" type="button" data-quick="close">Отмена</button></div>
    </form>`;
    document.body.appendChild(fab);
    document.body.appendChild(panel);

    fab.addEventListener('click', () => toggleQuick());
    // Contextual add: the floating + was removed because it overlapped task
    // actions, filters and stats. Adding is done from the top-bar + button and
    // the contextual "Добавить" buttons; the quick panel stays reachable.
    fab.hidden = true;
    input = panel.querySelector('#quickInput');
    preview = panel.querySelector('#quickPreview');
    input.addEventListener('input', refreshPreview);
    panel.addEventListener('submit', e => { e.preventDefault(); applyQuick(); });
    panel.addEventListener('click', e => {
      const b = e.target.closest('[data-quick]');
      if (!b) return;
      if (b.dataset.quick === 'close') toggleQuick(false);
      if (b.dataset.quick === 'slot' && currentPlan && currentPlan.slot) {
        currentPlan.start = currentPlan.slot.start; currentPlan.end = currentPlan.slot.end; currentPlan.conflict = []; currentPlan.slot = null;
        refreshPreview();
      }
    });
    return true;
  }

  function toggleQuick(force) {
    if (!buildQuick()) return;
    const show = force != null ? force : panel.hidden;
    panel.hidden = !show;
    if (show) { input.value = ''; currentPlan = null; refreshPreview(); setTimeout(() => input.focus(), 30); }
  }

  function refreshPreview() {
    const text = input.value.trim();
    if (!text) { preview.innerHTML = '<p class="tagline">Опиши дело словами: дата, время и длительность разберутся сами.</p>'; currentPlan = null; return; }
    currentPlan = plan(text);
    const pl = currentPlan;
    const bits = [`<b>${esc(pl.title)}</b>`, `<span>${esc(pl.date)} · ${esc(pl.start)}–${esc(pl.end)}</span>`];
    let warn = '';
    if (pl.conflict.length) {
      warn = `<p class="quick-warn">Пересечение: ${esc(pl.conflict[0].name)} (${esc(pl.conflict[0].start)}–${esc(pl.conflict[0].end)})</p>`;
      if (pl.slot) warn += `<button type="button" class="btn tight" data-quick="slot">Поставить в ${esc(pl.slot.start)}–${esc(pl.slot.end)}</button>`;
      else warn += '<p class="quick-warn">Свободного окна на эту длительность нет.</p>';
    }
    if (pl.warnings.length) warn += pl.warnings.map(w => `<p class="tagline">${esc(w)}</p>`).join('');
    if (!pl.confident) warn += '<p class="tagline">Дата и время не распознаны — поставлю ближайшее свободное время.</p>';
    preview.innerHTML = bits.join(' ') + warn;
  }

  function applyQuick() {
    const pl = currentPlan || (input.value.trim() ? plan(input.value.trim()) : null);
    if (!pl) return;
    if (pl.conflict.length && !pl.slot) { refs().toast && refs().toast('Есть пересечение — подбери другое время'); return; }
    const res = commit(pl, { allowOverlap: false });
    if (res.error === 'conflict') { refs().toast && refs().toast('Пересечение с существующим делом'); return; }
    if (res.error === 'storage') { refs().toast && refs().toast('Не удалось сохранить'); return; }
    toggleQuick(false);
    toastAction(`${pl.title} · ${pl.date} ${pl.start}`, 'Отменить', res.undo);
  }

  /* ── Command palette (Ctrl/Cmd+K) ────────────────────────────────── */

  let palette = null, paletteInput = null, paletteList = null, items = [], cursor = 0;

  function buildPalette() {
    if (palette) return true;
    if (!domReady() || !document.body || typeof document.body.appendChild !== 'function') return false;
    palette = document.createElement('div');
    palette.id = 'palette'; palette.className = 'palette-back'; palette.hidden = true;
    palette.setAttribute('role', 'dialog'); palette.setAttribute('aria-modal', 'true'); palette.setAttribute('aria-label', 'Команды');
    palette.innerHTML = `<div class="palette">
      <input id="paletteInput" class="field" placeholder="Найти дело, добавить, открыть дату, начать фокус…" autocomplete="off">
      <div id="paletteList" class="palette-list" role="listbox"></div>
      <div class="palette-foot"><span>↑↓ выбрать</span><span>Enter выполнить</span><span>Esc закрыть</span></div>
    </div>`;
    document.body.appendChild(palette);
    paletteInput = palette.querySelector('#paletteInput');
    paletteList = palette.querySelector('#paletteList');
    paletteInput.addEventListener('input', buildCommands);
    paletteInput.addEventListener('keydown', onPaletteKey);
    palette.addEventListener('click', e => {
      if (e.target === palette) return closePalette();
      const row = e.target.closest('[data-cmd]');
      if (row) runCommand(Number(row.dataset.cmd));
    });
    return true;
  }

  function openPalette() {
    if (!buildPalette()) return;
    palette.hidden = false;
    paletteInput.value = '';
    buildCommands();
    setTimeout(() => paletteInput.focus(), 30);
  }

  function closePalette() { if (palette) palette.hidden = true; }

  function buildCommands() {
    const r = refs();
    const q = paletteInput.value.trim();
    const list = [];

    if (q) {
      const pl = plan(q);
      list.push({
        label: `Добавить: ${pl.title}`,
        hint: `${pl.date} ${pl.start}–${pl.end}${pl.conflict.length ? ' · есть пересечение' : ''}`,
        run: () => { const res = commit(pl, {}); if (res.error) r.toast && r.toast('Не удалось добавить'); else { closePalette(); toastAction(`Добавлено: ${pl.title}`, 'Отменить', res.undo); } },
      });
      if (pl.raw.date && !pl.raw.time) {
        list.push({ label: `Открыть ${pl.date}`, hint: 'перейти к дню', run: () => { openDate(pl.date); } });
      }
      const S = r.S;
      if (S && Array.isArray(S.extras)) {
        for (const t of S.extras) {
          if (list.length > 12) break;
          if (!t || typeof t.name !== 'string' || !t.name.toLowerCase().includes(q.toLowerCase())) continue;
          list.push({ label: t.name, hint: `моё дело · ${t.fromDate || ''}`, run: () => { openDate(t.fromDate || (r.ui && r.ui.date)); } });
        }
      }
    }

    const today = r.today ? r.today() : null;
    list.push({ label: 'Начать фокус 25 минут', hint: 'таймер', run: () => { closePalette(); startFocus(25); } });
    list.push({ label: 'Начать фокус 50 минут', hint: 'таймер', run: () => { closePalette(); startFocus(50); } });
    if (today) list.push({ label: 'Перепланировать сегодня', hint: 'локальный планировщик', run: () => { closePalette(); if (root.smartReplan) root.smartReplan(today, { silent: false }); else r.toast && r.toast('Планировщик недоступен'); } });
    if (today) list.push({ label: 'Быстрое добавление', hint: 'описать дело словами', run: () => { closePalette(); toggleQuick(true); } });
    list.push({ label: 'Привычки', hint: 'раздел', run: () => { closePalette(); nav('more', 'more-habits'); } });
    list.push({ label: 'Прогресс', hint: 'раздел', run: () => { closePalette(); nav('more', 'stats'); } });
    list.push({ label: 'Настройки', hint: 'раздел', run: () => { closePalette(); nav('more', 'settings'); } });

    items = list;
    cursor = 0;
    paintCommands();
  }

  function paintCommands() {
    paletteList.innerHTML = items.map((c, i) => `<button type="button" role="option" data-cmd="${i}" class="palette-row ${i === cursor ? 'sel' : ''}" aria-selected="${i === cursor}"><b>${esc(c.label)}</b><small>${esc(c.hint || '')}</small></button>`).join('');
  }

  function onPaletteKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); closePalette(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); cursor = Math.min(items.length - 1, cursor + 1); paintCommands(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); cursor = Math.max(0, cursor - 1); paintCommands(); return; }
    if (e.key === 'Enter') { e.preventDefault(); runCommand(cursor); }
  }

  function runCommand(i) {
    const cmd = items[i];
    if (!cmd) return;
    try { cmd.run(); } catch (err) { const r = refs(); r.toast && r.toast('Команда не выполнена'); }
  }

  function openDate(date) {
    const r = refs();
    if (!r.ui || !date) return;
    r.ui.date = date;
    if (typeof r.ui.week === 'string' && date.length === 10) {
      const d = new Date(date + 'T12:00:00');
      const monday = new Date(d); monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      r.ui.week = monday.toISOString().slice(0, 10);
    }
    r.ui.tab = 'planner';
    if (r.render) r.render();
    closePalette();
  }

  function nav(tab, sub) {
    const r = refs();
    if (!r.ui) return;
    r.ui.tab = tab;
    if (sub) r.ui.moreTab = sub;
    if (r.render) r.render();
  }

  function startFocus(minutes) {
    const r = refs();
    const F = root.JarvisFocus;
    if (!F || !r.niceTime || !r.nowMinutes) { r.toast && r.toast('Фокус-режим недоступен'); return; }
    const now = r.nowMinutes();
    F.open({ id: 'focus_quick_' + Date.now().toString(36), name: 'Фокус-сессия', start: r.niceTime(now), end: r.niceTime(now + minutes) }, minutes);
  }

  function boot() {
    try { buildQuick(); } catch (e) { /* a broken quick-add must never break the app */ }
    document.addEventListener('keydown', e => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); palette && !palette.hidden ? closePalette() : openPalette(); return; }
      if (e.key === 'Escape') { if (palette && !palette.hidden) closePalette(); }
      if (e.key === '/' && !mod && document.activeElement === document.body) { e.preventDefault(); toggleQuick(true); }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  root.JarvisQuick = { plan, commit, openQuick: () => toggleQuick(true), openPalette, closePalette, toastAction };
})(typeof globalThis !== 'undefined' ? globalThis : this);
