/* JARVIS Routine v43 · Study module (spaced repetition).
   Optional by design: the app works exactly the same if this file, or the
   vendored ts-fsrs bundle, never loads.

   Two hard product rules are enforced here, not only in the UI:
     1. "Ознакомление ≠ успешное повторение" — introduce() records that a card
        was seen and does NOT increase the successful-review counter.
     2. Repetitions are never planned on top of classes or any other fixed block:
        the caller must supply a real free-slot finder; without a free window the
        session is reported as blocked instead of silently overlapping.

   Scheduling uses ts-fsrs when its bundle is available and falls back to a small
   deterministic Leitner ladder otherwise. Both paths write the same card shape,
   so the data survives the engine changing. */
(function (root, factory) {
  const api = factory(root);
  root.JarvisStudy = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const VERSION = 1;
  const MAX_CARDS = 200;        // "не генерировать сотни карточек"
  const SESSION_LIMIT = 20;     // one sitting stays short and honest
  const LOG_LIMIT = 2000;
  const DAY_MS = 86400000;
  const STEPS = [0, 1, 3, 7, 16, 35, 70, 140];
  const RATINGS = ['again', 'hard', 'good', 'easy'];
  const RATING_RU = { again: 'Забыл', hard: 'Трудно', good: 'Помню', easy: 'Легко' };

  const pad = n => String(n).padStart(2, '0');
  const dayOf = ms => { const d = new Date(ms); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  const dateMs = s => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '')); return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN; };

  function normalize(state) {
    const s = state && typeof state === 'object' ? state : {};
    if (s.v !== VERSION) s.v = VERSION;
    if (!Array.isArray(s.decks)) s.decks = [{ id: 'd_default', name: 'Основное' }];
    if (!s.decks.length) s.decks.push({ id: 'd_default', name: 'Основное' });
    if (!Array.isArray(s.cards)) s.cards = [];
    if (!Array.isArray(s.log)) s.log = [];
    if (s.limit == null) s.limit = MAX_CARDS;
    return s;
  }

  const uid = prefix => prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  /* ── engine ───────────────────────────────────────────────────────── */

  function fsrsApi() {
    const F = root.FSRS;
    return F && typeof F.fsrs === 'function' && F.Rating ? F : null;
  }

  let engine = null;
  function engineInstance() {
    if (engine) return engine;
    const F = fsrsApi();
    if (!F) return null;
    try { engine = F.fsrs(F.generatorParameters({ enable_fuzz: false })); } catch (e) { engine = null; }
    return engine;
  }

  let loading = null;
  /* Lazy-load the vendored bundle after first paint; the fallback ladder works until then. */
  function ensureFsrs() {
    if (fsrsApi()) return Promise.resolve(true);
    if (loading) return loading;
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return Promise.resolve(false);
    loading = new Promise(resolve => {
      try {
        const s = document.createElement('script');
        s.src = 'vendor/fsrs.min.js';
        s.async = true;
        s.onload = () => resolve(!!fsrsApi());
        s.onerror = () => resolve(false);
        (document.head || document.body || document.documentElement).appendChild(s);
      } catch (e) { resolve(false); }
    });
    return loading;
  }

  function stateName(F, fsrsState) {
    const S = F.State;
    if (!S) return 'review';
    if (fsrsState === S.New) return 'new';
    if (fsrsState === S.Learning) return 'learning';
    if (fsrsState === S.Review) return 'review';
    if (fsrsState === S.Relearning) return 'relearn';
    return 'review';
  }

  /* ── cards ────────────────────────────────────────────────────────── */

  function createDeck(state, name) {
    const s = normalize(state);
    const clean = String(name || '').trim().slice(0, 60);
    if (!clean) return null;
    const deck = { id: uid('d_'), name: clean };
    s.decks.push(deck);
    return deck;
  }

  function createCard(state, deckId, front, back, now) {
    const s = normalize(state);
    const f = String(front || '').trim().slice(0, 300);
    const b = String(back || '').trim().slice(0, 600);
    if (!f || !b) return { error: 'empty' };
    if (s.cards.length >= (Number(s.limit) || MAX_CARDS)) return { error: 'limit' };
    const deck = s.decks.find(d => d.id === deckId) || s.decks[0];
    const ts = Number(now) || Date.now();
    const card = {
      id: uid('c_'), deck: deck.id, front: f, back: b,
      created: ts, due: dayOf(ts), dueAt: ts, state: 'new',
      step: 0, reps: 0, reviews: 0, lapses: 0, introducedAt: null, lastReview: null, fsrs: null,
    };
    s.cards.push(card);
    return { card };
  }

  function cardById(state, id) { return normalize(state).cards.find(c => c.id === id) || null; }

  function removeCard(state, id) {
    const s = normalize(state);
    const before = s.cards.length;
    s.cards = s.cards.filter(c => c.id !== id);
    return s.cards.length !== before;
  }

  function dueAt(card) { return Number(card.dueAt) || dateMs(card.due); }

  function dueCards(state, date) {
    const s = normalize(state);
    const end = dateMs(isDate(date) ? date : dayOf(Date.now()));
    return s.cards
      .filter(c => dueAt(c) <= end + DAY_MS - 1)
      .sort((a, b) => dueAt(a) - dueAt(b));
  }

  /* First exposure. Deliberately does NOT count as a successful repetition. */
  function introduce(state, cardId, now) {
    const s = normalize(state);
    const card = cardById(s, cardId);
    if (!card) return null;
    const ts = Number(now) || Date.now();
    if (!card.introducedAt) card.introducedAt = ts;
    if (card.state === 'new') { card.state = 'learning'; card.step = 0; }
    card.dueAt = ts;
    card.due = dayOf(ts);
    s.log.push({ at: ts, cardId, type: 'introduce' });
    if (s.log.length > LOG_LIMIT) s.log = s.log.slice(-LOG_LIMIT);
    return card;
  }

  function grade(state, cardId, rating, now) {
    const s = normalize(state);
    const card = cardById(s, cardId);
    if (!card) return null;
    if (!RATINGS.includes(rating)) return null;
    const ts = Number(now) || Date.now();
    const F = fsrsApi();
    let intervalDays = 0;

    if (F) {
      if (!card.fsrs) card.fsrs = F.createEmptyCard(new Date(ts));
      const eng = engineInstance();
      const rec = eng.repeat(card.fsrs, new Date(ts));
      const map = { again: F.Rating.Again, hard: F.Rating.Hard, good: F.Rating.Good, easy: F.Rating.Easy };
      const entry = rec[map[rating]] || rec[F.Rating.Good];
      card.fsrs = entry.card;
      const due = entry.card.due instanceof Date ? entry.card.due.getTime() : Number(entry.card.due) || ts;
      card.dueAt = due;
      card.due = dayOf(due);
      card.state = stateName(F, entry.card.state);
      intervalDays = Math.max(0, Math.round((due - ts) / DAY_MS));
      card.step = Math.max(0, Math.min(STEPS.length - 1, card.step + (rating === 'again' ? 0 : rating === 'hard' ? 1 : rating === 'easy' ? 2 : 1)));
    } else {
      if (rating === 'again') {
        card.step = 0;
        intervalDays = 0;
        card.dueAt = ts + 10 * 60000;
      } else {
        const step = card.step | 0;
        const next = rating === 'hard' ? step : rating === 'easy' ? Math.min(STEPS.length - 1, step + 2) : Math.min(STEPS.length - 1, step + 1);
        card.step = next;
        intervalDays = rating === 'hard' ? Math.max(1, Math.round(STEPS[next] / 2)) : STEPS[next];
        card.dueAt = ts + intervalDays * DAY_MS;
      }
      card.due = dayOf(card.dueAt);
      card.state = intervalDays >= 1 ? 'review' : 'learning';
    }

    card.reps++;
    card.lastReview = ts;
    if (!card.introducedAt) card.introducedAt = ts;
    if (rating === 'again') card.lapses++;
    else card.reviews++;          // only real recalls count as successful repetitions

    s.log.push({ at: ts, cardId, type: 'review', rating, intervalDays });
    if (s.log.length > LOG_LIMIT) s.log = s.log.slice(-LOG_LIMIT);
    return { card, intervalDays, success: rating !== 'again' };
  }

  function stats(state, now) {
    const s = normalize(state);
    const today = dayOf(Number(now) || Date.now());
    const due = dueCards(s, today);
    const byDeck = s.decks.map(d => {
      const cards = s.cards.filter(c => c.deck === d.id);
      return { id: d.id, name: d.name, total: cards.length, due: cards.filter(c => dueAt(c) <= dateMs(today) + DAY_MS - 1).length };
    });
    return {
      total: s.cards.length,
      decks: s.decks.length,
      due: due.length,
      fresh: s.cards.filter(c => c.state === 'new').length,
      introduced: s.cards.filter(c => c.introducedAt).length,
      reviews: s.cards.reduce((a, c) => a + (c.reviews || 0), 0),
      lapses: s.cards.reduce((a, c) => a + (c.lapses || 0), 0),
      byDeck,
      engine: fsrsApi() ? 'fsrs' : 'fallback',
    };
  }

  /* A session is a bounded queue plus the real free window it fits into.
     `opts.freeSlots(date, minutes)` must come from the app's own conflict-aware
     scheduler; without it no window is claimed. */
  function planSession(state, date, opts) {
    const o = opts || {};
    const s = normalize(state);
    const limit = Math.max(1, Math.min(SESSION_LIMIT, Number(o.limit) || SESSION_LIMIT));
    const cards = dueCards(s, date).slice(0, limit);
    const minutes = Math.max(10, cards.length * 2);
    let window = null;
    if (cards.length && typeof o.freeSlots === 'function') {
      try { const slots = o.freeSlots(date, minutes) || []; window = slots.length ? { start: slots[0].start, end: slots[0].end, minutes } : null; } catch (e) { window = null; }
    }
    return {
      cards, minutes, window,
      blocked: cards.length > 0 && typeof o.freeSlots === 'function' && !window,
      // Nothing is scheduled over classes; if there is no room the user is told.
      reason: cards.length === 0 ? 'nothing-due' : window ? 'ok' : 'no-window',
    };
  }

  /* ── UI (only when a real DOM exists) ─────────────────────────────── */

  const view = { cardId: null, revealed: false, last: null, message: '' };

  /* S.study is created lazily so the module stays optional and export/import of
     the rest of the state is unaffected until the user actually adds a card. */
  function store() {
    try {
      if (!S.study) S.study = {};
      return normalize(S.study);
    } catch (e) { return normalize({}); }
  }

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function boot() {
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;

    document.addEventListener('click', e => {
      const el = e.target && e.target.closest ? e.target.closest('[data-study]') : null;
      if (!el) return;
      const act = el.dataset.study;
      try {
        if (act === 'reveal') { view.revealed = true; render(); }
        else if (act === 'introduce') { studyIntroduce(el.dataset.id); }
        else if (act === 'rate') { studyGrade(el.dataset.id, el.dataset.rating); }
        else if (act === 'start') { studyStart(); }
        else if (act === 'next') { studyNext(); }
        else if (act === 'delcard') { studyDeleteCard(el.dataset.id); }
      } catch (err) { if (typeof toast === 'function') toast('Не удалось выполнить действие'); }
    });

    document.addEventListener('submit', e => {
      if (!e.target || e.target.id !== 'studyCardForm') return;
      e.preventDefault();
      const form = e.target;
      const deck = form.elements.deck ? form.elements.deck.value : null;
      const front = form.elements.front ? form.elements.front.value : '';
      const back = form.elements.back ? form.elements.back.value : '';
      const res = createCard(store(), deck, front, back, Date.now());
      if (res.error === 'limit') { if (typeof toast === 'function') toast('Достигнут предел ' + MAX_CARDS + ' карточек'); return; }
      if (res.error) { if (typeof toast === 'function') toast('Заполни обе стороны карточки'); return; }
      if (typeof persist === 'function') persist();
      if (typeof render === 'function') render();
      if (typeof toast === 'function') toast('Карточка добавлена');
    });
  }

  function studyIntroduce(id) {
    introduce(store(), id, Date.now());
    view.cardId = id; view.revealed = true;
    if (typeof persist === 'function') persist();
    if (typeof render === 'function') render();
  }

  function studyGrade(id, rating) {
    const res = grade(store(), id, rating, Date.now());
    if (!res) return;
    view.last = { rating, intervalDays: res.intervalDays };
    view.message = res.intervalDays >= 1
      ? 'Следующее повторение через ' + res.intervalDays + ' дн.'
      : (rating === 'again' ? 'Вернётся в этой же сессии' : 'Повторим позже сегодня');
    view.cardId = null; view.revealed = false;
    if (typeof persist === 'function') persist();
    if (typeof render === 'function') render();
    if (typeof toast === 'function') toast(view.message);
  }

  function studyStart() {
    const plan = planSession(store(), typeof today === 'function' ? today() : dayOf(Date.now()), { freeSlots: typeof freeSlots === 'function' ? freeSlots : null });
    if (!plan.cards.length) { if (typeof toast === 'function') toast('На сегодня повторений нет'); return; }
    view.cardId = plan.cards[0].id; view.revealed = false;
    view.message = plan.window ? 'Окно ' + plan.window.start + '–' + plan.window.end : '';
    if (typeof render === 'function') render();
  }

  function studyNext() {
    const due = dueCards(store(), typeof today === 'function' ? today() : dayOf(Date.now()));
    const next = due.find(c => c.id !== view.cardId);
    view.cardId = next ? next.id : null; view.revealed = false;
    if (!next && typeof toast === 'function') toast('Все повторения на сегодня закрыты');
    if (typeof render === 'function') render();
  }

  function studyDeleteCard(id) {
    if (typeof confirm === 'function' && !confirm('Удалить карточку?')) return;
    removeCard(store(), id);
    if (view.cardId === id) { view.cardId = null; view.revealed = false; }
    if (typeof persist === 'function') persist();
    if (typeof render === 'function') render();
  }

  function studyView() {
    // The ts-fsrs bundle (~37 KB) is fetched only when the Study tab is actually opened.
    if (!fsrsApi()) ensureFsrs().then(ok => {
      if (!ok) return;
      try { if (typeof window !== 'undefined' && window.ui && window.ui.moreTab === 'study' && typeof render === 'function') render(); } catch (e) {}
    });
    const st = stats(store(), Date.now());
    const date = typeof today === 'function' ? today() : dayOf(Date.now());
    const due = dueCards(store(), date);
    const plan = planSession(store(), date, { freeSlots: typeof freeSlots === 'function' ? freeSlots : null });
    const head = typeof appHeader === 'function' ? appHeader() : '';
    const active = view.cardId ? cardById(store(), view.cardId) : (due.length ? due[0] : null);

    let html = head + '<div class="today-header"><div class="today-date">Учёба<small>интервальные повторения</small></div></div>';
    html += '<div class="stat-grid">' +
      '<div class="stat-card"><b>' + st.due + '</b><small>К повторению</small></div>' +
      '<div class="stat-card"><b>' + st.total + '</b><small>Карточек</small></div>' +
      '<div class="stat-card"><b>' + st.reviews + '</b><small>Успешных повторений</small></div>' +
      '<div class="stat-card"><b>' + st.lapses + '</b><small>Забыл</small></div>' +
      '</div>';

    html += '<div class="card"><div class="eyebrow">СЕССИЯ</div>';
    if (!active) {
      html += '<p class="tagline">На сегодня повторений нет. Ознакомление считается отдельно от успешного повторения.</p>';
    } else {
      html += '<div class="study-card"><b>' + esc(active.front) + '</b>';
      if (view.revealed) html += '<p class="study-back">' + esc(active.back) + '</p>';
      html += '</div>';
      if (view.revealed) {
        html += '<div class="study-rates">' + RATINGS.map(r =>
          '<button class="btn ' + (r === 'good' ? 'primary' : '') + '" data-study="rate" data-id="' + esc(active.id) + '" data-rating="' + r + '">' + RATING_RU[r] + '</button>'
        ).join('') + '</div>';
      } else {
        html += '<div style="display:flex;gap:6px;margin-top:8px"><button class="btn primary" data-study="introduce" data-id="' + esc(active.id) + '">Покивань ответ</button><button class="btn" data-study="next">Другая карточка</button></div>';
        html += '<p class="tagline">«Покивань ответ» = ознакомление. Оно не засчитывается как успешное повторение.</p>';
      }
      html += '</div>';
    }
    if (view.message) html += '<p class="tagline">' + esc(view.message) + '</p>';
    if (due.length) {
      html += '<div class="card"><div class="eyebrow">ПЛАН НА СЕГОДНЯ</div>';
      if (plan.window) html += '<p class="tagline">Свободное окно: ' + esc(plan.window.start) + '–' + esc(plan.window.end) + ' (' + plan.window.minutes + ' мин). Повторения не ставятся поверх пар и других фиксированных дел.</p>';
      else if (plan.blocked) html += '<p class="quick-warn">Свободного окна до 23:30 нет. Повторения не запланированы, чтобы не накладываться на пары.</p>';
      html += '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px"><button class="btn primary" data-study="start">Начать (' + Math.min(due.length, SESSION_LIMIT) + ')</button></div></div>';
    }

    html += '<div class="card"><div class="eyebrow">НОВАЯ КАРТОЧКА</div><form id="studyCardForm">' +
      '<div class="form-group"><label>Колода</label><select class="field" name="deck">' +
      st.byDeck.map(d => '<option value="' + esc(d.id) + '">' + esc(d.name) + ' · ' + d.total + '</option>').join('') +
      '</select></div>' +
      '<div class="form-group"><label>Вопрос</label><input class="field" name="front" maxlength="300" placeholder="Формула, термин, теорема" required></div>' +
      '<div class="form-group"><label>Ответ</label><textarea class="field" name="back" maxlength="600" rows="2" placeholder="Кратко и по делу" required></textarea></div>' +
      '<button class="btn primary" type="submit" style="margin-top:8px">Добавить</button>' +
      '<p class="tagline">Не более ' + MAX_CARDS + ' карточек и ' + SESSION_LIMIT + ' повторений за сессию.</p></form></div>';

    const withCards = st.byDeck.filter(d => d.total);
    if (withCards.length) {
      html += '<div class="sectiontitle">Колоды</div><div class="card compact">' + withCards.map(d =>
        '<div class="deadline-line"><b>' + esc(d.name) + '</b><small>' + d.total + ' карточек · к повторению ' + d.due + '</small></div>'
      ).join('') + '</div>';
    }

    const saved = store();
    if (saved.cards.length) {
      html += '<div class="sectiontitle">Последние карточки</div><div class="card compact">' + saved.cards.slice(-8).reverse().map(c =>
        '<div class="deadline-line"><b>' + esc(c.front) + '</b><small>до ' + esc(c.due) + ' · повторений ' + (c.reviews || 0) + ' · провалов ' + (c.lapses || 0) + '</small>' +
        '<div style="display:flex;gap:6px;margin-top:4px"><button class="btn tight" data-study="delcard" data-id="' + esc(c.id) + '">Удалить</button></div></div>'
      ).join('') + '</div>';
    }

    html += '<div class="card"><div class="model-hint">Планировщик: ' + (st.engine === 'fsrs' ? 'ts-fsrs (MIT), локально' : 'встроенная простая лестница интервалов (ts-fsrs не загружен)') + '. Всё хранится на устройстве вместе с остальными данными JARVIS.</div></div>';
    return html;
  }

  root.studyView = studyView;
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }

  return {
    VERSION, MAX_CARDS, SESSION_LIMIT, STEPS, RATINGS, RATING_RU,
    normalize, createDeck, createCard, removeCard, cardById, dueCards,
    introduce, grade, stats, planSession, ensureFsrs,
    studyView: () => studyView(),
    _view: view,
  };
});
