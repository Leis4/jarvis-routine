'use strict';
/* Study module (fallback ladder + real ts-fsrs) and activity heatmap.
   Pure modules, no DOM, no network, no paid API calls. */
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const root = path.resolve(__dirname, '..');
const studySrc = fs.readFileSync(path.join(root, 'site', 'study.js'), 'utf8');
const fsrsSrc = fs.readFileSync(path.join(root, 'site', 'vendor', 'fsrs.min.js'), 'utf8');

/* Isolated realm so study.js sees `root.FSRS` exactly like the browser does. */
function loadStudy(withFsrs) {
  const ctx = {
    console, Date, JSON, Math, Promise, Set, Map, Number, String, Boolean, Array, Object,
    RegExp, Error, TypeError, parseInt, parseFloat, isNaN, isFinite,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  if (withFsrs) vm.runInContext(fsrsSrc, ctx, { filename: 'fsrs.min.js', timeout: 10000 });
  vm.runInContext(studySrc, ctx, { filename: 'study.js', timeout: 10000 });
  return ctx.JarvisStudy;
}

/* ── fallback engine (bundle not loaded) ─────────────────────────── */
const Study = loadStudy(false);
assert.equal(Study.stats({}, Date.now()).engine, 'fallback');

const state = {};
Study.normalize(state);
assert.equal(state.decks.length, 1, 'a default deck exists');
assert.equal(state.v, 1, 'schema version recorded');

const NOW = Date.UTC(2026, 10, 16, 9, 0, 0); // 16 Nov 2026
const made = Study.createCard(state, 'd_default', 'Теорема Байеса', 'P(A|B)=P(B|A)P(A)/P(B)', NOW);
assert.ok(made.card, 'card created');
assert.equal(Study.createCard(state, 'd_default', '', 'нет', NOW).error, 'empty', 'both sides required');

/* ознакомление ≠ успешное повторение */
Study.introduce(state, made.card.id, NOW);
assert.equal(made.card.reviews, 0, 'introducing must not count as a successful review');
assert.equal(made.card.state, 'learning');
assert.equal(made.card.introducedAt, NOW);
assert.equal(Study.stats(state, NOW).introduced, 1);

const good = Study.grade(state, made.card.id, 'good', NOW);
assert.equal(good.success, true);
assert.ok(good.intervalDays >= 1, 'a remembered card moves at least one day out');
assert.equal(made.card.reviews, 1, 'a real recall counts once');
assert.equal(made.card.state, 'review');

const again = Study.grade(state, made.card.id, 'again', NOW);
assert.equal(again.success, false);
assert.equal(made.card.lapses, 1);
assert.equal(made.card.step, 0, 'a lapse resets the ladder');
assert.ok(made.card.dueAt - NOW <= 15 * 60000, 'a forgotten card returns within the session');
assert.equal(made.card.reviews, 1, 'a lapse never increases the successful count');
assert.equal(Study.grade(state, made.card.id, 'nonsense', NOW), null, 'unknown ratings are rejected');

/* hard/easy ordering stays monotonic */
const hard = Study.grade(state, made.card.id, 'hard', NOW);
const easy = Study.grade(state, made.card.id, 'easy', NOW);
assert.ok(hard.intervalDays <= easy.intervalDays, 'easy must not be scheduled sooner than hard');

/* card limit — never generate hundreds of cards */
const tiny = { limit: 2 };
Study.normalize(tiny);
Study.createCard(tiny, 'd_default', 'a', 'b', NOW);
Study.createCard(tiny, 'd_default', 'c', 'd', NOW);
assert.equal(Study.createCard(tiny, 'd_default', 'e', 'f', NOW).error, 'limit', 'the card cap is enforced');

/* due queue is ordered and bounded */
const many = { limit: 100 };
Study.normalize(many);
for (let i = 0; i < 30; i++) Study.createCard(many, 'd_default', 'q' + i, 'a' + i, NOW + i * 1000);
assert.equal(Study.dueCards(many, '2026-11-16').length, 30);
const plan = Study.planSession(many, '2026-11-16', { freeSlots: () => [] });
assert.equal(plan.cards.length, Study.SESSION_LIMIT, 'one session stays short');
assert.equal(plan.blocked, true, 'no free window => session reported as blocked, not scheduled over classes');
assert.equal(plan.reason, 'no-window');
const planned = Study.planSession(many, '2026-11-16', { freeSlots: () => [{ start: '18:00', end: '18:40' }] });
assert.deepEqual(planned.window, { start: '18:00', end: '18:40', minutes: planned.minutes });
assert.equal(planned.blocked, false);
assert.equal(Study.planSession({ cards: [], decks: [] }, '2026-11-16', {}).reason, 'nothing-due');

/* ── real ts-fsrs engine ─────────────────────────────────────────── */
const StudyFsrs = loadStudy(true);
const s2 = {};
StudyFsrs.normalize(s2);
assert.equal(StudyFsrs.stats(s2, NOW).engine, 'fsrs', 'the vendored bundle is picked up');
const c2 = StudyFsrs.createCard(s2, 'd_default', 'Кто автор FSRS?', 'Пётр Возняк и соавторы', NOW).card;
StudyFsrs.introduce(s2, c2.id, NOW);
assert.equal(c2.reviews, 0, 'introduction stays out of the success counter with FSRS too');
const g2 = StudyFsrs.grade(s2, c2.id, 'good', NOW);
assert.ok(c2.fsrs && c2.fsrs.stability > 0, 'FSRS memory state is stored on the card');
assert.equal(c2.reviews, 1);
const g3 = StudyFsrs.grade(s2, c2.id, 'good', NOW + 86400000);
assert.ok(g3.intervalDays >= 1, 'a second recall graduates the card to a real interval');
const a2 = StudyFsrs.grade(s2, c2.id, 'again', NOW + 2 * 86400000);
assert.equal(a2.success, false);
assert.equal(c2.lapses, 1);
assert.equal(c2.reviews, 2, 'a lapse with FSRS is not a successful repetition');

/* ── heatmap ─────────────────────────────────────────────────────── */
const HM = require(path.join(root, 'site', 'heatmap.js'));
assert.equal(HM.level(null), 0);
assert.equal(HM.level(0), 0);
assert.equal(HM.level(1), 1);
assert.equal(HM.level(40), 2);
assert.equal(HM.level(70), 3);
assert.equal(HM.level(100), 4);
assert.equal(HM.level(500), 4, 'clamped');

const values = { '2026-11-16': 80, '2026-11-10': 50, '2026-11-11': 0 };
const model = HM.build({ end: '2026-11-16', weeks: 2, valueFor: d => (d in values ? values[d] : null) });
assert.equal(model.weeks.length, 2);
assert.equal(model.weeks[0].start, '2026-11-09');
assert.equal(model.weeks[1].cells[0].date, '2026-11-16');
assert.equal(model.weeks[1].cells[0].level, 3, '80% is level 3');
assert.equal(model.weeks[1].cells[1].future, true, 'days after `end` are marked as future');
assert.equal(model.weeks[1].cells[1].level, -1);
assert.equal(model.average, Math.round((80 + 50 + 0) / 3));
assert.equal(model.tracked, 3);
assert.equal(model.best.date, '2026-11-16');

const html = HM.render(model, { caption: 'выполнение' });
assert.ok(html.includes('class="heatmap"'));
assert.ok(html.includes('hm-cell lvl3'));
assert.ok(html.includes('16.11'));
assert.ok(!/undefined/.test(html), 'no undefined leaked into the markup');
assert.ok(HM.render(HM.build({ end: '2026-11-16', weeks: 1, valueFor: () => null })).includes('Пока нет данных'));

console.log('OK study fallback ladder enforces introduce≠review, caps and free-window planning');
console.log('OK ts-fsrs bundle drives the same card shape and counters');
console.log('OK heatmap levels, future days and rendering are deterministic');
console.log('ALL study + heatmap checks passed');
