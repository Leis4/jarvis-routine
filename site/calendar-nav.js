/* JARVIS Routine 3.4 — calendar-day navigation and academic week cycle.
   Safe add-on: no schedule data, no network requests, no automatic state migration. */
(() => {
  'use strict';
  if (typeof ui === 'undefined' || typeof S === 'undefined' ||
      typeof render !== 'function' || typeof monday !== 'function') return;

  // Known academic calendar reference: 9–15 Nov 2026 is the ODD week.
  // This is independent of ISO calendar week numbers.
  const REFERENCE_MONDAY = '2026-11-09';
  const originalParity = parity;
  const originalPlanner = plannerView;
  const originalSettings = settingsView;

  const localCalendarToday = () => fmt(new Date());
  const ruDate = d => { try { return new Date(d + 'T12:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }); } catch (e) { return d; } };
  const priorLogicalToday = today();
  // The displayed calendar date must change at local midnight, not 04:00.
  today = localCalendarToday;
  // When opening the app between 00:00 and 03:59, the original boot code
  // may have selected yesterday. Correct that default without erasing edits.
  if (ui.date === priorLogicalToday && priorLogicalToday !== localCalendarToday()) {
    ui.date = localCalendarToday();
    ui.week = monday(ui.date);
  }

  function academicWeekOffset(date) {
    const first = parse(monday(REFERENCE_MONDAY));
    const second = parse(monday(date));
    const utc = d => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
    return Math.round((utc(second) - utc(first)) / 604800000);
  }
  function academicParity(date) {
    if (S.weekParityMode === 'manual' && S.anchor &&
        (S.anchor.parity === 0 || S.anchor.parity === 1)) return originalParity(date);
    return ((academicWeekOffset(date) % 2) + 2) % 2;
  }
  parity = academicParity;
  weekLabel = date => academicParity(date) ? 'ЧЁТНАЯ' : 'НЕЧЁТНАЯ';
  // Automatic detection replaces the old mandatory onboarding prompt.
  chooseWeek = () => '';

  function validDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
    const d = parse(value);
    return !Number.isNaN(d.getTime()) && fmt(d) === value && d.getFullYear() >= 2020 && d.getFullYear() <= 2100;
  }
  function chooseDate(value) {
    if (!validDate(value)) { toast('Проверь выбранную дату'); return; }
    ui.date = value;
    ui.week = monday(value);
    ui.jrCalendarMonth = value.slice(0, 7);
    render();
  }
  function moveMonth(value, delta) {
    const [year, month] = value.split('-').map(Number);
    return fmt(new Date(year, month - 1 + delta, 1)).slice(0, 7);
  }
  function monthGrid(date) {
    const month = ui.jrCalendarMonth || date.slice(0, 7);
    const start = `${month}-01`;
    const firstMonday = monday(start);
    const d = parse(start);
    const monthName = d.toLocaleDateString('ru-RU', {month:'long', year:'numeric'});
    const names = ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];
    const cells = Array.from({length: 42}, (_, i) => {
      const current = shift(firstMonday, i);
      const outside = !current.startsWith(month);
      const selected = current === ui.date;
      const isToday = current === localCalendarToday();
      return `<button type="button" class="jr-cal-cell${outside?' jr-outside':''}${selected?' jr-selected':''}${isToday?' jr-current':''}" data-jr-action="date" data-jr-date="${current}" aria-label="${safe(dateTitle(current))}, ${weekLabel(current).toLowerCase()} неделя" ${selected?'aria-current="date"':''}><b>${parse(current).getDate()}</b></button>`;
    });
    return `<section class="jr-month" aria-label="Календарь дат"><div class="jr-month-head"><button type="button" data-jr-action="month" data-jr-step="-1" aria-label="Предыдущий месяц">‹</button><strong>${safe(monthName)}</strong><button type="button" data-jr-action="month" data-jr-step="1" aria-label="Следующий месяц">›</button></div><div class="jr-month-grid">${names.map(x=>`<span class="jr-weekday">${x}</span>`).join('')}${cells.join('')}</div><p class="jr-help">Выбери день, чтобы открыть его расписание. Цветом выделена выбранная дата.</p></section>`;
  }
  function navigation(date) {
    const automatic = S.weekParityMode !== 'manual';
    return `<section class="jr-date-nav" aria-label="Переход по датам"><div class="jr-date-controls"><button type="button" data-jr-action="move" data-jr-step="-1" aria-label="Предыдущий день">‹</button><label class="jr-date-picker"><span>Дата</span><b class="jr-date-value" aria-hidden="true">${safe(ruDate(date))} <i class="jr-date-caret">▾</i></b><input type="date" data-jr-date-input aria-label="Выбрать день" value="${date}" min="2020-01-01" max="2100-12-31"></label><button type="button" data-jr-action="move" data-jr-step="1" aria-label="Следующий день">›</button><button type="button" data-jr-action="today">Сегодня</button><button type="button" data-jr-action="toggle" aria-expanded="${!!ui.jrCalendarOpen}">${ui.jrCalendarOpen?'Скрыть':'▦ Месяц'}</button></div><div class="jr-week-label">${safe(weekLabel(date))} учебная неделя · ${safe(weekDate(date))}<span>${automatic?' · автоматически':' · вручную'}</span></div>${ui.jrCalendarOpen?monthGrid(date):''}</section>`;
  }
  plannerView = function () {
    const html = originalPlanner();
    const strip = dateStrip(ui.date);
    const controls = navigation(ui.date);
    return html.includes(strip) ? html.replace(strip, strip + controls) : html.replace('<div class="subhead">', controls + '<div class="subhead">');
  };
  settingsView = function () {
    let html = originalSettings();
    const start = html.indexOf('<div class="card"><div class="eyebrow">Учебная неделя');
    const end = html.indexOf('<div class="card"><div class="eyebrow">Бритьё', start);
    const mode = S.weekParityMode === 'manual' ? 'manual' : 'auto';
    const academic = `<div class="card"><div class="eyebrow">Учебная неделя</div><p class="tagline">Тип недели определяется автоматически по календарю. 9–15 ноября 2026 — нечётная неделя, 16–22 ноября — чётная. Дальше чередуются каждые 7 дней.</p><p class="jr-week-settings"><b>Сегодня: ${weekLabel(localCalendarToday()).toLowerCase()}</b> · ${safe(weekDate(localCalendarToday()))}</p><div class="jr-setting-buttons"><button type="button" class="btn ${mode==='auto'?'primary':''}" data-jr-action="auto">Автоматически</button><button type="button" class="btn ${mode==='manual'?'primary':''}" data-jr-action="manual">Ручная коррекция</button></div>${mode==='manual'?`<p class="tagline">Выбери правильный тип для ${safe(dateTitle(ui.date))}. Это станет точкой отсчёта для всех остальных дат.</p><div class="jr-setting-buttons"><button type="button" class="btn ${!academicParity(ui.date)?'primary':''}" data-jr-action="set-week" data-jr-parity="0">Нечётная</button><button type="button" class="btn ${academicParity(ui.date)?'primary':''}" data-jr-action="set-week" data-jr-parity="1">Чётная</button></div>`:''}</div>`;
    if (start >= 0 && end > start) return html.slice(0, start) + academic + html.slice(end);
    return html.replace('<div class="card">', academic + '<div class="card">');
  };

  // Existing Today button used to reopen the last viewed future day.
  // Correct the date before the original click handler renders the tab.
  document.addEventListener('click', event => {
    if (event.target.closest('[data-action="tab"][data-tab="today"]')) {
      ui.date = localCalendarToday();
      ui.week = monday(ui.date);
    }
  }, true);
  document.addEventListener('click', event => {
    const btn = event.target.closest('[data-jr-action]');
    if (!btn) return;
    switch (btn.dataset.jrAction) {
      case 'date': chooseDate(btn.dataset.jrDate); break;
      case 'move': chooseDate(shift(ui.date, Number(btn.dataset.jrStep))); break;
      case 'today': chooseDate(localCalendarToday()); break;
      case 'toggle':
        ui.jrCalendarOpen = !ui.jrCalendarOpen;
        ui.jrCalendarMonth = ui.date.slice(0, 7);
        render(); break;
      case 'month':
        ui.jrCalendarMonth = moveMonth(ui.jrCalendarMonth || ui.date.slice(0,7), Number(btn.dataset.jrStep));
        render(); break;
      case 'auto':
        S.weekParityMode = 'auto'; persist(); render(); toast('Неделя определяется автоматически'); break;
      case 'manual':
        S.weekParityMode = 'manual';
        // Initialize a valid anchor for the currently viewed week, without changing the cycle.
        S.anchor = {monday:monday(ui.date), parity:academicWeekOffset(ui.date)%2===0?0:1};
        persist(); render(); break;
      case 'set-week':
        S.weekParityMode = 'manual';
        S.anchor = {monday:monday(ui.date), parity:Number(btn.dataset.jrParity)};
        persist(); render(); toast('Учебный цикл скорректирован'); break;
    }
  });
  document.addEventListener('change', event => {
    if (event.target.matches('[data-jr-date-input]')) chooseDate(event.target.value);
  });

  // Expose read-only helpers for regression checks and debugging, no remote calls.
  window.jarvisCalendar = Object.freeze({parity:academicParity, weekOffset:academicWeekOffset, selectDate:chooseDate});
  render();
})();
