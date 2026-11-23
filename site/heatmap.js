/* JARVIS Routine v43 · activity heatmap (pure logic + pure HTML string).
   Used by site/smart.js in the browser and by tests/study-heatmap.cjs in Node.

   It is deliberately dumb: the caller supplies a `valueFor(dateISO)` returning
   a 0–100 percentage (or null when there is nothing to show). This module only
   arranges the weeks and decides the level, so the same grid can be reused for
   completion, focus minutes or reviews without duplicating layout code. */
(function (root, factory) {
  const api = factory();
  root.JarvisHeatmap = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = 1;
  const DAY_MS = 86400000;
  const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
  const LEVELS = [1, 40, 70, 90]; // thresholds for levels 1..4

  const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

  function dateMs(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    if (!m) return NaN;
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }

  function fromMs(ms) {
    const d = new Date(ms);
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
  }

  const addDays = (s, n) => fromMs(dateMs(s) + Math.round(Number(n) || 0) * DAY_MS);
  const indexDay = s => (new Date(dateMs(s)).getUTCDay() + 6) % 7;
  const mondayOf = s => addDays(s, -indexDay(s));

  /* 0 = nothing, 1..4 = increasing activity. A null percentage is "no data". */
  function level(pct) {
    if (pct == null || Number.isNaN(Number(pct))) return 0;
    const p = Math.max(0, Math.min(100, Number(pct)));
    if (p <= 0) return 0;
    let l = 1;
    for (let i = 0; i < LEVELS.length; i++) if (p >= LEVELS[i]) l = i + 1;
    return l;
  }

  /* end: last day shown (inclusive). weeks: how many columns. */
  function build(opts) {
    const o = opts || {};
    const end = isDate(o.end) ? o.end : fromMs(Date.UTC(2026, 10, 16));
    const weeks = Math.max(1, Math.min(53, Math.round(Number(o.weeks) || 12)));
    const valueFor = typeof o.valueFor === 'function' ? o.valueFor : () => null;
    const lastMonday = mondayOf(end);
    const firstMonday = addDays(lastMonday, -(weeks - 1) * 7);

    const columns = [];
    let total = 0, days = 0, best = { date: null, pct: -1 };
    for (let w = 0; w < weeks; w++) {
      const start = addDays(firstMonday, w * 7);
      const cells = [];
      for (let d = 0; d < 7; d++) {
        const date = addDays(start, d);
        const future = dateMs(date) > dateMs(end);
        let pct = null;
        if (!future) {
          const raw = valueFor(date);
          pct = raw == null ? null : Math.max(0, Math.min(100, Math.round(Number(raw) || 0)));
          if (pct != null) {
            total += pct; days++;
            if (pct > best.pct) best = { date, pct };
          }
        }
        cells.push({ date, pct, level: future ? -1 : level(pct), future, weekday: d });
      }
      columns.push({ start, cells });
    }
    return {
      weeks: columns,
      labels: WEEKDAYS,
      average: days ? Math.round(total / days) : null,
      tracked: days,
      best: best.date ? best : null,
      range: { from: addDays(firstMonday, 0), to: end },
    };
  }

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function dayTitle(cell) {
    const parts = cell.date.split('-');
    const ru = parts[2] + '.' + parts[1];
    if (cell.future) return ru + ' · ещё не наступил';
    if (cell.pct == null) return ru + ' · нет данных';
    return ru + ' · ' + cell.pct + '%';
  }

  /* Returns a plain HTML string; the caller decides where to mount it. */
  function render(model, opts) {
    const m = model || build({});
    const o = opts || {};
    const caption = o.caption || '';
    const grid = m.weeks.map(col => '<div class="hm-col">' + col.cells.map(c =>
      '<span class="hm-cell lvl' + (c.level < 0 ? 'void' : c.level) + '"' +
      (c.date === o.highlight ? ' data-today="1"' : '') +
      ' title="' + esc(dayTitle(c)) + '" aria-label="' + esc(dayTitle(c)) + '"></span>'
    ).join('') + '</div>').join('');
    const summary = m.average == null
      ? 'Пока нет данных за этот период.'
      : 'Средний результат ' + m.average + '% за ' + m.tracked + ' дн.' + (m.best ? ' Лучший день: ' + m.best.date.split('-').reverse().join('.') + ' (' + m.best.pct + '%).' : '');
    return '<div class="heatmap-wrap">' +
      '<div class="hm-body">' +
      '<div class="hm-labels">' + m.labels.map(l => '<span>' + esc(l) + '</span>').join('') + '</div>' +
      '<div class="heatmap">' + grid + '</div>' +
      '</div>' +
      '<div class="hm-legend"><span>меньше</span>' + [0, 1, 2, 3, 4].map(l => '<i class="hm-cell lvl' + l + '"></i>').join('') + '<span>больше</span></div>' +
      (caption ? '<p class="tagline">' + esc(caption) + '</p>' : '') +
      '<p class="tagline">' + esc(summary) + '</p>' +
      '</div>';
  }

  return { VERSION, WEEKDAYS, LEVELS, isDate, addDays, indexDay, mondayOf, level, build, render };
});
