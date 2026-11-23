/* JARVIS Routine v43 · recurrence core (pure logic, no DOM).
   Used by site/index.html / site/smart.js in the browser and by tests/recur.mjs in Node.

   Design rules taken from the product requirements:
   - store the RULE, never thousands of materialised instances;
   - university parity is anchored to a real study week (9–15 Nov 2026 = нечётная),
     not to ISO week parity, and the anchor is user-correctable (see ctx.parity);
   - a single occurrence can be skipped (exceptions) or moved (S.dayAdjust) without
     touching the series.

   Task fields understood here (all optional except `repeat`):
     repeat      'once' | 'daily' | 'weekly' | 'biweekly' | 'everyN' | 'weekdays' | 'parity'
     repeatDays  [0..6]   Monday = 0 (same convention as the app's indexDay)
     intervalDays N       for 'everyN'
     parity      0 | 1    0 = нечётная неделя, 1 = чётная
     repeatUntil 'YYYY-MM-DD'  inclusive end date
     exceptions  ['YYYY-MM-DD'] skipped occurrences
     paused      true
   Legacy values already present in user data keep their exact old meaning. */
(function (root, factory) {
  const api = factory();
  root.JarvisRecur = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DAY_MS = 86400000;
  const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
  const WEEKDAYS_LONG = ['понедельник', 'вторник', 'среду', 'четверг', 'пятницу', 'субботу', 'воскресенье'];
  /* 9–15 Nov 2026 is the odd (нечётная) week — the anchor the user confirmed. */
  const PARITY_ANCHOR = { monday: '2026-11-09', parity: 0 };
  const HORIZON_DAYS = 400;

  const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

  function dateMs(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    if (!m) return NaN;
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }

  function fromMs(ms) {
    const d = new Date(ms);
    return String(d.getUTCFullYear()) + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
  }

  const diffDays = (a, b) => Math.round((dateMs(a) - dateMs(b)) / DAY_MS);

  function indexDay(s) {
    const d = new Date(dateMs(s));
    return (d.getUTCDay() + 6) % 7;
  }

  function mondayOf(s) { return fromMs(dateMs(s) - indexDay(s) * DAY_MS); }

  function weeksBetween(a, b) { return Math.round((dateMs(mondayOf(a)) - dateMs(mondayOf(b))) / (7 * DAY_MS)); }

  function addDays(s, n) { return fromMs(dateMs(s) + Math.round(Number(n) || 0) * DAY_MS); }

  /* Local calendar date (not UTC) — the app's day boundaries are local. */
  function todayISO(d) {
    const x = d ? new Date(d) : new Date();
    return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
  }

  function parityOf(s, anchor) {
    const a = anchor && isDate(anchor.monday) ? anchor : PARITY_ANCHOR;
    const w = weeksBetween(s, a.monday);
    return ((Number(a.parity) + (w % 2)) + 2) % 2;
  }

  function normalize(task) {
    const t = task || {};
    let mode = String(t.repeat || 'once');
    if (/^every\d+$/.test(mode)) mode = 'everyN';
    const days = Array.isArray(t.repeatDays)
      ? t.repeatDays.map(Number).filter(n => n >= 0 && n <= 6)
      : [];
    return {
      mode,
      days: [...new Set(days)].sort((a, b) => a - b),
      intervalDays: Math.max(1, Math.round(Number(t.intervalDays) || (/\d+/.exec(String(t.repeat || '')) || [])[0] || 1)),
      parity: Number(t.parity) === 1 ? 1 : 0,
      until: isDate(t.repeatUntil) ? t.repeatUntil : null,
      exceptions: Array.isArray(t.exceptions) ? t.exceptions.filter(isDate) : [],
      paused: !!t.paused,
    };
  }

  function validate(task) {
    const r = normalize(task);
    if (!['once', 'daily', 'weekly', 'biweekly', 'everyN', 'weekdays', 'parity'].includes(r.mode)) return 'Неизвестный тип повторения';
    if (['weekly', 'biweekly', 'weekdays', 'parity'].includes(r.mode) && !r.days.length) return 'Выбери хотя бы один день недели';
    if (r.mode === 'everyN' && (r.intervalDays < 1 || r.intervalDays > 90)) return 'Интервал должен быть от 1 до 90 дней';
    if (r.until && isDate(task && task.fromDate) && diffDays(r.until, task.fromDate) < 0) return 'Дата окончания раньше начала';
    return null;
  }

  /* Does this task have an occurrence on `date`? ctx = { parity(date) } is optional;
     without it the built-in university anchor is used. */
  function occursOn(task, date, ctx) {
    if (!isDate(date)) return false;
    const r = normalize(task);
    if (r.paused) return false;
    if (r.exceptions.includes(date)) return false;
    if (r.until && diffDays(date, r.until) > 0) return false;

    const from = isDate(task && task.fromDate) ? task.fromDate : null;
    if (!from) return true;            // a plan block with no start date exists on every day
    const d = diffDays(date, from);
    if (d < 0) return false;

    const parityFn = ctx && typeof ctx.parity === 'function' ? ctx.parity : parityOf;
    const day = indexDay(date);
    switch (r.mode) {
      case 'once': return d === 0;
      case 'daily': return true;
      case 'weekly': return (r.days.length ? r.days.includes(day) : day === indexDay(from)) && d % 7 === 0;
      case 'biweekly': return (r.days.length ? r.days.includes(day) : day === indexDay(from)) && d % 14 === 0;
      case 'everyN': return d % r.intervalDays === 0;
      case 'weekdays': return r.days.includes(day);
      case 'parity': return parityFn(date) === r.parity && (r.days.length ? r.days.includes(day) : true);
      default: return d === 0;
    }
  }

  /* Bounded expansion: at most `count` dates starting at `from`, never more than HORIZON_DAYS.
     Returns ISO date strings. */
  function nextDates(task, from, count, ctx) {
    const out = [];
    if (!isDate(from)) return out;
    const limit = Math.min(Math.max(1, Number(count) || 1), 60);
    const startMs = dateMs(from);
    for (let i = 0; i < HORIZON_DAYS && out.length < limit; i++) {
      const s = fromMs(startMs + i * DAY_MS);
      if (occursOn(task, s, ctx)) out.push(s);
    }
    return out;
  }

  function describe(task) {
    const r = normalize(task);
    const dayNames = r.days.map(d => WEEKDAYS[d]).join(', ');
    const until = r.until ? ' до ' + r.until.split('-').reverse().join('.') : '';
    const paused = r.paused ? ' (на паузе)' : '';
    switch (r.mode) {
      case 'daily': return 'Каждый день' + until + paused;
      case 'weekly': return (r.days.length ? 'Каждый: ' + dayNames : 'Раз в неделю') + until + paused;
      case 'biweekly': return 'Раз в две недели' + (r.days.length ? ': ' + dayNames : '') + until + paused;
      case 'everyN': return 'Каждые ' + r.intervalDays + ' дн.' + until + paused;
      case 'weekdays': return 'По дням: ' + dayNames + until + paused;
      case 'parity': return (r.parity === 0 ? 'Нечётные' : 'Чётные') + ' недели' + (r.days.length ? ': ' + dayNames : '') + until + paused;
      default: return 'Один раз' + paused;
    }
  }

  /* Occurrences a bounded UI range needs (used to render "next dates" previews). */
  function occurrencesInRange(task, start, end, ctx) {
    const out = [];
    if (!isDate(start) || !isDate(end)) return out;
    const span = Math.min(HORIZON_DAYS, Math.max(0, diffDays(end, start)));
    for (let i = 0; i <= span; i++) {
      const s = fromMs(dateMs(start) + i * DAY_MS);
      if (occursOn(task, s, ctx)) out.push(s);
    }
    return out;
  }

  return {
    VERSION: 1,
    WEEKDAYS, WEEKDAYS_LONG, PARITY_ANCHOR, HORIZON_DAYS,
    isDate, diffDays, indexDay, mondayOf, weeksBetween, parityOf, addDays, todayISO,
    normalize, validate, occursOn, nextDates, occurrencesInRange, describe,
  };
});
