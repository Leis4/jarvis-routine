/* JARVIS Routine v42 · Focus / timeboxing core (pure logic, no DOM).
   Used by site/focus.js in the browser and by tests/focus-timebox.mjs in Node.
   Sessions are plain objects so they survive suspend/restore in Safari:
   { v:1, id, taskId, date, title, plannedMin, startedAt, accMs, running }
   Elapsed time always derives from timestamps, never from tick counts. */
(function (root, factory) {
  const api = factory();
  root.JarvisFocusCore = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = 1;
  const DAY_START = 4 * 60;      // personal "day" starts at 04:00
  const DAY_END = 23 * 60 + 30;  // hard stop from the schedule rules

  function parseHM(value) {
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value || ''));
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  }

  function formatHM(minutes) {
    const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
    return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  }

  function formatClock(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  function normalize(session, now) {
    const t = Number(now || Date.now());
    const src = session && typeof session === 'object' ? session : null;
    if (!src) return null;
    const accMs = Math.max(0, Number(src.accMs) || 0);
    const running = !!src.running;
    const startedAt = running ? Math.min(Number(src.startedAt) || t, t) : (Number(src.startedAt) || 0);
    return {
      v: VERSION,
      id: String(src.id || ''),
      taskId: String(src.taskId || ''),
      date: String(src.date || ''),
      title: String(src.title || 'Фокус'),
      plannedMin: Math.max(1, Math.min(600, Number(src.plannedMin) || 25)),
      startedAt,
      accMs,
      running,
      createdAt: Number(src.createdAt) || t,
    };
  }

  function elapsedMs(session, now) {
    const s = normalize(session, now);
    if (!s) return 0;
    const t = Number(now || Date.now());
    const live = s.running && s.startedAt ? Math.max(0, t - s.startedAt) : 0;
    return s.accMs + live;
  }

  function remainingMs(session, now) {
    const s = normalize(session, now);
    if (!s) return 0;
    return Math.max(0, s.plannedMin * 60000 - elapsedMs(s, now));
  }

  function start(session, now) {
    const t = Number(now || Date.now());
    const s = normalize(session, t);
    if (!s) return null;
    if (s.running) return s;
    return { ...s, running: true, startedAt: t };
  }

  function pause(session, now) {
    const t = Number(now || Date.now());
    const s = normalize(session, t);
    if (!s || !s.running) return s;
    return { ...s, running: false, accMs: s.accMs + Math.max(0, t - s.startedAt), startedAt: 0 };
  }

  function resume(session, now) { return start(pause(session, now), now); }

  function finish(session, now) {
    const t = Number(now || Date.now());
    const s = pause(session, t);
    if (!s) return null;
    return { ...s, running: false, startedAt: 0, finishedAt: t, actualMs: s.accMs };
  }

  function overlap(a, b) {
    return a.start < b.end && b.start < a.end;
  }

  /* Free windows for timeboxing.
     busy: [{start:'HH:MM', end:'HH:MM'}] — anything already on the calendar.
     opts: { minutes, from, until, buffer, step, limit }
     Returns [{start:'HH:MM', end:'HH:MM', startMin, endMin}] never overlapping busy. */
  function freeWindows(busy, opts) {
    const o = opts || {};
    const minutes = Math.max(5, Math.min(600, Number(o.minutes) || 25));
    const buffer = Math.max(0, Math.min(60, Number(o.buffer) || 0));
    const step = Math.max(5, Math.min(30, Number(o.step) || 5));
    let from = parseHM(o.from);
    let until = parseHM(o.until);
    if (from == null) from = DAY_START;
    if (until == null || until <= from) until = DAY_END;
    const limit = Math.max(1, Math.min(12, Number(o.limit) || 4));

    const blocks = (Array.isArray(busy) ? busy : [])
      .map((b) => ({ start: parseHM(b && b.start), end: parseHM(b && b.end) }))
      .filter((b) => b.start != null && b.end != null && b.end > b.start)
      .sort((a, b) => a.start - b.start);

    const out = [];
    let cursor = Math.ceil(from / step) * step;
    for (const b of blocks) {
      if (b.end <= cursor) continue;
      if (b.start >= until + minutes) break;
      if (b.start - cursor >= minutes) {
        out.push({ start: formatHM(cursor), end: formatHM(cursor + minutes), startMin: cursor, endMin: cursor + minutes });
        if (out.length >= limit) return out;
      }
      cursor = Math.max(cursor, b.end + buffer);
      if (cursor + minutes > until) return out;
    }
    while (cursor + minutes <= until && out.length < limit) {
      out.push({ start: formatHM(cursor), end: formatHM(cursor + minutes), startMin: cursor, endMin: cursor + minutes });
      cursor += Math.ceil((minutes + buffer) / step) * step;
    }
    return out;
  }

  /* Which item is happening now / next, given {start,end,id} rows. */
  function currentAndNext(rows, nowMin) {
    const list = (Array.isArray(rows) ? rows : [])
      .map((r) => ({ ...r, startMin: parseHM(r.start), endMin: parseHM(r.end) }))
      .filter((r) => r.startMin != null && r.endMin != null)
      .sort((a, b) => a.startMin - b.startMin);
    const current = list.find((r) => r.startMin <= nowMin && r.endMin > nowMin) || null;
    const next = list.find((r) => r.startMin > nowMin) || null;
    return { current, next };
  }

  function summarize(sessions) {
    const list = Array.isArray(sessions) ? sessions : [];
    const byDate = {};
    let totalMs = 0;
    for (const s of list) {
      const ms = Math.max(0, Number(s && s.actualMs) || 0);
      totalMs += ms;
      const d = String((s && s.date) || '');
      if (d) byDate[d] = (byDate[d] || 0) + ms;
    }
    return { sessions: list.length, totalMs, byDate };
  }

  return {
    VERSION, DAY_START, DAY_END,
    parseHM, formatHM, formatClock,
    normalize, elapsedMs, remainingMs,
    start, pause, resume, finish,
    overlap, freeWindows, currentAndNext, summarize,
  };
});