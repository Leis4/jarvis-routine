'use strict';
/* "Мои 2–3 цели дня" — pure model regression (no DOM).
   Covers add / remove / reorder / cap / dedupe / sanitisation and the
   per-day store used by the UI layer. */
const assert = require('assert');
const path = require('path');
const G = require(path.join(__dirname, '..', 'site', 'goals.js'));

assert.equal(G.MAX_GOALS, 3);
assert.equal(G.VERSION, '43.2');

/* ── add: cap at 3, dedupe by id, never mutate the input ── */
let list = [];
list = G.addGoal(list, { id: 't1', taskId: 't1', text: 'Код' });
list = G.addGoal(list, { id: 't2', taskId: 't2', text: 'Python' });
list = G.addGoal(list, { id: 'g_a', taskId: null, text: 'Стажировка' });
assert.equal(list.length, 3, 'three goals allowed');
const before = JSON.stringify(list);
list = G.addGoal(list, { id: 't4', taskId: 't4', text: 'Лишнее' });
assert.equal(list.length, 3, 'a fourth goal is refused');
assert.equal(JSON.stringify(list), before, 'the refused add does not mutate the list');
list = G.addGoal(list, { id: 't1', taskId: 't1', text: 'дубль' });
assert.equal(list.length, 3, 'a duplicate id is refused');
console.log('OK goals: capped at 3, deduplicated, input never mutated');

/* ── remove ── */
assert.deepEqual(G.removeGoal(list, 't2').map(g => g.id), ['t1', 'g_a']);
assert.deepEqual(G.removeGoal(list, 'missing').map(g => g.id), ['t1', 't2', 'g_a']);
console.log('OK goals: remove by id, unknown id is a no-op');

/* ── reorder (priority) ── */
assert.deepEqual(G.moveGoal(list, 't2', -1).map(g => g.id), ['t2', 't1', 'g_a'], 'move up');
assert.deepEqual(G.moveGoal(list, 't1', 1).map(g => g.id), ['t2', 't1', 'g_a'], 'move down');
assert.deepEqual(G.moveGoal(list, 't1', -1).map(g => g.id), ['t1', 't2', 'g_a'], 'top cannot move up');
assert.deepEqual(G.moveGoal(list, 'g_a', 1).map(g => g.id), ['t1', 't2', 'g_a'], 'bottom cannot move down');
console.log('OK goals: priority reorder is bounded and stable');

/* ── sanitisation: junk entries, long text, whitespace ── */
const dirty = [null, 42, { id: '' }, { id: 'ok', text: '  a   b  ' }, { id: 'ok', text: 'dup' }, { id: 'big', text: 'x'.repeat(500) }];
const clean = G.cleanList(dirty);
assert.deepEqual(clean.map(g => g.id), ['ok', 'big']);
assert.equal(clean[0].text, 'a b', 'internal whitespace collapsed');
assert.equal(clean[1].text.length, 80, 'text truncated to 80 chars');
assert.equal(clean[0].taskId, null, 'missing taskId normalised to null');
assert.deepEqual(G.cleanList(null), [], 'null list is empty');
assert.deepEqual(G.cleanList('nope'), [], 'non-array is empty');
console.log('OK goals: junk rejected, text sanitised, cap enforced on read');

/* ── per-day store via the S global ── */
global.S = {};
G.setGoalsFor('2026-11-16', [{ id: 't1', taskId: 't1', text: 'Код' }]);
assert.deepEqual(G.goalsFor('2026-11-16').map(g => g.id), ['t1']);
assert.deepEqual(G.goalsFor('2026-11-17'), [], 'a different day has its own goals');
assert.deepEqual(global.S.goals['2026-11-16'].map(g => g.id), ['t1'], 'stored under S.goals[date]');
/* a malformed stored value must not throw */
global.S.goals['2026-11-18'] = 'broken';
assert.deepEqual(G.goalsFor('2026-11-18'), [], 'malformed stored value yields an empty list');
console.log('OK goals: per-day store is isolated and defensive');

console.log('ALL goals model checks passed');
