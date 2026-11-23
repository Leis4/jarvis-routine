/* JARVIS Routine v43 — flexible schedule policy layer.
   Implements the jarvis-flexible-schedule-policy-v1 questionnaire policy as a
   small, transparent rule engine that the real planner and the Today screen use.

   PRIVACY: this file ships NO personal data. The personal policy (class list,
   exam date, weekly allocations) is imported at runtime and kept in localStorage
   / the private template, never in site/.

   Rules actually applied (every one reversible with Undo):
   - 30% hard / 70% flexible is a planning character, not a per-day quota.
   - late 0–15 min: compress optional morning buffers, never cascade-shift the day;
     late 16–45 min: read-only preview + explicit confirmation;
     late >45 min: replan only the FUTURE after confirmation.
   - energy low: one 25-minute block max, optional in-class reading skipped;
     normal: 40-minute blocks; high: one extra block, sleep and free time kept.
   - missed flexible task: reschedule / shorten to 25 min / skip (no false "done");
     carry-over limited to the next 3 days and deduplicated.
   - protected: mandatory classes, sleep, confirmed deadlines.
   - progress = % of REQUIRED tasks completed (optional/routine excluded).
   - optional classes are never forced into reading; time stays reserved until
     the user decides, and "skip" never marks work as completed. */
(function (root, factory) {
  const api = factory(root);
  root.JarvisFlex = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const SCHEMA = 'jarvis-flexible-schedule-policy-v1';
  const STORE_KEY = 'jarvis_flexible_policy_v1';
  const LEGACY_SCHEMAS = ['jarvis-flexible-schedule-policy-v1'];

  /* Generic rules from the questionnaire policy. Personal values stay private. */
  const DEFAULT_POLICY = {
    schema: SCHEMA,
    version: '1',
    timezone: 'Europe/Moscow',
    late: [
      { max: 15, action: 'compress_optional_buffers' },
      { max: 45, action: 'preview_confirm' },
      { max: 1440, action: 'replan_future_confirm' },
    ],
    carryoverDays: 3,
    missedTaskChoices: ['reschedule', 'shorten', 'skip'],
    protected: ['mandatoryClasses', 'sleep', 'confirmedDeadlines'],
    progressMetric: 'percent_required_tasks_completed',
    focusUnitMinutes: 40,
    minimumBlockMinutes: 25,
    breakMinutes: 10,
    energy: {
      low: { maxFocusBlocks: 1, focusMinutes: 25, skipOptionalReading: true },
      normal: { focusUnitMinutes: 40 },
      high: { focusUnitMinutes: 40, maxExtraFocusBlocks: 1 },
    },
    weekMinutes: { target: 720, min: 660, max: 840 },
    morning: { minMinutes: 45, maxMinutes: 60, singleRoutine: true },
    sleep: {
      weekdayBedtime: '23:30', weekdayWake: '07:25',
      weekendBedtime: '00:00', weekendWake: '08:30',
      minMinutes: 450,
    },
    gym: { weekdays: [], flexible: true },
    family: { weekdays: [], start: null, end: null, protected: true },
    /* No personal values ship in site/. The real exam, subjects, gym and family
       days arrive at runtime from the private policy import. */
    exam: { subject: '', date: null, time: null, preparationFrom: null, preparationTo: null },
    mandatorySubjects: [],
  };

  const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

  /* The questionnaire uses long, self-describing action names; the engine works
     with three canonical kinds so both the real policy and the defaults behave
     identically. */
  function canonicalLateAction(a) {
    const s = String(a || '').toLowerCase();
    if (/compress|do_not_cascade/.test(s)) return 'compress_optional_buffers';
    if (/preview/.test(s)) return 'preview_confirm';
    if (/replan/.test(s)) return 'replan_future_confirm';
    return 'preview_confirm';
  }
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const clone = x => JSON.parse(JSON.stringify(x));

  /* ── policy loading / normalisation ─────────────────────────────── */

  function mergePolicy(raw) {
    const p = clone(DEFAULT_POLICY);
    if (!raw || typeof raw !== 'object') return p;
    /* The uploaded file nests its rules; the compact form is already flat. */
    const pl = raw.planner || {}, sc = raw.studyAndCareer || {}, sl = raw.sleep || {};
    const en = raw.energyModes || {}, ex = raw.exercise || {}, fam = raw.family || {};
    const cal = raw.calendar || {}, cr = cal.classRules || {}, dr = raw.dailyRoutine || {};

    if (Array.isArray(pl.ifRunningLateByMinutes) && pl.ifRunningLateByMinutes.length) {
      p.late = pl.ifRunningLateByMinutes.map((x, i) => ({
        max: Array.isArray(x.range) ? num(x.range[1], DEFAULT_POLICY.late[i]?.max ?? 1440) : num(x.max, 1440),
        action: canonicalLateAction(x.action || DEFAULT_POLICY.late[i]?.action),
      }));
    } else if (Array.isArray(raw.late) && raw.late.length) {
      p.late = raw.late.map(x => ({ max: num(x.max, 1440), action: canonicalLateAction(x.action) }));
    }
    p.carryoverDays = clamp(num(pl.missedFlexibleTasksCarryoverDays ?? raw.carryoverDays, p.carryoverDays), 1, 14);
    if (Array.isArray(pl.missedTaskChoices)) p.missedTaskChoices = pl.missedTaskChoices.slice();
    if (Array.isArray(pl.protected)) p.protected = pl.protected.slice();
    if (pl.progressMetric) p.progressMetric = pl.progressMetric;

    if (en.low) p.energy.low = {
      maxFocusBlocks: num(en.low.maxFocusBlocks, p.energy.low.maxFocusBlocks),
      focusMinutes: num(en.low.focusMinutes, p.energy.low.focusMinutes),
      skipOptionalReading: en.low.skipOptionalReading !== false,
    };
    if (en.normal) p.energy.normal = { focusUnitMinutes: num(en.normal.focusUnitMinutes, 40) };
    if (en.high) p.energy.high = { focusUnitMinutes: num(en.high.focusUnitMinutes, 40), maxExtraFocusBlocks: num(en.high.maxExtraFocusBlocks, 1) };

    p.focusUnitMinutes = num(sc.focusUnitMinutes ?? raw.focusUnitMinutes, p.focusUnitMinutes);
    const wk = sc.independentWorkPerWeekMinutes || raw.weekMinutes;
    if (wk) p.weekMinutes = { target: num(wk.target, p.weekMinutes.target), min: num(wk.min, p.weekMinutes.min), max: num(wk.max, p.weekMinutes.max) };

    if (dr.morningTotalMinutesRange) p.morning = {
      minMinutes: num(dr.morningTotalMinutesRange[0], 45),
      maxMinutes: num(dr.morningTotalMinutesRange[1], 60),
      singleRoutine: dr.morningIsSingleFlexibleRoutine !== false,
    };

    if (sl.weekday) {
      p.sleep.weekdayBedtime = sl.weekday.bedtime || p.sleep.weekdayBedtime;
      p.sleep.weekdayWake = sl.weekday.defaultWake || p.sleep.weekdayWake;
      p.sleep.minMinutes = num(sl.weekday.minimumSleepMinutes, p.sleep.minMinutes);
    }
    if (sl.fridayAndSaturday) {
      p.sleep.weekendBedtime = sl.fridayAndSaturday.bedtime || p.sleep.weekendBedtime;
      p.sleep.weekendWake = sl.fridayAndSaturday.wake || p.sleep.weekendWake;
    }

    if (Array.isArray(ex.preferredWeekdays) && ex.preferredWeekdays.length) {
      /* questionnaire uses 1=Monday..7=Sunday; the app uses 0=Monday..6=Sunday */
      p.gym = { weekdays: ex.preferredWeekdays.map(d => (num(d, 1) - 1 + 7) % 7), flexible: ex.doNotHardLockGymStart !== false };
    }
    if (Array.isArray(fam.recurrenceWeekdays) && fam.recurrenceWeekdays.length) {
      p.family = {
        weekdays: fam.recurrenceWeekdays.map(d => (num(d, 1) - 1 + 7) % 7),
        start: fam.preferredStart || p.family.start,
        end: fam.preferredEnd || p.family.end,
        protected: fam.defaultProtection !== 'none',
      };
    }
    if (sc.exam && sc.exam.date) {
      const prep = String(sc.exam.preparationBetween || '').split('..');
      p.exam = {
        subject: sc.exam.subject || p.exam.subject,
        date: sc.exam.date,
        time: sc.exam.time || null,
        preparationFrom: isDate(prep[0]) ? prep[0] : p.exam.preparationFrom,
        preparationTo: isDate(prep[1]) ? prep[1] : p.exam.preparationTo,
      };
    }
    if (Array.isArray(cr.questionnaireMandatorySubjects) && cr.questionnaireMandatorySubjects.length) p.mandatorySubjects = cr.questionnaireMandatorySubjects.slice();
    return p;
  }

  function validatePolicy(raw) {
    const errors = [];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['файл не является объектом политики'] };
    const schema = String(raw.schema || '');
    if (!LEGACY_SCHEMAS.includes(schema)) errors.push('схема не ' + SCHEMA);
    if (raw.calendar && !Array.isArray(raw.calendar.academicClasses)) errors.push('нет списка пар');
    if (raw.calendar && Array.isArray(raw.calendar.academicClasses) && raw.calendar.academicClasses.length < 20) errors.push('пар меньше 20 — похоже на повреждённый файл');
    if (raw.qaGates && num(raw.qaGates.privateTemplateOriginalBlocks, 0) !== 392) errors.push('политика ожидает 392 исходных блока');
    if (raw.planner && Array.isArray(raw.planner.ifRunningLateByMinutes) && raw.planner.ifRunningLateByMinutes.length !== 3) errors.push('правило опоздания должно иметь 3 диапазона');
    return { ok: errors.length === 0, errors };
  }

  function normalizePolicy(raw) { return mergePolicy(raw); }

  /* ── pure rule helpers ──────────────────────────────────────────── */

  function lateBand(minutes, policy) {
    const p = policy || DEFAULT_POLICY;
    const m = Math.max(0, num(minutes, 0));
    for (const b of p.late) if (m <= b.max) return b;
    return p.late[p.late.length - 1];
  }

  function energyKey(level) {
    const l = clamp(num(level, 3), 1, 5);
    return l <= 2 ? 'low' : l === 3 ? 'normal' : 'high';
  }

  function energyPlan(policy, key) {
    const p = policy || DEFAULT_POLICY;
    if (key === 'low') return { key, ...p.energy.low };
    if (key === 'high') return { key, focusMinutes: p.energy.high.focusUnitMinutes, maxExtraBlocks: p.energy.high.maxExtraFocusBlocks, keepSleepAndFreeTime: true };
    return { key: 'normal', focusMinutes: p.energy.normal.focusUnitMinutes, maxExtraBlocks: 0 };
  }

  function carryoverTargets(fromISO, days) {
    const out = [];
    let base = Date.parse(fromISO + 'T12:00:00Z');
    for (let i = 1; i <= days; i++) out.push(new Date(base + i * 86400000).toISOString().slice(0, 10));
    return out;
  }

  function requiredPercent(rows) {
    const req = rows.filter(r => r.required);
    if (!req.length) return { percent: 100, done: 0, total: 0 };
    const d = req.filter(r => r.done).length;
    return { percent: Math.round(d / req.length * 100), done: d, total: req.length };
  }

  function examActive(policy, iso) {
    const p = policy || DEFAULT_POLICY;
    if (!isDate(iso)) return false;
    if (!isDate(p.exam.date) || !isDate(p.exam.preparationFrom)) return false;
    return iso >= p.exam.preparationFrom && iso <= p.exam.date;
  }

  /* ── browser layer ──────────────────────────────────────────────── */

  /* `S`, `ui`, `PLANS` are declared with `let` in index.html, so they are NOT
     properties of `window`; they must be read through the global scope. */
  const ST = () => (typeof S !== 'undefined' && S ? S : null);
  const UI = () => (typeof ui !== 'undefined' && ui ? ui : null);

  const isBrowser = typeof document !== 'undefined' && typeof S !== 'undefined' && typeof render === 'function';

  function state() {
    const st = ST();
    if (!st) return null;
    if (!st.flex || typeof st.flex !== 'object') st.flex = { mode: 'off', policy: null, energy: null, carry: {}, skip: {}, group: {}, preview: null, undo: [] };
    const f = st.flex;
    if (!f.carry) f.carry = {};
    if (!f.skip) f.skip = {};
    if (!f.group) f.group = {};
    f.undo = undoStack(f);
    return f;
  }

  function policy() {
    const f = state();
    return (f && f.policy) ? mergePolicy(f.policy) : clone(DEFAULT_POLICY);
  }

  function loadStoredPolicy() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (raw) return mergePolicy(raw);
    } catch (e) {}
    return null;
  }

  function importPolicy(raw) {
    const v = validatePolicy(raw);
    if (!v.ok) return v;
    const f = state();
    f.policy = mergePolicy(raw);
    f.mode = 'on';
    try { localStorage.setItem(STORE_KEY, JSON.stringify(raw)); } catch (e) {}
    return { ok: true, errors: [] };
  }

  /* planning primitives */
  const CF = () => (root.jarvisTaskConflict && typeof root.jarvisTaskConflict.freeSlot === 'function') ? root.jarvisTaskConflict : null;
  const isFlex = t => t && (t.status === 'Гибко' || t.status === 'План');
  const flexRank = t => t.status === 'План' ? 3 : t.status === 'Гибко' ? 2 : 1;
  const isMandatorySubject = (t, p) => (p.mandatorySubjects || []).some(s => new RegExp(String(s).split(/\s+/)[0], 'i').test(t.name));

  function isProtected(t, s) {
    if (!t) return true;
    if (t.cat === 'Сон' || /(отбой|подготовк.*сн|сон\b)/i.test(t.name)) return true;
    if (t.status === 'Фиксировано' || t.fixed) return true;
    if (t.cat === 'Семья') return true;
    if (t.cat === 'Университет') return true;
    if (t.cat === 'Дорога') return true;
    if (t.deadlineDate) return true;
    try { if (typeof root.plannerIsFixed === 'function' && root.plannerIsFixed(t, s)) return true; } catch (e) {}
    return false;
  }

  function isConditionalClass(t) { return t && t.cat === 'Университет' && t.status === 'Условно'; }

  function bedtimeFor(s, p) {
    const day = typeof indexDay === 'function' ? indexDay(s) : 0;
    return (day === 4 || day === 5) ? p.sleep.weekendBedtime : p.sleep.weekdayBedtime;
  }

  function itemsOf(s) { return typeof itemList === 'function' ? itemList(s) : []; }
  function isDone(s, id) { return typeof done === 'function' ? done(s, id) : false; }
  function req(t) { return typeof isRequired === 'function' ? isRequired(t) : t.status === 'Обязательно'; }

  function morningOptional(s, p) {
    return itemsOf(s).filter(t => !isProtected(t, s) && !req(t) && !isDone(s, t.id) && typeof timeGroup === 'function' && timeGroup(t) === 'УТРО');
  }
  function undoneFlex(s) {
    return itemsOf(s).filter(t => isFlex(t) && !isDone(s, t.id) && !isProtected(t, s)).sort((a, b) => flexRank(a) - flexRank(b) || String(a.start).localeCompare(String(b.start)));
  }

  /* ── previews (read-only) ───────────────────────────────────────── */

  function previewLate(minutes, s) {
    const p = policy(), band = lateBand(minutes, p);
    const changes = [];
    if (band.action === 'compress_optional_buffers') {
      for (const t of morningOptional(s, p)) changes.push({ id: t.id, name: t.name, action: 'omit', why: 'утренний буфер' });
    } else if (band.action === 'preview_confirm') {
      for (const t of morningOptional(s, p)) changes.push({ id: t.id, name: t.name, action: 'omit', why: 'утренний буфер' });
      for (const t of undoneFlex(s).slice(0, 2)) changes.push({ id: t.id, name: t.name, action: 'defer', why: 'низкий приоритет' });
    } else {
      for (const t of undoneFlex(s)) changes.push({ id: t.id, name: t.name, action: 'replan', why: 'только будущее' });
    }
    return { kind: 'late', minutes: num(minutes, 0), band, changes, s };
  }

  function previewEnergy(level, s) {
    const p = policy(), key = energyKey(level), plan = energyPlan(p, key);
    const changes = [];
    if (key === 'low') {
      const flex = undoneFlex(s);
      for (const t of flex.slice(plan.maxFocusBlocks)) changes.push({ id: t.id, name: t.name, action: 'defer', why: 'мало сил: один блок 25 мин' });
    }
    return { kind: 'energy', level: num(level, 3), energy: plan, changes, s, skipReading: key === 'low' && !!plan.skipOptionalReading };
  }

  /* Morning essentials collapse into ONE flexible 45–60 min package instead of
     a per-minute list. Display-level and reversible; the 392 source blocks and
     the private template are never modified. */
  function morningGroupCandidates(s, p) {
    return itemsOf(s).filter(t => {
      if (t.cat === 'Буфер' || t.status === 'Буфер') return false;
      if (t.cat === 'Дорога' || t.cat === 'Университет') return false;
      if (!['Гигиена', 'Питание', 'Быт', 'Организация'].includes(t.cat)) return false;
      if (typeof timeGroup === 'function' && timeGroup(t) !== 'УТРО') return false;
      return clock(t.end) - clock(t.start) <= 30;
    });
  }

  function previewMorning(s) {
    const p = policy();
    const ids = morningGroupCandidates(s, p);
    if (!ids.length) return { kind: 'morning', s, changes: [], start: null, end: null };
    const start = Math.min(...ids.map(t => clock(t.start)));
    const end = Math.min(start + p.morning.maxMinutes, Math.max(...ids.map(t => clock(t.end))));
    return { kind: 'morning', s, changes: ids.map(t => ({ id: t.id, name: t.name, action: 'group', why: 'утренний пакет' })), start: niceTime(start), end: niceTime(end) };
  }

  function previewMissed(id, choice, s) {
    const t = itemsOf(s).find(x => x.id === id);
    if (!t) return null;
    if (!['reschedule', 'shorten', 'skip'].includes(choice)) choice = 'reschedule';
    return { kind: 'missed', id, name: t.name, choice, s };
  }

  /* ── apply ──────────────────────────────────────────────────────── */

  /* Undo is bound to the OPERATION, never to the day the panel happens to show.
     A "missed" preview may target yesterday while the UI shows today, so the
     reversible snapshot is kept in an ordered stack and unwound last-in-first-out. */
  const MAX_UNDO = 10;
  function undoStack(f) {
    if (Array.isArray(f.undo)) return f.undo;
    /* migrate the legacy { day: snapshot } map into the operation stack */
    const legacy = (f.undo && typeof f.undo === 'object') ? f.undo : {};
    f.undo = Object.keys(legacy).map(day => ({ day, snap: legacy[day] }));
    return f.undo;
  }
  function undoAvailable(f) { return undoStack(f).length > 0; }

  function snapshot(s) {
    const st = ST();
    return clone({ dayAdjust: st.dayAdjust || {}, extras: st.extras || [], carry: state().carry, skip: state().skip, group: state().group || {}, energy: state().energy });
  }
  function restore(snap) {
    const st = ST();
    st.dayAdjust = snap.dayAdjust;
    st.extras = snap.extras;
    const f = state();
    f.carry = snap.carry;
    f.skip = snap.skip;
    f.group = snap.group;
    f.energy = snap.energy != null ? snap.energy : null;
  }

  function pushUndo(f, day) {
    const stack = undoStack(f);
    stack.push({ day, snap: snapshot(day) });
    while (stack.length > MAX_UNDO) stack.shift();
  }

  function setAdjust(s, id, patch) {
    const st = ST();
    st.dayAdjust = st.dayAdjust || {};
    st.dayAdjust[s] = st.dayAdjust[s] || {};
    st.dayAdjust[s][id] = { ...(st.dayAdjust[s][id] || {}), ...patch };
  }

  function applyPreview() {
    const f = state(); if (!f || !f.preview) return { ok: false, reason: 'нет предпросмотра' };
    const pv = f.preview, s = pv.s, p = policy();
    pushUndo(f, s);
    let applied = 0, carried = 0, replanned = 0;

    if (pv.kind === 'late') {
      const cf = CF();
      for (const c of pv.changes) {
        if (c.action === 'replan' && cf) {
          const t = itemsOf(s).find(x => x.id === c.id);
          const slot = t ? cf.freeSlot(s, t.id, t.start, t.end) : null;
          if (slot && slot.start !== t.start && clock(slot.end) <= minutesHM(bedtimeFor(s, p))) { setAdjust(s, c.id, { start: slot.start, end: slot.end }); replanned++; continue; }
        }
        setAdjust(s, c.id, { omit: true });
        if (c.action === 'defer') f.carry[c.id] = (f.carry[c.id] || 0) + 1;
        applied++;
      }
    } else if (pv.kind === 'energy') {
      f.energy = pv.energy.key;
      for (const c of pv.changes) { setAdjust(s, c.id, { omit: true }); f.carry[c.id] = (f.carry[c.id] || 0) + 1; applied++; }
      if (pv.skipReading) for (const t of itemsOf(s)) if (isConditionalClass(t)) f.skip[`${s}::${t.id}`] = 'no_reading';
    } else if (pv.kind === 'morning') {
      if (pv.start) { f.group[s] = { ids: pv.changes.map(c => c.id), start: pv.start, end: pv.end }; applied = pv.changes.length; }
    } else if (pv.kind === 'missed') {
      const cf = CF();
      const t = itemsOf(s).find(x => x.id === pv.id);
      if (t) {
        if (pv.choice === 'skip') { setAdjust(s, t.id, { omit: true }); f.skip[`${s}::${t.id}`] = 'skipped'; applied++; }
        else if (pv.choice === 'shorten') {
          const slot = cf ? cf.freeSlot(s, t.id, t.start, niceTime(clock(t.start) + p.minimumBlockMinutes)) : null;
          if (slot) { setAdjust(s, t.id, { start: slot.start, end: slot.end }); applied++; }
          else { setAdjust(s, t.id, { omit: true }); applied++; }
        } else {
          setAdjust(s, t.id, { omit: true });
          const target = placeCarryover(t, s, p);
          if (target) carried++; else applied++;
        }
      }
    }
    delete f.preview;
    /* A failed write must never look like success: roll the in-memory change
       back to the snapshot we just pushed and drop that undo entry, so a reload
       and the Undo stack both stay truthful. */
    if (!persistAndRender()) {
      const stack = undoStack(f);
      const rec = stack.length && stack[stack.length - 1].day === s ? stack.pop() : null;
      if (rec) restore(rec.snap);
      try { if (typeof render === 'function') render(); } catch (e) {}
      return { ok: false, reason: 'Не удалось сохранить на устройстве. Изменения не применены.' };
    }
    return { ok: true, applied, carried, replanned, s };
  }

  /* Carry a missed flexible task into the next free day within the policy limit.
     Idempotent: the same origin is never carried twice, so repeating the action
     (or a re-render replay) cannot duplicate the task. */
  function placeCarryover(t, s, p) {
    const cf = CF(); if (!cf) return null;
    const f = state();
    const st = ST();
    const existing = (st.extras || []).find(x => x.carryOf === t.id);
    if (existing) return existing.fromDate;
    const len = Math.max(p.minimumBlockMinutes, clock(t.end) - clock(t.start));
    for (const day of carryoverTargets(s, p.carryoverDays)) {
      const key = `${day}::${t.id}`;
      if (f.carry[key]) continue;
      const already = (st.extras || []).some(x => x.carryOf === t.id && x.fromDate === day);
      if (already) { f.carry[key] = 1; continue; }
      const slot = cf.freeSlot(day, null, '09:00', niceTime(9 * 60 + len));
      if (!slot) continue;
      const id = 'x_flex_' + t.id + '_' + day;
      if ((st.extras || []).some(x => x.id === id)) { f.carry[key] = 1; continue; }
      st.extras.push({ id, name: t.name, cat: t.cat, status: 'Гибко', start: slot.start, end: slot.end, fromDate: day, repeat: 'once', carryOf: t.id, note: 'перенос' });
      f.carry[key] = 1;
      return day;
    }
    return null;
  }

  function undo(s) {
    const f = state(); if (!f) return false;
    const stack = undoStack(f);
    if (!stack.length) return false;
    const rec = stack.pop();
    restore(rec.snap);
    persistAndRender();
    return true;
  }

  function persistAndRender() {
    let ok = true;
    try { if (typeof persist === 'function') ok = persist() !== false; } catch (e) { ok = false; }
    try { if (typeof render === 'function') render(); } catch (e) {}
    return ok;
  }

  /* WebKit occasionally resolves Blob.text() with an empty string right after a
     file is chosen. Retry (with a FileReader fallback) so a valid policy is never
     silently dropped on the user's phone. */
  async function readFileText(file) {
    for (let attempt = 0; attempt < 6; attempt++) {
      let text = '';
      try { text = await file.text(); } catch (e) {}
      if (!text) {
        text = await new Promise(resolve => {
          try {
            const r = new FileReader();
            r.onload = () => resolve(String(r.result || ''));
            r.onerror = () => resolve('');
            r.readAsText(file);
          } catch (e) { resolve(''); }
        });
      }
      if (text) return text;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return '';
  }

  /* ── UI ─────────────────────────────────────────────────────────── */

  function esc(x) { return String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  function progressOf(s) {
    const rows = itemsOf(s).map(t => ({ required: req(t) && t.status !== 'Буфер', done: isDone(s, t.id) }));
    return requiredPercent(rows);
  }

  function missedList(s) {
    const out = [];
    for (const day of [s, shiftISO(s, -1)]) {
      for (const t of itemsOf(day)) {
        if (isDone(day, t.id)) continue;
        if (isConditionalClass(t)) { out.push({ day, t, kind: 'class' }); continue; }
        if (isProtected(t, day)) continue;
        if (isFlex(t)) out.push({ day, t, kind: 'flex' });
      }
    }
    return out.slice(0, 6);
  }

  function shiftISO(s, n) {
    const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
  }

  function panelHTML(s) {
    const f = state(); if (!f) return '';
    const on = f.mode === 'on';
    const p = policy();
    const pr = progressOf(s);
    const pv = f.preview;
    const examLine = examActive(p, s)
      ? `<p class="flex-exam">Приоритет: подготовка к контрольной ${esc(p.exam.subject)} ${esc(p.exam.date.slice(8, 10) + '.' + p.exam.date.slice(5, 7))}. Точное время не подтверждено.</p>` : '';
    let body;
    if (!on) {
      body = `<p class="tagline">Утро, Python, учёба, тренировки и отдых становятся окнами. Точные пары и сон защищены. Включи, чтобы JARVIS учитывал опоздание, усталость и переносы.</p>`;
    } else {
      const preview = pv ? `<div class="flex-preview" role="status">
        <b>Предпросмотр · ${esc(previewTitle(pv))}</b>
        <ul>${previewLines(pv).map(l => `<li>${esc(l)}</li>`).join('') || '<li>изменений не требуется</li>'}</ul>
        <div class="flex-actions"><button class="btn tight primary" data-flex="apply">Применить</button><button class="btn tight" data-flex="cancel">Отмена</button></div>
      </div>` : '';
      const missed = missedList(s).map(({ day, t, kind }) => `<div class="flex-missed-row"><span class="grow">${esc(t.name)}${day !== s ? ' <small>(' + esc(day.slice(8, 10) + '.' + day.slice(5, 7)) + ')</small>' : ''}</span>
        ${kind === 'class'
          ? `<button class="btn tight" data-flex="missed" data-choice="skip" data-id="${esc(t.id)}" data-day="${esc(day)}">Не пойду · без отметки</button>`
          : `<button class="btn tight" data-flex="missed" data-choice="shorten" data-id="${esc(t.id)}" data-day="${esc(day)}">25 мин</button>
        <button class="btn tight" data-flex="missed" data-choice="reschedule" data-id="${esc(t.id)}" data-day="${esc(day)}">Перенести</button>
        <button class="btn tight" data-flex="missed" data-choice="skip" data-id="${esc(t.id)}" data-day="${esc(day)}">Пропустить</button>`}</div>`).join('');
      body = `${examLine}
        <p class="tagline">Обязательных выполнено: <b>${pr.percent}%</b> (${pr.done} из ${pr.total}) · цель недели ${p.weekMinutes.target} мин</p>
        <div class="flex-actions"><button class="btn tight" data-flex="late" data-min="10">Опоздал 10 мин</button><button class="btn tight" data-flex="late" data-min="30">Опоздал 30 мин</button><button class="btn tight" data-flex="late" data-min="90">Опоздал 1.5 ч</button></div>
        <div class="flex-actions"><button class="btn tight" data-flex="energy" data-level="1">Мало сил</button><button class="btn tight" data-flex="energy" data-level="3">Норма</button><button class="btn tight" data-flex="energy" data-level="5">Много сил</button>${f.group[s] ? '' : '<button class="btn tight" data-flex="morning">Утренний пакет</button>'}</div>
        ${preview}
        ${missed ? `<div class="flex-missed"><div class="eyebrow">НЕ УСПЕЛ · выбери действие</div>${missed}</div>` : ''}
        <div class="flex-actions"><button class="btn tight" data-flex="policy">Загрузить политику</button>${undoAvailable(f) ? '<button class="btn tight" data-flex="undo">↶ Отменить</button>' : ''}</div>`;
    }
    return `<div class="card flex-panel" id="flexPanel"><div class="flex-head"><div class="eyebrow">ГИБКИЙ РЕЖИМ</div><button class="btn tight ${on ? 'primary' : ''}" data-flex="mode" aria-pressed="${on}">${on ? 'Включён' : 'Включить'}</button></div>${body}<input type="file" id="flexPolicyFile" accept="application/json,.json" hidden></div>`;
  }

  function previewTitle(pv) {
    if (pv.kind === 'late') return `опоздание ${pv.minutes} мин`;
    if (pv.kind === 'morning') return 'утренний пакет';
    if (pv.kind === 'energy') return `энергия: ${pv.energy.key === 'low' ? 'мало сил' : pv.energy.key === 'high' ? 'много сил' : 'норма'}`;
    return `не успел: ${pv.name}`;
  }
  function previewLines(pv) {
    if (pv.kind === 'missed') return [pv.choice === 'shorten' ? 'сократить до 25 минут в свободном окне' : pv.choice === 'skip' ? 'пропустить без ложной отметки' : `перенести на ближайшие ${policy().carryoverDays} дня`];
    if (pv.kind === 'morning') return pv.start ? [`собрать ${pv.changes.length} мелких блоков в один пакет ${pv.start}–${pv.end}`] : ['мелких утренних блоков нет'];
    if (pv.kind === 'energy' && !pv.changes.length) return ['режим сохранён, расписание не меняется'];
    return pv.changes.map(c => `${c.action === 'replan' ? 'перепланировать' : c.action === 'omit' ? 'снять' : c.action === 'group' ? 'объединить' : 'отложить'}: ${c.name} (${c.why})`);
  }

  function toggleMode() {
    const f = state(); f.mode = f.mode === 'on' ? 'off' : 'on';
    if (f.mode === 'on' && !f.policy) { const stored = loadStoredPolicy(); if (stored) f.policy = stored; }
    persistAndRender();
    try { if (typeof toast === 'function') toast(f.mode === 'on' ? 'Гибкий режим включён' : 'Гибкий режим выключен'); } catch (e) {}
  }

  function injectPanel(html, s) {
    const marker = '<div class="subhead"><h2>Привычки</h2>';
    const panel = panelHTML(s);
    if (!panel) return html;
    return html.includes(marker) ? html.replace(marker, panel + marker) : html + panel;
  }

  if (isBrowser) {
    state();
    /* Collapse the morning essentials into one flexible package when the user
       confirmed it. Display-level only: the source blocks stay in the template. */
    if (typeof root.itemList === 'function') {
      const prevList = root.itemList;
      root.itemList = function (s) {
        const arr = prevList.apply(this, arguments);
        const st = ST();
        const g = st && st.flex && st.flex.group && st.flex.group[s];
        if (!g || !Array.isArray(g.ids) || !g.ids.length) return arr;
        const kept = arr.filter(t => !g.ids.includes(t.id));
        kept.push({ id: 'x_flex_morning_' + s, name: 'Утренний пакет', cat: 'Быт', status: 'Гибко', start: g.start, end: g.end, note: 'гигиена · завтрак · сборы' });
        return kept.sort((a, b) => clock(a.start) - clock(b.start));
      };
    }
    if (typeof root.todayView === 'function') {
      const prev = root.todayView;
      root.todayView = function () {
        const s = (UI() && UI().date) || (typeof today === 'function' ? today() : '');
        return injectPanel(prev.apply(this, arguments), s);
      };
    }

    document.addEventListener('click', e => {
      const el = e.target.closest && e.target.closest('[data-flex]');
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      const f = state();
      const s = (UI() && UI().date) || today();
      const a = el.dataset.flex;
      if (a === 'mode') toggleMode();
      else if (a === 'morning') { f.preview = previewMorning(s); render(); }
      else if (a === 'late') { f.preview = previewLate(num(el.dataset.min, 10), s); render(); }
      else if (a === 'energy') { f.preview = previewEnergy(num(el.dataset.level, 3), s); render(); }
      else if (a === 'missed') {
        const day = el.dataset.day || s;
        f.preview = previewMissed(el.dataset.id, el.dataset.choice, day);
        if (!f.preview) { try { toast('Дело уже не в расписании'); } catch (e2) {} }
        render();
      }
      else if (a === 'apply') {
        const r = applyPreview();
        try { if (!r.ok) toast(r.reason || 'Не удалось сохранить изменения'); else toast(r.carried ? `Применено, перенесено на ${r.carried} ${r.carried === 1 ? 'день' : 'дня'}` : r.replanned ? 'Перепланировано на будущее' : 'Применено'); } catch (e2) {}
      }
      else if (a === 'cancel') { f.preview = null; render(); }
      else if (a === 'undo') { if (undo(s)) { try { toast('Изменения отменены'); } catch (e2) {} } }
      else if (a === 'policy') { const inp = document.getElementById('flexPolicyFile'); if (inp) inp.click(); }
    });

    document.addEventListener('change', async e => {
      if (!e.target || e.target.id !== 'flexPolicyFile') return;
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const text = await readFileText(file);
      try { e.target.value = ''; } catch (err) {}
      let raw = null;
      try { raw = JSON.parse(text); } catch (err) {}
      const v = raw ? importPolicy(raw) : { ok: false, errors: ['не удалось прочитать JSON'] };
      if (!v.ok) { try { toast('Политика не принята: ' + v.errors[0]); } catch (err) {} return; }
      persistAndRender();
      try { toast('Гибкая политика загружена'); } catch (err) {}
    });
  }

  return {
    VERSION: 1,
    SCHEMA, STORE_KEY, DEFAULT_POLICY,
    normalizePolicy, mergePolicy, validatePolicy,
    lateBand, energyKey, energyPlan, carryoverTargets, requiredPercent, examActive,
    isFlex, isProtected, isConditionalClass, bedtimeFor,
    state, policy, importPolicy, loadStoredPolicy,
    previewLate, previewEnergy, previewMissed, previewMorning, applyPreview, undo, toggleMode,
    placeCarryover, _panelHTML: s => panelHTML(s), _injectPanel: injectPanel,
  };
});
