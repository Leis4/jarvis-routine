/* JARVIS Routine v43 · Russian natural-language quick-add parser (pure logic, no DOM).
   Used by site/quick.js in the browser and by tests/parse-ru.cjs in Node.

   Why first-party instead of chrono-node: chrono-node is ~110 KB minified for a
   locale module, and the product spec already requires that phrases like
   «после пар» / «после тренировки» be resolved against the JARVIS schedule rather
   than by a generic date library. A small deterministic parser covers the phrases
   the user actually writes, returns an explicit `confident` flag for everything
   else, and never guesses silently.

   Result shape:
     { title, date|null, time|null, durationMin|null, repeat|null,
       relative|null, after|null, confident, ambiguous, warnings[] }

   `after` is a dependency on a real schedule event: { kind:'classes'|'gym'|'lunch'|'dinner'|'wake' }.
   The caller resolves it with resolveAfter() once it knows the day's items. */
(function (root, factory) {
  const R = (typeof module === 'object' && module.exports) ? require('./recur.js') : root.JarvisRecur;
  const api = factory(R);
  root.JarvisParse = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (R) {
  'use strict';

  const NUM_WORDS = {
    один: 1, одну: 1, одна: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5, шесть: 6,
    семь: 7, восемь: 8, девять: 9, десять: 10, одиннадцать: 11, двенадцать: 12,
    тринадцать: 13, четырнадцать: 14, пятнадцать: 15, двадцать: 20, тридцать: 30,
    сорок: 40, пятьдесят: 50, шестьдесят: 60,
  };
  const MONTH_STEMS = [
    ['январ', 0], ['феврал', 1], ['март', 2], ['апрел', 3], ['ма', 4], ['июн', 5],
    ['июл', 6], ['август', 7], ['сентябр', 8], ['октябр', 9], ['ноябр', 10], ['декабр', 11],
  ];
  const WEEKDAY_STEMS = [
    ['понедельник', 0], ['пн', 0], ['вторник', 1], ['вт', 1], ['сред', 2], ['ср', 2],
    ['четверг', 3], ['чт', 3], ['пятниц', 4], ['пт', 4], ['суббот', 5], ['сб', 5],
    ['воскресен', 6], ['вс', 6],
  ];
  const PART_OF_DAY = [['утр', '09:00'], ['днем', '14:00'], ['днём', '14:00'], ['день', '14:00'], ['вечер', '19:00'], ['ноч', '22:00'], ['обед', '14:00']];
  const AFTER_KINDS = [
    [/после\s+пар|после\s+универ|после\s+учеб|после\s+занят/, 'classes'],
    [/после\s+тренировк|после\s+зала|после\s+спорт|после\s+качалк/, 'gym'],
    [/после\s+обеда/, 'lunch'],
    [/после\s+ужина/, 'dinner'],
    [/после\s+сна|после\s+подъема|после\s+пробужден/, 'wake'],
  ];
  const FILLER = /^(?:ну|мне|нужно|надо|давай|пожалуйста|добавь|создай|запланируй|поставь|запиши|напомни|сделать|перенеси|перенесть|сдвинь|отложи|на|в|во|к|до)\s+/i;
  const FROM_DAY = /начиная\s+с\s+(завтрашнего|сегодняшнего|послезавтрашнего)\s+дня/i;

  const num = tok => {
    if (tok == null) return null;
    if (/^\d+(?:[.,]\d+)?$/.test(tok)) return Number(String(tok).replace(',', '.'));
    return NUM_WORDS[tok] != null ? NUM_WORDS[tok] : null;
  };
  const lastDayOfMonth = (year, month) => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const pad = n => String(n).padStart(2, '0');

  function matchDuration(s) {
    const patterns = [
      [/полтора\s+часа(?![\u0430-\u044f])/, () => 90],
      [/полчаса(?![\u0430-\u044f])/, () => 30],
      [/(?:на\s+)?(\d{1,3})\s*(?:минут[\u0430-\u044f]*|мин(?![\u0430-\u044f]))/, m => Number(m[1])],
      [/(?:на\s+)?(\d{1,2})\s*(?:час[\u0430-\u044f]*|ч(?![\u0430-\u044f]))/, m => Number(m[1]) * 60],
      [/(?:на\s+)?(один|одну|одна|два|две|три|четыре|пять|шесть|семь|восемь|девять|десять|пятнадцать|двадцать|тридцать|сорок|пятьдесят|шестьдесят)\s*(?:минут[\u0430-\u044f]*|мин(?![\u0430-\u044f]))/, m => num(m[1])],
      [/(?:на\s+)?час(?![\u0430-\u044f])/, () => 60],
    ];
    for (const [re, fn] of patterns) {
      const m = re.exec(s);
      if (m) return { value: fn(m), match: m };
    }
    return null;
  }

  function parse(input, ctx) {
    const raw = String(input || '');
    const s = raw.toLowerCase().replace(/ё/g, 'е').replace(/[«»"]/g, ' ');
    const today = (ctx && ctx.today) || R.todayISO();
    const nowMinutes = ctx && ctx.nowMinutes != null ? Number(ctx.nowMinutes) : null;
    const res = {
      title: '', date: null, time: null, durationMin: null, repeat: null,
      relative: null, after: null, confident: false, ambiguous: false, warnings: [],
    };
    const spans = [];
    const take = m => spans.push([m.index, m.index + m[0].length]);
    let m;

    /* 1. Duration first, so «на 45 минут» is not mistaken for a clock time. */
    const dur = matchDuration(s);
    if (dur) { res.durationMin = dur.value; take(dur.match); }

    /* 2. Explicit clock time: «в 17», «17:30», «в 17.30». A bare «16.11» is a date,
       not 16:11, so the dot form is only accepted with an explicit «в». */
    const clock = /(?:^|[\s(])(?:в\s*)?([01]?\d|2[0-3]):([0-5]\d)(?![\d])/.exec(s);
    if (clock) {
      res.time = pad(Number(clock[1])) + ':' + clock[2];
      take(clock);
    } else {
      const dotTime = /(?:^|[\s(])в\s+([01]?\d|2[0-3])\.([0-5]\d)(?![\d])/.exec(s);
      const bare = dotTime || /(?:^|[\s(])в\s+([01]?\d|2[0-3])(?![\d:.])/.exec(s);
      if (bare) { res.time = pad(Number(bare[1])) + ':' + (dotTime ? bare[2] : '00'); take(bare); }
    }

    /* 3. Relative shifts: «через 20 минут», «перенеси на 20 минут». */
    const relShift = /(?:через|перенес[\u0430-\u044f]*|сдвинь|отложи|позже\s+на)\s+(?:на\s+)?(\d{1,3}|один|одну|два|две|три|пять|десять|пятнадцать|двадцать|тридцать)\s*(минут[\u0430-\u044f]*|мин(?![\u0430-\u044f])|час[\u0430-\u044f]*|ч(?![\u0430-\u044f]))/.exec(s);
    if (relShift) {
      const n = num(relShift[1]) || 0;
      const unit = /час|ч(?![\u0430-\u044f])/.test(relShift[2]) ? 60 : 1;
      res.relative = { kind: 'shift', minutes: n * unit };
      res.warnings.push('Сдвиг на ' + (n * unit) + ' мин от текущего времени');
      take(relShift);
    }

    /* 4. Relative days: сегодня / завтра / послезавтра / через N дней|недель. */
    const fromDay = FROM_DAY.exec(s);
    if (fromDay) {
      const offset = /завтрашнего/.test(fromDay[1]) ? 1 : /послезавтрашнего/.test(fromDay[1]) ? 2 : 0;
      res.date = R.addDays(today, offset);
      take(fromDay);
    }
    const relDays = /через\s+(\d{1,2}|один|одну|два|две|три|четыре|пять|шесть|семь|десять|две\s+недели|неделю)\s*(дн[\u0430-\u044f]*|недел[\u0430-\u044f]*)/.exec(s);
    if (relDays) {
      const token = relDays[1];
      const unit = /недел/.test(relDays[2]) ? 7 : 1;
      let n;
      if (/недел/.test(token)) n = 1;
      else if (/две\s+недели/.test(token)) n = 2;
      else n = num(token);
      if (n != null) { res.date = R.addDays(today, n * unit); take(relDays); }
    } else if (/послезавтра/.test(s)) {
      res.date = R.addDays(today, 2); take(/\s*послезавтра/.exec(s));
    } else if (/(?:^|[\s(])завтра(?![\u0430-\u044f])/.test(s)) {
      res.date = R.addDays(today, 1); take(/завтра/.exec(s));
    } else if (/(?:^|[\s(])сегодня(?![\u0430-\u044f])/.test(s)) {
      res.date = today; take(/сегодня/.exec(s));
    }

    /* 5. Weekday: «в пятницу», «в следующий вторник». */
    let wd = null;
    for (const [stem, idx] of WEEKDAY_STEMS) {
      const re = new RegExp('(?:^|[\\s(])' + stem + '[\\u0430-\u044f]*(?![\\u0430-\u044f])');
      const hit = re.exec(s);
      if (hit && (!wd || hit.index < wd.match.index)) wd = { idx, match: hit, stem };
    }
    if (wd) {
      const next = /(?:следующ|будущ)/.test(s.slice(Math.max(0, wd.match.index - 20), wd.match.index));
      const todayIdx = R.indexDay(today);
      let delta = (wd.idx - todayIdx + 7) % 7;
      if (next) delta += 7;
      if (delta === 0 && !res.date) {
        res.ambiguous = true;
        res.warnings.push('«' + wd.stem + '» — это сегодня. Если нужен следующий, уточни.');
      }
      res.date = R.addDays(today, delta);
      take(wd.match);
    }

    /* 6. Explicit date: «17 ноября», «16.11», «16.11.2026», «в конце ноября». */
    if (!res.date) {
      const endOfMonth = /(?:в\s+)?конц[\u0430-\u044f]*\s+([\u0430-\u044f]+)/.exec(s);
      const monthHit = endOfMonth && MONTH_STEMS.find(([stem]) => String(endOfMonth[1]).startsWith(stem));
      if (monthHit) {
        const y = Number(today.slice(0, 4));
        let d = y + '-' + pad(monthHit[1] + 1) + '-' + pad(lastDayOfMonth(y, monthHit[1]));
        if (R.diffDays(d, today) < 0) d = (y + 1) + '-' + pad(monthHit[1] + 1) + '-' + pad(lastDayOfMonth(y + 1, monthHit[1]));
        res.date = d; take(endOfMonth);
      } else {
        const numeric = /(?:^|[\s(])(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?(?![\d])/.exec(s);
        const textual = /(?:^|[\s(])(\d{1,2})\s+([\u0430-\u044f]+)/.exec(s);
        if (numeric) {
          const y = numeric[3] ? (numeric[3].length === 2 ? '20' + numeric[3] : numeric[3]) : today.slice(0, 4);
          let d = y + '-' + pad(Number(numeric[2])) + '-' + pad(Number(numeric[1]));
          if (!numeric[3] && R.diffDays(d, today) < 0) d = (Number(y) + 1) + '-' + pad(Number(numeric[2])) + '-' + pad(Number(numeric[1]));
          res.date = d; take(numeric);
        } else if (textual) {
          const hit = MONTH_STEMS.find(([stem]) => String(textual[2]).startsWith(stem));
          if (hit) {
            const y = Number(today.slice(0, 4));
            let d = y + '-' + pad(hit[1] + 1) + '-' + pad(Number(textual[1]));
            if (R.diffDays(d, today) < 0) d = (y + 1) + '-' + pad(hit[1] + 1) + '-' + pad(Number(textual[1]));
            res.date = d; take(textual);
          }
        }
      }
    }

    /* 7. «на следующей неделе» / «на этой неделе». */
    if (!res.date) {
      const week = /(?:на\s+)?(следующ|будущ|эт|текущ)[\u0430-\u044f]*\s+недел[\u0430-\u044f]*/.exec(s);
      if (week) {
        const monday = R.mondayOf(today);
        res.date = /следующ|будущ/.test(week[1]) ? R.addDays(monday, 7) : monday;
        res.ambiguous = res.ambiguous || !/следующ|будущ/.test(week[1]);
        take(week);
      }
    }

    /* 8. Recurrence rules. */
    const everyN = /кажд[\u0430-\u044f]*\s+(\d{1,2}|два|две|три)\s*(дн[\u0430-\u044f]*|недел[\u0430-\u044f]*)/.exec(s);
    const parity = /(нечетн|четн)[\u0430-\u044f]*\s+недел/.exec(s);
    const weekdayRepeat = /(?:кажд[\u0430-\u044f]*|по)\s+([\u0430-\u044f]+)/.exec(s);
    if (everyN) {
      const unit = /недел/.test(everyN[2]) ? 7 : 1;
      const n = num(everyN[1]);
      if (n != null) { res.repeat = { repeat: 'everyN', intervalDays: n * unit }; take(everyN); }
    } else if (parity) {
      res.repeat = { repeat: 'parity', parity: /нечетн/.test(parity[1]) ? 0 : 1, repeatDays: [] };
      take(parity);
      const stem = WEEKDAY_STEMS.find(([st]) => new RegExp(st + '[\\u0430-\u044f]*').test(s));
      if (stem) res.repeat.repeatDays = [stem[1]];
    } else if (weekdayRepeat) {
      const stem = WEEKDAY_STEMS.find(([st]) => weekdayRepeat[1].startsWith(st));
      if (stem) { res.repeat = { repeat: 'weekly', repeatDays: [stem[1]] }; take(weekdayRepeat); }
    } else if (/кажд[\u0430-\u044f]*\s+день|ежедневно/.test(s)) {
      res.repeat = { repeat: 'daily', repeatDays: [] };
      const hit = /(кажд[\u0430-\u044f]*\s+день|ежедневно)/.exec(s); if (hit) take(hit);
    }

    /* 9. Dependencies on real schedule events. */
    for (const [re, kind] of AFTER_KINDS) {
      const hit = re.exec(s);
      if (hit) { res.after = { kind }; take(hit); break; }
    }

    /* 10. Part of day, only when no explicit clock time was given. */
    if (!res.time) {
      for (const [stem, value] of PART_OF_DAY) {
        const re = new RegExp('(?:^|[\\s(])' + stem + '[\\u0430-\u044f]*(?![\\u0430-\u044f])');
        const hit = re.exec(s);
        if (hit) { res.time = value; take(hit); break; }
      }
    }

    /* 11. Title = the original text minus everything that was understood. */
    spans.sort((a, b) => a[0] - b[0]);
    let title = '', cursor = 0;
    for (const [a, b] of spans) {
      if (a < cursor) continue;
      title += raw.slice(cursor, a);
      cursor = b;
    }
    title += raw.slice(cursor);
    title = title.replace(/\s+/g, ' ').replace(/^[\s,;:.\-–—]+/, '').replace(/[\s,;:.\-–—]+$/, '');
    while (FILLER.test(title)) title = title.replace(FILLER, '');
    res.title = title.trim();

    res.confident = !!(res.date || res.time || res.relative || res.repeat || res.after);
    if (!res.confident) res.warnings.push('Не понял дату или время — уточни, например «завтра в 18:00».');
    if (res.time && !res.date) res.date = today;
    return res;
  }

  /* Turn an `after` dependency into a concrete start time using the real day items.
     items: [{name, cat, start, end}] (any order). Returns {start,end}|null. */
  function resolveAfter(parsed, items, opts) {
    const o = opts || {};
    const buffer = o.buffer != null ? o.buffer : 10;
    const list = Array.isArray(items) ? items : [];
    const hm = t => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
    const toHM = v => pad(Math.floor(v / 60) % 24) + ':' + pad(Math.round(v) % 60);
    let anchor = null;
    const kind = parsed && parsed.after && parsed.after.kind;
    const pick = re => {
      let best = null;
      for (const it of list) {
        if (!re.test(it.name || '') && !re.test(it.cat || '')) continue;
        const end = hm(it.end);
        if (end == null) continue;
        if (!best || end > best) best = end;
      }
      return best;
    };
    if (kind === 'classes') anchor = pick(/университет|лекц|семин|пар[аы]?$|практик/i);
    else if (kind === 'gym') anchor = pick(/зал|тренировк|спорт/i);
    else if (kind === 'lunch') anchor = pick(/обед/i);
    else if (kind === 'dinner') anchor = pick(/ужин/i);
    else if (kind === 'wake') anchor = o.wakeMinutes != null ? Number(o.wakeMinutes) : null;
    if (anchor == null) return null;
    const start = anchor + buffer;
    const duration = Math.max(5, Number(parsed && parsed.durationMin) || 30);
    return { start: toHM(start), end: toHM(start + duration) };
  }

  return { VERSION: 1, parse, resolveAfter, matchDuration, NUM_WORDS, WEEKDAY_STEMS, MONTH_STEMS };
});
