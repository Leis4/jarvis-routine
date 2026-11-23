/* JARVIS v43.4 — P0-C: user state preservation on iPhone WebKit.
   The risk is not the 392/13 constants (covered elsewhere) but the newer,
   editable state: completion marks, custom habits, the archive, day goals and
   the flexible-schedule policy. This locks that they survive a reload, an
   offline reload, a flexible Undo, and a backup export -> import round-trip. */
import { test, expect } from '@playwright/test';
import { seedScheduleTemplate } from './lib/seed-template.cjs';
import fs from 'fs';
import os from 'os';
import path from 'path';

async function boot(page) {
  await seedScheduleTemplate(page);
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector('#app', { timeout: 10000 });
  await page.waitForTimeout(400);
}

async function seedState(page) {
  await page.evaluate(() => {
    const t = today();
    S.anchor = { monday: monday(t), parity: 0 };
    ui.date = t; ui.tab = 'today';
    S.done = { ...(S.done || {}), [t + '::seedTask']: true };
    S.habits = { ...(S.habits || {}), [t]: { seedHabit: true } };
    S.goals = { ...(S.goals || {}), [t]: [{ id: 'seed-goal', text: 'Цель P0-C' }] };
    S.customHabits = [
      { id: 'seed-custom', name: 'Полить цветы', icon: '🌱', created: t, archived: false },
      { id: 'seed-arch', name: 'Старая привычка', icon: '🗄', created: t, archived: true },
    ];
    S.flex = { ...(S.flex || {}), mode: 'on', policy: { ...((S.flex || {}).policy || {}), exam: { date: '2026-11-24' } } };
    persist(); render();
  });
  await page.waitForTimeout(200);
}

const read = page => page.evaluate(() => {
  const t = today();
  return {
    date: t,
    done: !!(S.done && S.done[t + '::seedTask']),
    habit: !!(S.habits && S.habits[t] && S.habits[t].seedHabit),
    goal: !!(S.goals && S.goals[t] && S.goals[t].some(g => g.id === 'seed-goal')),
    custom: !!(S.customHabits || []).some(h => h.id === 'seed-custom' && !h.archived),
    archived: !!(S.customHabits || []).some(h => h.id === 'seed-arch' && h.archived),
    flexMode: !!(S.flex && S.flex.mode === 'on'),
    flexExam: !!(S.flex && S.flex.policy && S.flex.policy.exam && S.flex.policy.exam.date === '2026-11-24'),
  };
});

const KEYS = ['done', 'habit', 'goal', 'custom', 'archived', 'flexMode', 'flexExam'];
function expectAll(s) { for (const k of KEYS) expect(s && s[k], k + ' must be preserved').toBe(true); }

test.describe('P0 state preservation (iPhone WebKit)', () => {
  test('marks, goals, archived habits and flex policy survive reload and export->import', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

    await boot(page);
    await seedState(page);
    expectAll(await read(page));

    /* reload */
    await page.reload();
    await page.waitForSelector('#app');
    await page.waitForTimeout(400);
    expectAll(await read(page));

    /* export the real backup and inspect every newer field */
    await page.evaluate(() => { ui.tab = 'more'; ui.moreTab = 'settings'; render(); });
    await page.waitForTimeout(250);
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-action="export"]')]);
    const file = path.join(os.tmpdir(), 'jarvis-p0c-' + Date.now() + '.json');
    await download.saveAs(file);
    const dump = JSON.parse(fs.readFileSync(file, 'utf8'));
    const t = await page.evaluate(() => today());
    expect(dump.habits[t]).toEqual({ seedHabit: true });
    expect(dump.goals[t].some(g => g.id === 'seed-goal')).toBe(true);
    expect(dump.customHabits.some(h => h.id === 'seed-arch' && h.archived)).toBe(true);
    expect(dump.flex.mode).toBe('on');
    expect(dump.flex.policy.exam.date).toBe('2026-11-24');

    /* wipe the editable state, then restore through the real UI */
    await page.evaluate(() => { S.done = {}; S.habits = {}; S.goals = {}; S.customHabits = []; S.flex = { mode: 'off', policy: null }; persist(); render(); });
    await page.waitForTimeout(150);
    expect((await read(page)).goal).toBe(false);

    page.once('dialog', d => d.accept());
    await page.setInputFiles('#importFile', file);
    await page.waitForTimeout(800);
    expectAll(await read(page));
    expect(errors).toEqual([]);
    fs.unlinkSync(file);
    page.removeAllListeners();
  });

  test('the flexible Undo restores the previous state and leaves user marks intact', async ({ page }) => {
    await boot(page);
    await seedState(page);
    const res = await page.evaluate(() => {
      const s = today();
      const f = JarvisFlex.state();
      const priorEnergy = f.energy;
      f.preview = { kind: 'energy', energy: { key: 'low' }, changes: [] };
      const applied = JarvisFlex.applyPreview();
      const energyAfterApply = JarvisFlex.state().energy;
      const undone = JarvisFlex.undo(s);
      return { applied, energyAfterApply, undone, priorEnergy, energyAfterUndo: JarvisFlex.state().energy };
    });
    expect(res.applied.ok).toBe(true);
    expect(res.energyAfterApply).toBe('low');
    expect(res.undone).toBe(true);
    expect(res.energyAfterUndo).toBe(res.priorEnergy);
    expectAll(await read(page));
  });

  test('state survives an offline reload from the service-worker cache', async ({ page }) => {
    test.slow();
    await boot(page);
    await seedState(page);

    /* wait (bounded) for the service worker shell to be cached for real */
    await page.evaluate(async () => {
      try {
        if (!('serviceWorker' in navigator)) return;
        await Promise.race([navigator.serviceWorker.ready, new Promise(r => setTimeout(r, 10000))]);
        if (!navigator.serviceWorker.controller) {
          await Promise.race([
            new Promise(r => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true })),
            new Promise(r => setTimeout(r, 4000)),
          ]);
        }
        const shellCached = async () => {
          const names = await caches.keys();
          for (const n of names) {
            if (!n.startsWith('jarvis-routine-')) continue;
            const c = await caches.open(n);
            if ((await c.keys()).length > 5) return true;
          }
          return false;
        };
        for (let i = 0; i < 12 && !(await shellCached()); i++) await new Promise(r => setTimeout(r, 400));
      } catch (e) {}
    });
    await page.waitForTimeout(300);

    await page.context().setOffline(true);
    let ok = false;
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {
      try {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 12000 });
        await page.waitForSelector('#app', { timeout: 10000 });
        await page.waitForTimeout(300);
        ok = await page.evaluate(() => document.querySelector('#app').innerText.length > 50);
      } catch (e) { ok = false; }
    }
    const state = ok ? await read(page) : null;
    await page.context().setOffline(false);
    expect(ok).toBe(true);
    expectAll(state);
  });
});
